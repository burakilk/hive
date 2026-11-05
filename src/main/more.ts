/**
 * Accounts & sign-in, automatic account / provider switching on usage limits,
 * Figma frames, tracker imports (Linear, Jira, Notion, Azure DevOps), cloning repos,
 * SKILL.md export / import and restoring the last session on launch.
 */
import { app, dialog, ipcMain, Notification } from 'electron'
import { execFile } from 'child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { basename, dirname, join, relative } from 'path'
import { randomUUID } from 'crypto'
import type { Account, Agent, DevServer, Project, Skill, Task } from '@shared/types'
import { getState, updateState } from './store'
import type { FeatureCtx } from './features'
import { secretEnv } from './insights'
import { saveImage } from './media'
import { findSessions } from './otherclis'
import { showQaBrowser } from './browser'
import { seedNewProject } from './projectTeam'
import { currentSession } from './transcript'

const shellRun = (cmd: string, cwd?: string, timeout = 300_000): Promise<string> =>
  new Promise((resolve, reject) =>
    execFile(process.env.SHELL || '/bin/zsh', ['-l', '-i', '-c', cmd], { cwd, timeout, maxBuffer: 32 * 1024 * 1024 }, (err, out, errOut) =>
      err ? reject(new Error(String(errOut || err.message).trim().split('\n').slice(-3).join(' '))) : resolve(out)
    )
  )
const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

// ---------------- accounts ----------------
export const accountDir = (a: Account): string => a.configDir || join(app.getPath('userData'), 'accounts', a.id)
/** Environment that points a CLI at an account's own config folder. */
/**
 * Create an account's config folder and share your normal setup with it: Claude's CLAUDE.md,
 * settings, agents, commands, skills and plugins (Codex: config.toml, AGENTS.md, prompts) are
 * linked from ~/.claude (~/.codex), so only the login differs between accounts.
 */
export function ensureAccountDir(acc: Account): string {
  const dir = accountDir(acc)
  mkdirSync(dir, { recursive: true })
  const base = acc.providerId === 'claude' ? process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude') : process.env.CODEX_HOME || join(homedir(), '.codex')
  const shared = acc.providerId === 'claude' ? ['CLAUDE.md', 'settings.json', 'agents', 'commands', 'skills', 'plugins', 'output-styles', 'hooks'] : ['config.toml', 'AGENTS.md', 'prompts', 'skills']
  if (acc.configDir || base === dir) return dir
  for (const name of shared) {
    const from = join(base, name)
    const to = join(dir, name)
    try {
      if (existsSync(from) && !existsSync(to)) symlinkSync(from, to)
    } catch (e) {
      console.warn('[accounts] could not link', name, e)
    }
  }
  return dir
}
/** agent's own choice → project default → Hive-wide default ('' / '__main' = your normal login) */
export function resolveAccountId(agent: Agent): string | undefined {
  if (agent.accountId !== undefined) return agent.accountId || undefined
  const proj = getState().projectSettings[agent.projectId]?.accounts?.[agent.providerId]
  if (proj === '__main') return undefined
  if (proj) return proj
  return getState().settings.defaultAccounts?.[agent.providerId] || undefined
}
export function accountEnv(agent: Agent): Record<string, string> {
  const id = resolveAccountId(agent)
  const acc = getState().settings.accounts.find((a) => a.id === id)
  if (!acc || acc.providerId !== agent.providerId) return {}
  const dir = ensureAccountDir(acc)
  if (acc.providerId === 'claude') return { CLAUDE_CONFIG_DIR: dir }
  if (acc.providerId === 'codex') return { CODEX_HOME: dir }
  return {}
}
const claudeHome = (a?: Account): string => (a ? accountDir(a) : process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'))
const codexHome = (a?: Account): string => (a ? accountDir(a) : process.env.CODEX_HOME || join(homedir(), '.codex'))
function signinStatus(providerId: string, acc?: Account): string {
  if (providerId === 'claude') {
    const dir = claudeHome(acc)
    // an extra account only counts its own folder; your normal login also has ~/.claude.json
    const cfg = [join(dir, '.claude.json'), ...(acc ? [] : [join(homedir(), '.claude.json')])].find(existsSync)
    try {
      const j = cfg ? JSON.parse(readFileSync(cfg, 'utf8')) : null
      const email = j?.oauthAccount?.emailAddress
      return email ? `Signed in as ${email}` : existsSync(join(dir, '.credentials.json')) ? 'Signed in' : acc ? 'Not signed in' : 'Not signed in (or uses the macOS keychain)'
    } catch {
      return 'Unknown'
    }
  }
  if (providerId === 'codex') return existsSync(join(codexHome(acc), 'auth.json')) ? 'Signed in' : 'Not signed in'
  return existsSync(join(homedir(), '.gemini', 'oauth_creds.json')) || existsSync(join(homedir(), '.gemini', 'google_accounts.json')) ? 'Signed in' : 'Not signed in'
}

const LOGIN: Record<string, string> = { claude: 'claude', codex: 'codex login', gemini: 'gemini' }

// ---------------- usage-limit detection ----------------
const APPROACH_RE = /approaching (?:\w+ )?(?:usage )?limit|(?:8|9)\d% of your (?:\w+ )?limit/i
const LIMIT_RE = /usage limit (reached|exceeded)|you['’]ve hit your usage limit|5-hour limit reached|weekly limit reached|rate limit exceeded.*(retry|try again) (later|in)|quota exceeded|RESOURCE_EXHAUSTED/i

export function registerMore(ctx: FeatureCtx): { onData: (agentId: string, data: string) => void; recordRunning: () => void; restore: () => void } {
  const save = (fn: Parameters<typeof updateState>[0]): void => {
    updateState(fn)
    ctx.broadcastState()
  }
  const notify = (title: string, body: string, agentId?: string): void => {
    if (!Notification.isSupported()) return
    const n = new Notification({ title, body, silent: getState().settings.notify.silent })
    n.on('click', () => {
      ctx.win()?.show()
      if (agentId) ctx.send('agent:focus', agentId)
    })
    n.show()
  }

  // ---------- slash commands for the composer's "/" menu ----------
  /** custom commands, skills and prompts the agent's CLI offers (built-ins live in the renderer) */
  ipcMain.handle('agent:slashCommands', (_e, agentId: string): { name: string; desc: string; source: string }[] => {
    const a = getState().agents.find((x) => x.id === agentId)
    if (!a) return []
    const out: { name: string; desc: string; source: string }[] = []
    const describe = (file: string): string => {
      try {
        const t = readFileSync(file, 'utf8').slice(0, 4000)
        const fm = t.match(/^---\n([\s\S]*?)\n---/)
        const d = fm?.[1].match(/^description:\s*(.+)$/m)?.[1]
        if (d) return d.trim().replace(/^["']|["']$/g, '').slice(0, 160)
        const body = fm ? t.slice(fm[0].length) : t
        return (body.split('\n').map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean) ?? '').slice(0, 160)
      } catch {
        return ''
      }
    }
    // .claude/commands/foo/bar.md → /foo:bar
    const commands = (dir: string, source: string, prefix = '', depth = 0): void => {
      if (depth > 3 || !existsSync(dir)) return
      for (const f of readdirSync(dir, { withFileTypes: true })) {
        if (f.isDirectory()) commands(join(dir, f.name), source, `${prefix}${f.name}:`, depth + 1)
        else if (f.name.endsWith('.md')) out.push({ name: prefix + f.name.slice(0, -3), desc: describe(join(dir, f.name)), source })
      }
    }
    const skills = (dir: string, source: string): void => {
      if (!existsSync(dir)) return
      for (const f of readdirSync(dir, { withFileTypes: true })) {
        const md = join(dir, f.name, 'SKILL.md')
        if (f.isDirectory() && existsSync(md)) out.push({ name: f.name, desc: describe(md), source })
      }
    }
    try {
      const cwd = ctx.agentCwd(a)
      if (a.providerId === 'claude') {
        commands(join(cwd, '.claude', 'commands'), 'project')
        commands(join(claudeHome(), 'commands'), 'personal')
        skills(join(cwd, '.claude', 'skills'), 'project skill')
        skills(join(claudeHome(), 'skills'), 'skill')
      } else if (a.providerId === 'codex') {
        const dir = join(codexHome(), 'prompts')
        if (existsSync(dir)) for (const f of readdirSync(dir)) if (f.endsWith('.md')) out.push({ name: `prompts:${f.slice(0, -3)}`, desc: describe(join(dir, f)), source: 'prompt' })
      } else if (a.providerId === 'gemini') {
        for (const [dir, source] of [[join(cwd, '.gemini', 'commands'), 'project'], [join(homedir(), '.gemini', 'commands'), 'personal']] as const) {
          if (!existsSync(dir)) continue
          for (const f of readdirSync(dir)) if (f.endsWith('.toml')) {
            const t = readFileSync(join(dir, f), 'utf8')
            out.push({ name: f.slice(0, -5), desc: t.match(/^description\s*=\s*"(.*)"/m)?.[1] ?? '', source })
          }
        }
      }
    } catch (e) {
      console.warn('[slash] could not list commands', e)
    }
    const seen = new Set<string>()
    return out.filter((c) => !seen.has(c.name) && seen.add(c.name))
  })

  // ---------- accounts & sign-in ----------
  ipcMain.handle('accounts:save', (_e, list: Account[]) => save((s) => (s.settings.accounts = list)))
  ipcMain.handle('accounts:signin', (_e, providerId: string, accountId?: string) => {
    const acc = getState().settings.accounts.find((a) => a.id === accountId)
    const env: Record<string, string> = { HIVE_OPEN_BROWSER: '1' }
    if (acc?.providerId === 'claude') env.CLAUDE_CONFIG_DIR = ensureAccountDir(acc)
    if (acc?.providerId === 'codex') env.CODEX_HOME = ensureAccountDir(acc)
    const cli = getState().providers.find((p) => p.id === providerId)?.command.split(' ')[0] || providerId
    // Claude: a fresh config folder starts with onboarding (which includes the login);
    // an already set-up one gets /login typed in once the CLI is ready
    const onboarded = providerId === 'claude' && existsSync(join(claudeHome(acc), '.claude.json')) && (acc ? true : existsSync(join(homedir(), '.claude.json')))
    const cmd = providerId === 'codex' ? `${cli} login` : cli || LOGIN[providerId]
    const id = `signin-${providerId}-${accountId ?? 'default'}`
    const srv: DevServer = { id, projectId: '', name: `Sign in · ${providerId}`, command: cmd, cwd: '' }
    ctx.servers.stop(id)
    setTimeout(() => {
      ctx.servers.start(srv, homedir(), env)
      if (onboarded)
        setTimeout(() => {
          ctx.servers.write(id, '/login')
          setTimeout(() => ctx.servers.write(id, '\r'), 200)
        }, 3500)
    }, 300)
    return id
  })
  ipcMain.handle('accounts:status', async (_e, providerId: string, accountId?: string) =>
    signinStatus(providerId, getState().settings.accounts.find((a) => a.id === accountId))
  )

  // ---------- CLI doctor ----------
  const HINTS: [RegExp, string][] = [
    [/command not found|not recognized as|No such file or directory/i, 'The CLI is not on the PATH of your login shell. Install it, or put the full path in Settings → Agents & CLIs → Command.'],
    [/EACCES|permission denied/i, 'Permission problem – check the file permissions of the CLI or the project folder.'],
    [/not logged in|please log ?in|unauthori[sz]ed|401|invalid api key|authentication/i, 'Not signed in – use Sign in in Settings → Agents & CLIs.'],
    [/usage limit|rate limit|quota|429/i, 'The account hit its usage limit – wait for the reset or add another account (auto switch).'],
    [/Unsupported engine|requires node|node: bad option|SyntaxError: Unexpected token/i, 'Your Node.js is too old for this CLI – update Node (e.g. nvm install --lts).'],
    [/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network|proxy/i, 'Network problem – check your connection, VPN or proxy settings.'],
    [/Folder not found/i, 'The project folder (or worktree) is gone – re-add the project or turn off worktree isolation.'],
    [/mcp_servers|missing field `command`|unknown field `url`/i, 'This Codex version does not accept the MCP servers Hive passes – update Codex, or turn off “MCP servers for Codex” in Settings → Agents & CLIs.'],
    [/unknown option|unexpected argument|error: unrecognized/i, 'The CLI does not know one of the flags Hive passes – update the CLI (model / effort / --add-dir need recent versions).']
  ]
  const which = async (bin: string): Promise<string | null> => {
    try {
      return (await shellRun(`command -v ${bin}`, undefined, 15_000)).trim().split('\n').pop() || null
    } catch {
      return null
    }
  }
  const version = async (cmd: string): Promise<string> => {
    try {
      return (await shellRun(`${cmd} --version 2>&1 | head -1`, undefined, 15_000)).replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/[\x00-\x1f]/g, '').trim().slice(0, 80)
    } catch {
      return ''
    }
  }
  ipcMain.handle('doctor:run', async () => {
    const st = getState()
    const clis = await Promise.all(
      st.providers.filter((p) => p.command.trim()).map(async (p) => {
        const bin = p.command.trim().split(/\s+/)[0]
        const path = await which(bin)
        const ver = path ? await version(bin) : ''
        const signin = path && ['claude', 'codex', 'gemini'].includes(p.id) ? signinStatus(p.id) : ''
        return { id: p.id, name: p.name, command: p.command, path, version: ver, signin }
      })
    )
    const TOOLS: [string, string][] = [['git', 'Worktrees, diffs and commits'], ['node', 'Needed by most agent CLIs'], ['gh', 'GitHub issues, repo list and clone'], ['glab', 'GitLab repo list'], ['cloudflared', 'Public preview / webhook tunnels'], ['ssh', 'Remote agents'], ['psql', 'PostgreSQL connections'], ['mysql', 'MySQL connections'], ['mongosh', 'MongoDB connections']]
    const tools = await Promise.all(TOOLS.map(async ([bin, why]) => ({ bin, why, path: await which(bin) })))
    const failures = st.agents
      .map((a) => ({ a, rt: ctx.agents.runtime(a.id) }))
      .filter(({ rt }) => rt.status === 'error' || (!rt.running && rt.exitReason))
      .map(({ a, rt }) => {
        const screen = ctx.agents.screenLines(a.id, 40).join('\n')
        const text = `${rt.exitReason ?? ''}\n${screen}`
        return { agentId: a.id, name: a.name, reason: rt.exitReason ?? '', tail: screen.trim().split('\n').slice(-6).join('\n'), hints: HINTS.filter(([re]) => re.test(text)).map(([, h]) => h) }
      })
    return { clis, tools, failures, shell: process.env.SHELL || '/bin/zsh' }
  })

  // ---------- auto switch on usage limits ----------
  const lastLimit = new Map<string, number>()
  async function switchAccount(agentId: string): Promise<void> {
    const a = getState().agents.find((x) => x.id === agentId)
    const st = getState().settings
    if (!a || !st.autoSwitch) return
    const pool: (Account | undefined)[] = [undefined, ...st.accounts.filter((x) => x.providerId === a.providerId)]
    const cur = resolveAccountId(a)
    const i = pool.findIndex((x) => (x?.id ?? undefined) === cur)
    const next = pool.length > 1 ? pool[(i + 1) % pool.length] : null
    const last = currentSession(a.sessions)
    if (next !== null && next?.id !== cur) {
      // carry the conversation over to the other account's config folder
      let resumeArgs: string | undefined
      if (last && existsSync(last)) {
        if (a.providerId === 'claude') {
          const sid = basename(last, '.jsonl')
          const dir = join(claudeHome(next), 'projects', ctx.agentCwd(a).replace(/[^a-zA-Z0-9]/g, '-'))
          mkdirSync(dir, { recursive: true })
          copyFileSync(last, join(dir, `${sid}.jsonl`))
          resumeArgs = `--resume ${sid}`
        } else if (a.providerId === 'codex') {
          const from = codexHome(pool[i] ?? undefined)
          const rel = relative(from, last)
          const to = join(codexHome(next), rel.startsWith('..') ? join('sessions', basename(last)) : rel)
          mkdirSync(dirname(to), { recursive: true })
          copyFileSync(last, to)
          const id = basename(last).match(/([0-9a-f-]{36})\.jsonl$/)?.[1]
          resumeArgs = id ? `resume ${id}` : undefined
        }
      }
      save((s) => {
        const x = s.agents.find((y) => y.id === agentId)
        if (x) x.accountId = next?.id ?? '' // '' = your normal login (overrides the project default)
      })
      notify(`🔁 ${a.name}: switched account`, `Usage limit reached – continuing on ${next?.name ?? 'your default account'}.`, a.id)
      ctx.agents.restart(agentId, () => ctx.startAgent(agentId, false, resumeArgs ? undefined : 'Continue where you left off.', resumeArgs))
      return
    }
    // no other account: optional fallback provider
    if (st.fallbackProvider && st.fallbackProvider !== a.providerId) {
      const conv = last ? (await import('./transcript')).readConversation(last) : null
      const items = (await conv)?.items ?? []
      const task = [...items].reverse().find((x) => x.kind === 'user')?.text ?? ''
      const recap = [...items].reverse().find((x) => x.kind === 'assistant')?.text ?? ''
      save((s) => {
        const x = s.agents.find((y) => y.id === agentId)
        if (x) {
          x.providerId = st.fallbackProvider!
          delete x.accountId
        }
      })
      notify(`🔁 ${a.name}: switched to ${st.fallbackProvider}`, 'Usage limit reached – the task continues with the fallback CLI.', a.id)
      ctx.agents.restart(agentId, () =>
        ctx.startAgent(agentId, false, `[Taking over from another AI because of a usage limit]\nTask: ${task.slice(0, 3000)}\n\nLast progress report:\n${recap.slice(0, 3000)}\n\nCheck the current state of the files and continue.`)
      )
    }
  }

  ipcMain.handle('qa:show', (_e, agentId: string) => showQaBrowser(agentId))

  // ---------- sessions started in a terminal (outside Hive) ----------
  const firstUserText = (path: string, kind: 'claude' | 'codex'): string => {
    try {
      const fd = readFileSync(path, 'utf8').slice(0, 400_000)
      for (const line of fd.split('\n')) {
        if (!line.trim()) continue
        const j = JSON.parse(line)
        if (kind === 'claude' && j.type === 'user' && !j.isMeta) {
          const c = j.message?.content
          const t = typeof c === 'string' ? c : Array.isArray(c) ? c.map((b: { text?: string }) => b.text ?? '').join(' ') : ''
          if (t.trim() && !t.startsWith('<') && !t.startsWith('Caveat:')) return t.trim().slice(0, 160)
        }
        if (kind === 'codex' && j.type === 'response_item' && j.payload?.type === 'message' && j.payload.role === 'user') {
          const t = (j.payload.content ?? []).map((b: { text?: string }) => b.text ?? '').join(' ').trim()
          if (t && !t.startsWith('<')) return t.slice(0, 160)
        }
      }
    } catch {
      /* unreadable */
    }
    return ''
  }
  ipcMain.handle('sessions:external', (_e, projectId: string) => {
    const p = ctx.findProject(projectId)
    const known = new Set(getState().agents.flatMap((a) => a.sessions ?? []))
    const out: { path: string; kind: 'claude' | 'codex'; at: number; size: number; title: string }[] = []
    const cdir = join(claudeHome(), 'projects', p.path.replace(/[^a-zA-Z0-9]/g, '-'))
    if (existsSync(cdir))
      for (const f of readdirSync(cdir)) {
        if (!f.endsWith('.jsonl')) continue
        const path = join(cdir, f)
        if (known.has(path)) continue
        const st = statSync(path)
        if (st.size < 200) continue
        out.push({ path, kind: 'claude', at: st.mtimeMs, size: st.size, title: firstUserText(path, 'claude') })
      }
    for (const path of findSessions('codex', p.path, Date.now() - 30 * 86400000)) {
      if (known.has(path)) continue
      const st = statSync(path)
      out.push({ path, kind: 'codex', at: st.mtimeMs, size: st.size, title: firstUserText(path, 'codex') })
    }
    return out.filter((x) => x.title).sort((a, b) => b.at - a.at).slice(0, 60)
  })
  ipcMain.handle('sessions:adopt', (_e, projectId: string, path: string, kind: 'claude' | 'codex', name?: string) => {
    const roles = getState().roles
    const color = ['#f97316', '#22c55e', '#3b82f6', '#a855f7', '#ec4899', '#eab308'][getState().agents.length % 6]
    const agent: Agent = {
      id: randomUUID(), projectId, name: name?.trim() || `Imported ${kind === 'claude' ? 'Claude' : 'Codex'}`, role: roles[0]?.name ?? 'General',
      color, providerId: kind, sessions: [path], createdAt: Date.now()
    }
    save((s) => s.agents.push(agent))
    const sid = basename(path).replace(/\.jsonl$/, '')
    const uuid = sid.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0] ?? sid
    ctx.startAgent(agent.id, false, undefined, kind === 'claude' ? `--resume ${sid}` : `resume ${uuid}`)
    return agent.id
  })

  // ---------- memory <-> folder sync (e.g. an Obsidian vault) ----------
  const synced = new Map<string, string>() // projectId -> content at last sync
  const syncMemory = (): void => {
    const st = getState()
    for (const p of st.projects) {
      const dir = st.projectSettings[p.id]?.memorySync?.trim().replace(/^~(?=\/|$)/, homedir())
      if (!dir || !existsSync(dir)) continue
      const file = join(dir, `Hive Memory – ${p.name.replace(/[\\/:*?"<>|]/g, '-')}.md`)
      const mem = st.memory[p.id] ?? ''
      const disk = existsSync(file) ? readFileSync(file, 'utf8') : null
      const last = synced.get(p.id)
      try {
        if (last === undefined && disk !== null && disk.trim() && mem.trim() && disk !== mem) {
          // first sync with text on both sides: keep both
          const merged = `${mem.trim()}\n\n${disk.trim()}\n`
          writeFileSync(file, merged)
          save((s) => (s.memory[p.id] = merged))
          synced.set(p.id, merged)
        } else if (disk === null || (last !== undefined && mem !== last && disk === last)) {
          writeFileSync(file, mem) // Hive side changed (or first sync)
          synced.set(p.id, mem)
        } else if (disk !== mem && (last === undefined ? !mem.trim() : disk !== last)) {
          save((s) => (s.memory[p.id] = disk)) // edited in the vault
          synced.set(p.id, disk)
        } else synced.set(p.id, mem)
      } catch (e) {
        console.warn('[memory sync]', e)
      }
    }
  }
  setInterval(syncMemory, 15_000)
  setTimeout(syncMemory, 4000)

  // ---------- continue when the usage window resets ----------
  const lastApproach = new Map<string, number>()
  const resumeTimers = new Map<string, NodeJS.Timeout>()
  function scheduleResume(agentId: string, text: string): void {
    if (getState().settings.resumeOnReset === false) return
    const m = text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').match(/resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i)
    if (!m) return
    let h = Number(m[1]) % 24
    const min = Number(m[2] ?? 0)
    if (m[3]?.toLowerCase() === 'pm' && h < 12) h += 12
    if (m[3]?.toLowerCase() === 'am' && h === 12) h = 0
    const at = new Date()
    at.setHours(h, min, 0, 0)
    if (at.getTime() <= Date.now()) at.setDate(at.getDate() + 1)
    const a0 = getState().agents.find((x) => x.id === agentId)
    const key = `${a0?.providerId}:${a0?.accountId ?? ''}`
    clearTimeout(resumeTimers.get(agentId))
    resumeTimers.set(agentId, setTimeout(() => {
      resumeTimers.delete(agentId)
      const a = getState().agents.find((x) => x.id === agentId)
      // only if it is still the same CLI/account (an automatic switch already took over otherwise)
      if (!a || `${a.providerId}:${a.accountId ?? ''}` !== key || !ctx.agents.isRunning(agentId)) return
      ctx.agents.deliver(agentId, 'The usage limit has reset – continue where you left off.')
      notify(`▶️ ${a.name} continues`, 'The usage window reset; queued messages go out now.', agentId)
    }, at.getTime() - Date.now() + 60_000))
    ctx.send('toast', `⏰ Will continue automatically at ${at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} when the limit resets`)
  }

  // ---------- Figma ----------
  ipcMain.handle('figma:frame', async (_e, url: string, projectId?: string) => {
    const token = secretEnv(projectId ?? '').FIGMA_TOKEN
    if (!token) throw new Error('Add a FIGMA_TOKEN secret first (Figma → Settings → Security → Personal access tokens)')
    const m = url.match(/figma\.com\/(?:file|design|proto)\/([A-Za-z0-9]+)/)
    const node = decodeURIComponent(url.match(/node-id=([^&]+)/)?.[1] ?? '').replace('-', ':')
    if (!m || !node) throw new Error('Paste a Figma link to a frame (it must contain node-id=…)')
    const h = { 'X-Figma-Token': token }
    const img = (await (await fetch(`https://api.figma.com/v1/images/${m[1]}?ids=${encodeURIComponent(node)}&format=png&scale=2`, { headers: h })).json()) as { images?: Record<string, string>; err?: string }
    const src = img.images?.[node]
    if (!src) throw new Error(`Figma: ${img.err ?? 'no image for that frame'}`)
    const png = new Uint8Array(await (await fetch(src)).arrayBuffer())
    const info = (await (await fetch(`https://api.figma.com/v1/files/${m[1]}/nodes?ids=${encodeURIComponent(node)}&depth=3`, { headers: h })).json()) as {
      nodes?: Record<string, { document?: { name?: string; absoluteBoundingBox?: { width: number; height: number }; children?: { name: string; characters?: string; children?: unknown[] }[] } }>
    }
    const doc = info.nodes?.[node]?.document
    const texts: string[] = []
    const walk = (n: { characters?: string; children?: unknown[] } | undefined): void => {
      if (!n) return
      if (n.characters) texts.push(n.characters)
      ;(n.children as { characters?: string; children?: unknown[] }[] | undefined)?.forEach(walk)
    }
    walk(doc)
    const att = await saveImage(png, 'png')
    const box = doc?.absoluteBoundingBox
    return { ...att, name: doc?.name ?? 'Frame', size: box ? `${Math.round(box.width)}×${Math.round(box.height)}` : '', texts: texts.slice(0, 40), url }
  })

  // ---------- tracker imports ----------
  ipcMain.handle('tracker:import', async (_e, projectId: string, kind: 'linear' | 'jira' | 'notion' | 'azure', opts: Record<string, string>) => {
    const env = secretEnv(projectId)
    const need = (k: string): string => {
      if (!env[k]) throw new Error(`Add a ${k} secret first (Workspace → Secrets)`)
      return env[k]
    }
    let items: { key: string; title: string; body: string; url: string; labels: string[] }[] = []
    if (kind === 'linear') {
      const filter = [opts.team && `team: { key: { eq: "${opts.team}" } }`, opts.assignee === 'me' && 'assignee: { isMe: { eq: true } }', `state: { type: { nin: ["completed", "canceled"] } }`]
        .filter(Boolean)
        .join(', ')
      const res = await fetch('https://api.linear.app/graphql', {
        method: 'POST',
        headers: { Authorization: need('LINEAR_API_KEY'), 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: `{ issues(first: 100, filter: { ${filter} }) { nodes { identifier title description url labels { nodes { name } } } } }` })
      })
      const j = (await res.json()) as { data?: { issues: { nodes: { identifier: string; title: string; description?: string; url: string; labels: { nodes: { name: string }[] } }[] } }; errors?: { message: string }[] }
      if (!j.data) throw new Error(`Linear: ${j.errors?.[0]?.message ?? res.statusText}`)
      items = j.data.issues.nodes.map((n) => ({ key: n.identifier, title: n.title, body: n.description ?? '', url: n.url, labels: n.labels.nodes.map((l) => l.name) }))
    } else if (kind === 'jira') {
      const base = need('JIRA_BASE_URL').replace(/\/$/, '')
      const auth = Buffer.from(`${need('JIRA_EMAIL')}:${need('JIRA_API_TOKEN')}`).toString('base64')
      const jql = opts.jql || 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC'
      const res = await fetch(`${base}/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&maxResults=100&fields=summary,description,labels`, { headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' } })
      if (!res.ok) throw new Error(`Jira: ${res.status} ${(await res.text()).slice(0, 160)}`)
      const j = (await res.json()) as { issues: { key: string; fields: { summary: string; description?: unknown; labels?: string[] } }[] }
      const adf = (n: unknown): string => {
        if (!n || typeof n !== 'object') return ''
        const o = n as { type?: string; text?: string; content?: unknown[] }
        const inner = (o.content ?? []).map(adf).join(o.type === 'doc' ? '\n\n' : '')
        return o.text ?? (o.type === 'listItem' ? `- ${inner}\n` : o.type === 'paragraph' ? `${inner}\n` : inner)
      }
      items = j.issues.map((i) => ({ key: i.key, title: i.fields.summary, body: adf(i.fields.description).trim(), url: `${base}/browse/${i.key}`, labels: i.fields.labels ?? [] }))
    } else if (kind === 'notion') {
      const db = (opts.database || '').match(/[0-9a-f]{32}|[0-9a-f-]{36}/i)?.[0]
      if (!db) throw new Error('Paste the Notion database link or id')
      const res = await fetch(`https://api.notion.com/v1/databases/${db}/query`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${need('NOTION_TOKEN')}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
        body: JSON.stringify({ page_size: 100 })
      })
      if (!res.ok) throw new Error(`Notion: ${res.status} ${(await res.text()).slice(0, 160)} – share the database with your integration`)
      const j = (await res.json()) as { results: { id: string; url: string; properties: Record<string, { type: string; title?: { plain_text: string }[]; rich_text?: { plain_text: string }[]; status?: { name: string }; select?: { name: string }; multi_select?: { name: string }[] }> }[] }
      items = j.results
        .map((p) => {
          const props = Object.entries(p.properties)
          const title = props.find(([, v]) => v.type === 'title')?.[1].title?.map((t) => t.plain_text).join('') ?? 'Untitled'
          const status = props.find(([, v]) => v.type === 'status')?.[1].status?.name ?? ''
          const body = props
            .filter(([, v]) => v.type === 'rich_text' && v.rich_text?.length)
            .map(([k, v]) => `**${k}:** ${v.rich_text!.map((t) => t.plain_text).join('')}`)
            .join('\n')
          const labels = props.flatMap(([, v]) => (v.type === 'multi_select' ? v.multi_select!.map((s) => s.name) : v.type === 'select' && v.select ? [v.select.name] : []))
          return { key: p.id.slice(0, 8), title, body, url: p.url, labels, status }
        })
        .filter((x) => !/done|complete|tamam|bitti/i.test(x.status))
    } else {
      const org = (opts.org || '').replace(/\/$/, '')
      if (!org || !opts.project) throw new Error('Organization URL and project are required')
      const auth = `Basic ${Buffer.from(`:${need('AZURE_DEVOPS_PAT')}`).toString('base64')}`
      const wiql = opts.wiql || `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.State] NOT IN ('Closed','Done','Removed') ORDER BY [System.ChangedDate] DESC`
      const r1 = await fetch(`${org}/${encodeURIComponent(opts.project)}/_apis/wit/wiql?api-version=7.0`, { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: wiql }) })
      if (!r1.ok) throw new Error(`Azure DevOps: ${r1.status} ${(await r1.text()).slice(0, 160)}`)
      const ids = ((await r1.json()) as { workItems: { id: number }[] }).workItems.slice(0, 100).map((w) => w.id)
      if (ids.length) {
        const r2 = await fetch(`${org}/_apis/wit/workitems?ids=${ids.join(',')}&fields=System.Title,System.Description,Microsoft.VSTS.Common.AcceptanceCriteria,System.Tags&api-version=7.0`, { headers: { Authorization: auth } })
        const j = (await r2.json()) as { value: { id: number; fields: Record<string, string> }[] }
        const strip = (h?: string): string => (h ?? '').replace(/<br\s*\/?>/g, '\n').replace(/<\/(p|div|li)>/g, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim()
        items = j.value.map((w) => ({
          key: `#${w.id}`,
          title: w.fields['System.Title'],
          body: [strip(w.fields['System.Description']), w.fields['Microsoft.VSTS.Common.AcceptanceCriteria'] && `**Acceptance criteria**\n${strip(w.fields['Microsoft.VSTS.Common.AcceptanceCriteria'])}`].filter(Boolean).join('\n\n'),
          url: `${org}/${encodeURIComponent(opts.project)}/_workitems/edit/${w.id}`,
          labels: (w.fields['System.Tags'] ?? '').split(';').map((t) => t.trim()).filter(Boolean)
        }))
      }
    }
    let added = 0
    let updated = 0
    save((s) => {
      for (const i of items) {
        const ex = s.tasks.find((t) => t.projectId === projectId && t.source?.kind === kind && t.source.key === i.key)
        const source: Task['source'] = { kind, key: i.key, url: i.url, labels: i.labels }
        if (ex) {
          Object.assign(ex, { title: i.title, body: i.body, source, updatedAt: Date.now() })
          updated++
        } else {
          s.tasks.push({ id: randomUUID(), projectId, title: i.title, body: i.body, status: 'todo', source, createdAt: Date.now(), updatedAt: Date.now() })
          added++
        }
      }
    })
    return { added, updated, total: items.length }
  })

  // ---------- clone a repo ----------
  ipcMain.handle('repos:list', async () => {
    const out: { name: string; url: string; description: string; host: 'github' | 'gitlab' }[] = []
    try {
      const gh = JSON.parse(await shellRun('gh repo list --limit 60 --json nameWithOwner,url,description', undefined, 20_000)) as { nameWithOwner: string; url: string; description?: string }[]
      out.push(...gh.map((r) => ({ name: r.nameWithOwner, url: r.url, description: r.description ?? '', host: 'github' as const })))
    } catch {
      /* gh missing / not logged in */
    }
    try {
      const gl = JSON.parse(await shellRun('glab repo list --per-page 60 --output json', undefined, 20_000)) as { path_with_namespace: string; http_url_to_repo: string; description?: string }[]
      out.push(...gl.map((r) => ({ name: r.path_with_namespace, url: r.http_url_to_repo, description: r.description ?? '', host: 'gitlab' as const })))
    } catch {
      /* glab missing */
    }
    return out
  })
  ipcMain.handle('repos:clone', async (_e, url: string) => {
    const res = await dialog.showOpenDialog(ctx.win()!, { title: 'Clone into which folder?', properties: ['openDirectory', 'createDirectory'] })
    if (res.canceled || !res.filePaths[0]) return null
    const name = basename(url.replace(/\.git$/, '').replace(/\/$/, ''))
    const dest = join(res.filePaths[0], name)
    if (existsSync(dest)) throw new Error(`${dest} already exists`)
    // gh / glab URLs like "owner/repo" are cloned with the CLI so private repos use your login
    const cmd = /^[\w.-]+\/[\w.-]+$/.test(url) ? `gh repo clone ${q(url)} ${q(dest)}` : `git clone ${q(url)} ${q(dest)}`
    await shellRun(cmd, res.filePaths[0], 600_000)
    const project: Project = { id: randomUUID(), name, path: dest, createdAt: Date.now() }
    updateState((s) => s.projects.push(project))
    await seedNewProject(project)
    ctx.broadcastState()
    return project
  })

  // ---------- skills as SKILL.md ----------
  const skillMd = (s: Skill): string => `---\nname: ${s.name}\ndescription: ${s.description.replace(/\n/g, ' ')}\n---\n\n${s.body}\n`
  ipcMain.handle('skills:export', (_e, target: 'claude-project' | 'claude-user' | 'codex-user' | 'cursor-project', projectId?: string) => {
    const p = projectId ? ctx.findProject(projectId) : undefined
    const files: string[] = []
    for (const s of getState().skills) {
      const slug = s.name.replace(/[^\w-]+/g, '-').toLowerCase()
      let file: string
      let content = skillMd(s)
      if (target === 'claude-project') file = join(p!.path, '.claude', 'skills', slug, 'SKILL.md')
      else if (target === 'claude-user') file = join(claudeHome(), 'skills', slug, 'SKILL.md')
      else if (target === 'codex-user') file = join(codexHome(), 'skills', slug, 'SKILL.md')
      else {
        file = join(p!.path, '.cursor', 'rules', `${slug}.mdc`)
        content = `---\ndescription: ${s.description.replace(/\n/g, ' ')}\nalwaysApply: false\n---\n\n# ${s.name}\n\n${s.body}\n`
      }
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, content)
      files.push(file)
    }
    return files
  })
  ipcMain.handle('skills:importFiles', (_e, projectId?: string) => {
    const p = projectId ? getState().projects.find((x) => x.id === projectId) : undefined
    const roots = [p && join(p.path, '.claude', 'skills'), join(claudeHome(), 'skills'), join(codexHome(), 'skills')].filter(Boolean) as string[]
    let n = 0
    const found: Skill[] = []
    for (const r of roots) {
      if (!existsSync(r)) continue
      for (const d of readdirSync(r)) {
        const f = join(r, d, 'SKILL.md')
        if (!existsSync(f) || !statSync(f).isFile()) continue
        const text = readFileSync(f, 'utf8')
        const fm = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
        const meta = Object.fromEntries((fm?.[1] ?? '').split('\n').map((l) => [l.split(':')[0].trim(), l.split(':').slice(1).join(':').trim()]))
        found.push({ id: randomUUID(), name: meta.name || d, description: meta.description || '', body: (fm?.[2] ?? text).trim() })
      }
    }
    save((s) => {
      for (const sk of found) {
        const ex = s.skills.find((x) => x.name === sk.name)
        if (ex) Object.assign(ex, { description: sk.description, body: sk.body })
        else s.skills.push(sk)
        n++
      }
    })
    return n
  })

  // ---------- restore last session ----------
  function recordRunning(): void {
    const agentsOn = getState().agents.filter((a) => ctx.agents.isRunning(a.id)).map((a) => a.id)
    const serversOn = ctx.servers.all().filter((s) => s.running && !s.serverId.startsWith('signin-')).map((s) => s.serverId)
    updateState((s) => (s.lastRunning = { agents: agentsOn, servers: serversOn, at: Date.now() }))
  }
  function restore(): void {
    const st = getState()
    if (!st.settings.restoreSession || !st.lastRunning) return
    const { agents: ids, servers: srv } = st.lastRunning
    let n = 0
    for (const id of ids) {
      if (!st.agents.some((a) => a.id === id) || ctx.agents.isRunning(id)) continue
      try {
        ctx.startAgent(id, true)
        n++
      } catch (err) {
        console.warn('[restore]', err)
      }
    }
    for (const sid of srv) {
      const def = st.servers.find((x) => x.id === sid)
      if (!def) continue
      try {
        ctx.servers.start(def, join(ctx.findProject(def.projectId).path, def.cwd || ''), {})
        n++
      } catch (err) {
        console.warn('[restore]', err)
      }
    }
    if (n) ctx.send('toast', `Restored ${n} agent${n === 1 ? '' : 's'} / server${n === 1 ? '' : 's'} from last time`)
  }

  return {
    onData(agentId, data) {
      if (APPROACH_RE.test(data)) {
        const now = Date.now()
        if (now - (lastApproach.get(agentId) ?? 0) > 2 * 3600_000) {
          lastApproach.set(agentId, now)
          const a = getState().agents.find((x) => x.id === agentId)
          notify(`⚠️ ${a?.name ?? 'Agent'}: approaching the usage limit`, 'Plan the rest of the work – or add another account in Settings → Agents & CLIs.', agentId)
          ctx.send('toast', `⚠️ ${a?.name ?? 'Agent'} is approaching its usage limit`)
        }
      }
      if (!LIMIT_RE.test(data)) return
      const now = Date.now()
      if (now - (lastLimit.get(agentId) ?? 0) < 120_000) return
      lastLimit.set(agentId, now)
      ctx.send('agent:limit', agentId)
      scheduleResume(agentId, data)
      if (getState().settings.autoSwitch) setTimeout(() => switchAccount(agentId).catch((e) => console.warn('[switch]', e)), 1500)
    },
    recordRunning,
    restore
  }
}

