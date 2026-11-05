import { useStore } from './store'

/** "a/./b/../c" → "a/c" (keeps a leading "/") */
function normalize(p: string): string {
  const abs = p.startsWith('/')
  const out: string[] = []
  for (const part of p.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return (abs ? '/' : '') + out.join('/')
}

/** path + line from the many ways agents and docs write file links */
export function parseFileHref(href: string): { path: string; line?: number } | null {
  let h = href.trim()
  if (!h || h.startsWith('#') || /^(https?|mailto|data|javascript):/i.test(h)) return null
  h = h.replace(/^vscode:\/\/file/i, '').replace(/^file:\/\//i, '')
  try {
    h = decodeURIComponent(h)
  } catch {
    /* keep as is */
  }
  let line: number | undefined
  const hash = h.match(/#L(\d+)(?:C\d+)?(?:-L?\d+)?$/i)
  if (hash) {
    line = Number(hash[1])
    h = h.slice(0, hash.index)
  }
  h = h.replace(/[?#].*$/, '')
  const colon = h.match(/:(\d+)(?::\d+)?$/)
  if (colon) {
    line = line ?? Number(colon[1])
    h = h.slice(0, colon.index)
  }
  if (h.startsWith('~/')) return null // home paths need the main process; rare in links
  return h ? { path: h, line } : null
}

/**
 * Open a link from a chat / markdown doc:
 * web links in the browser, files and folders in Hive's editor (inside `root` or another project),
 * anything else on disk with its default app.
 * `dir` is the folder of the document the link is in (relative to `root`).
 */
export async function openHref(href: string, root: string, dir = ''): Promise<void> {
  const { toast, openCode, app } = useStore.getState()
  if (/^(https?:|mailto:)/i.test(href.trim())) {
    window.open(href.trim())
    return
  }
  const f = parseFileHref(href)
  if (!f) return
  const r = root.replace(/\/+$/, '')
  // agents also work outside their folder: in linked folders, or in a sibling repo they write
  // relative to the parent ("EPA/hgs/x.php" for ~/dev/EPA/… while working in ~/dev/hgs.core)
  const owner = app.projects.find((p) => p.path.replace(/\/+$/, '') === r || app.agents.some((x) => x.projectId === p.id && x.worktreePath?.replace(/\/+$/, '') === r))
  const bases = [r, owner?.path, ...(owner?.folders ?? [])].filter((x): x is string => !!x).map((x) => x.replace(/\/+$/, ''))
  const ups = bases.flatMap((b) => [1, 2, 3].map((n) => b.split('/').slice(0, -n).join('/')).filter((x) => x.split('/').length > 3))
  const candidates = f.path.startsWith('/')
    ? [f.path, `${r}${f.path}`] // absolute, or relative to the repo root (GitHub style "/docs/x.md")
    : [`${r}/${dir ? `${dir}/` : ''}${f.path}`, ...[...bases, ...ups].map((b) => `${b}/${f.path}`)]
  const hit = await window.api.fs.firstExisting([...new Set(candidates.map(normalize))]).catch(() => null)
  if (!hit) {
    toast(`Not found: ${f.path}`, 'error')
    return
  }
  // folders the editor can show: the current project and its agents' worktrees (others open with their default app)
  const { selectedProjectId } = useStore.getState()
  const proj = app.projects.find((p) => p.id === selectedProjectId)
  const editable = [proj?.path, ...app.agents.filter((x) => x.projectId === proj?.id && x.worktreePath).map((x) => x.worktreePath)]
    .filter((x): x is string => !!x)
    .map((x) => x.replace(/\/+$/, ''))
  const roots = [...new Set([r, ...editable])].filter((x) => x && editable.includes(x))
  const base = roots.find((x) => hit.path === x || hit.path.startsWith(`${x}/`))
  if (base) return openCode(base, hit.path === base ? undefined : hit.path.slice(base.length + 1), f.line)
  // found in a linked folder or a sibling repo: open it in the editor with that folder as root
  // (linked folder itself, or the top folder the relative path names – ~/dev/EPA for "EPA/hgs/x.php")
  const linked = (owner?.folders ?? []).map((x) => x.replace(/\/+$/, '')).find((x) => hit.path.startsWith(`${x}/`))
  const up = !f.path.startsWith('/') && !hit.dir ? ups.find((b) => hit.path === normalize(`${b}/${f.path}`)) : undefined
  const top = linked ?? (up && f.path.includes('/') ? `${up}/${normalize(f.path).split('/')[0]}` : undefined)
  if (top && hit.path.startsWith(`${top}/`)) openCode(top, hit.path.slice(top.length + 1), f.line)
  else void window.api.openPath(hit.path)
}

/** inline `code` that looks like a file path (src/app.ts, ./docs/x.md:12) – made clickable in chats */
export const PATH_RE = /^(?:\.{0,2}\/)?(?:[\w@.-]+\/)*[\w@.-]+\.[A-Za-z0-9]{1,8}(?::\d+(?::\d+)?)?$/

/** marks <code>path</code> in rendered html so it can be clicked */
export function markPaths(html: string): string {
  return html.replace(/<code>([^<]{3,200})<\/code>/g, (m, t: string) => (PATH_RE.test(t) && !/^\d/.test(t) ? `<code class="md-path">${t}</code>` : m))
}

/** onClick for a container of rendered markdown: links and marked paths open, the rest is untouched */
export function linkClick(e: React.MouseEvent, root: string | (() => string), dir = ''): void {
  const el = e.target as HTMLElement
  const a = el.closest('a')
  const code = el.closest('code.md-path')
  if (!a && !code) return
  const href = a ? a.getAttribute('href') ?? '' : code!.textContent ?? ''
  if (a && href.startsWith('#')) return
  e.preventDefault()
  e.stopPropagation()
  void openHref(href, typeof root === 'function' ? root() : root, dir)
}

/** folder an agent works in (its worktree or its project) */
export function agentRoot(agentId: string): string {
  const { app } = useStore.getState()
  const a = app.agents.find((x) => x.id === agentId)
  return a?.worktreePath ?? app.projects.find((p) => p.id === a?.projectId)?.path ?? ''
}
