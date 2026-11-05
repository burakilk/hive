/**
 * Reads a Claude Code session transcript (JSONL) as a conversation, plus the current
 * context-window usage. Cached by size+mtime so polling is cheap.
 */
import { statSync } from 'fs'
import { open } from 'fs/promises'
import type { ChatItem, Conversation } from '@shared/chat'
import { kindOf, readOther } from './otherclis'

const cache = new Map<string, { size: number; mtime: number; conv: Conversation }>()

type Block = { type: string; text?: string; name?: string; input?: Record<string, unknown>; id?: string; tool_use_id?: string; content?: unknown; is_error?: boolean }

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)/g
const tag = (s: string, t: string): string | undefined => s.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`))?.[1]

/**
 * Slash commands run inside Claude Code ("/model opus", "/cost", "/usage") are logged as
 * <command-name>… followed by <local-command-stdout>…, either as user lines (older CLIs)
 * or as system/local_command lines (newer). Turns them into one "command" item.
 */
function localCommand(txt: string, items: ChatItem[], at: number): boolean {
  if (txt.startsWith('<local-command-caveat>')) return true
  const name = tag(txt, 'command-name')
  if (name !== undefined) {
    items.push({ kind: 'command', tool: name.replace(/^\//, '').trim(), text: (tag(txt, 'command-args') ?? '').trim(), at })
    return true
  }
  const out = tag(txt, 'local-command-stdout') ?? tag(txt, 'local-command-stderr')
  if (out === undefined) return txt.startsWith('<local-command') || txt.startsWith('<command-')
  const clean = out.replace(ANSI, '').trim()
  const last = [...items].reverse().find((x) => x.kind === 'command')
  if (clean && last && last.result === undefined) {
    last.result = clean.slice(0, 8000)
    last.error = txt.includes('<local-command-stderr>')
  }
  return true
}

function asText(c: unknown): string {
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.map((b: Block) => (b.type === 'text' ? b.text ?? '' : b.type === 'image' ? '[image]' : '')).join('\n')
  return ''
}

const MAX_INLINE_IMAGE = 4_000_000 // base64 chars

/**
 * Images a user message carries: base64 blocks (pasted into the CLI) and Hive's
 * "[Screenshot: <path>]" markers. Returns the text without the markers.
 */
function userImages(content: unknown, txt: string): { text: string; images: string[] } {
  const images: string[] = []
  if (Array.isArray(content))
    for (const b of content as (Block & { source?: { type?: string; data?: string; media_type?: string } })[])
      if (b.type === 'image' && b.source?.type === 'base64' && b.source.data && b.source.data.length < MAX_INLINE_IMAGE)
        images.push(`data:${b.source.media_type ?? 'image/png'};base64,${b.source.data}`)
  const text = txt
    .replace(/\[Screenshot: ([^\]\n]+)\]\n?/g, (_m, p: string) => (images.push(p.trim()), ''))
    .replace(/\(Look at the attached image files?\.\)/g, '')
    .replace(/\[Image #\d+\]/g, '')
    .replace(/\[image\]/g, '')
    .replace(/<\/?pasted_content[^>]*>/g, '')
    .trim()
  return { text, images }
}

/** one-line summary of a tool call, e.g. Edit(src/app.ts) or Bash(npm test) */
function toolSummary(name: string, input: Record<string, unknown> = {}): string {
  const pick = (input.file_path ?? input.path ?? input.command ?? input.pattern ?? input.url ?? input.description ?? input.prompt ?? '') as string
  const s = String(pick).replace(/\s+/g, ' ').trim()
  return s ? `${name}(${s.length > 90 ? s.slice(0, 90) + '…' : s})` : name
}

/**
 * The agent's current session file. Not simply the last one registered: Claude Code
 * announces a session (SessionStart) before it writes its file, and side processes
 * can announce sessions that never get a file. So: the most recently written file that exists.
 */
export function currentSession(sessions?: string[]): string | undefined {
  let best: string | undefined
  let bestT = -1
  for (const p of sessions ?? []) {
    try {
      const t = statSync(p).mtimeMs
      if (t >= bestT) [best, bestT] = [p, t]
    } catch {
      /* never written / deleted */
    }
  }
  return best
}

export async function readConversation(path: string, limit = 400): Promise<Conversation> {
  if (kindOf(path) !== 'claude') {
    const c = readOther(path).conv
    return { ...c, items: c.items.slice(-limit) }
  }
  let st
  try {
    st = statSync(path)
  } catch {
    return { items: [], context: null }
  }
  const hit = cache.get(path)
  if (hit && hit.size === st.size && hit.mtime === st.mtimeMs) return { ...hit.conv, items: hit.conv.items.slice(-limit) }
  const fh = await open(path, 'r')
  const text = (await fh.readFile()).toString('utf8')
  await fh.close()

  const items: ChatItem[] = []
  const tools = new Map<string, ChatItem>()
  const seen = new Set<string>()
  let context: Conversation['context'] = null
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let j: {
      type?: string
      subtype?: string
      content?: unknown
      isMeta?: boolean
      isSidechain?: boolean
      timestamp?: string
      uuid?: string
      message?: { id?: string; role?: string; model?: string; content?: unknown; usage?: Record<string, number> }
    }
    try {
      j = JSON.parse(line)
    } catch {
      continue
    }
    if (j.isSidechain || j.isMeta) continue
    const at = j.timestamp ? Date.parse(j.timestamp) : 0
    if (j.type === 'system' && j.subtype === 'local_command' && typeof j.content === 'string') {
      localCommand(j.content, items, at)
      continue
    }
    if (!j.message) continue
    const content = j.message.content
    if (j.type === 'user') {
      if (Array.isArray(content)) {
        for (const b of content as Block[]) {
          if (b.type === 'tool_result' && b.tool_use_id) {
            const t = tools.get(b.tool_use_id)
            if (t) {
              t.result = asText(b.content).slice(0, 4000)
              t.error = !!b.is_error
            }
          }
        }
      }
      const txt = asText(content).trim()
      if (!txt || txt.startsWith('Caveat:') || localCommand(txt, items, at)) continue
      const { text: body, images } = userImages(content, txt)
      if (!body && !images.length) continue
      items.push({ kind: 'user', text: body, ...(images.length ? { images } : {}), at })
    } else if (j.type === 'assistant') {
      const u = j.message.usage
      if (u && j.message.model !== '<synthetic>') {
        const used = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
        const model = j.message.model ?? ''
        const window = /\[1m\]|-1m/i.test(model) || used > 200_000 ? 1_000_000 : 200_000
        context = { used, window, model }
      }
      if (!Array.isArray(content)) continue
      for (const b of content as Block[]) {
        // streamed messages repeat blocks – keep one per (message id, block index-ish)
        const key = `${j.message.id}:${b.type}:${b.id ?? (b.text ?? '').slice(0, 60)}`
        if (seen.has(key)) continue
        seen.add(key)
        if (b.type === 'text' && b.text?.trim()) items.push({ kind: 'assistant', text: b.text.trim(), at })
        else if (b.type === 'tool_use' && b.name) {
          const item: ChatItem = { kind: 'tool', text: toolSummary(b.name, b.input), tool: b.name, input: JSON.stringify(b.input ?? {}, null, 2).slice(0, 30000), at }
          if (b.id) tools.set(b.id, item)
          items.push(item)
        }
      }
    }
  }
  const conv: Conversation = { items, context }
  cache.set(path, { size: st.size, mtime: st.mtimeMs, conv })
  return { ...conv, items: items.slice(-limit) }
}
