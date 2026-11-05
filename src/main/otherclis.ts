/**
 * Codex CLI and Gemini CLI sessions: discovery (which session file belongs to which
 * agent), conversation, context-window usage and token cost – the same things Hive
 * reads from Claude Code transcripts.
 *
 *  Codex:  ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl   (CODEX_HOME overrides ~/.codex)
 *  Gemini: ~/.gemini/tmp/<sha256(project dir)>/chats/session-*.json
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { createHash } from 'crypto'
import { homedir } from 'os'
import { join } from 'path'
import type { ChatItem, Conversation } from '@shared/chat'

export type SessionKind = 'claude' | 'codex' | 'gemini'
export const kindOf = (path: string): SessionKind =>
  /[\\/]\.codex[\\/]|rollout-[^/\\]*\.jsonl$/.test(path) ? 'codex' : /[\\/]\.gemini[\\/].*\.json$/.test(path) ? 'gemini' : 'claude'

const codexHome = (): string => process.env.CODEX_HOME || join(homedir(), '.codex')
const geminiHome = (): string => join(homedir(), '.gemini')

// ---------- prices (USD per 1M tokens: input, cached input, output) ----------
const PRICES: [RegExp, [number, number, number]][] = [
  [/gpt-5.*mini/, [0.25, 0.025, 2]],
  [/gpt-5.*nano/, [0.05, 0.005, 0.4]],
  [/gpt-5|codex/, [1.25, 0.125, 10]],
  [/o4-mini|o3-mini/, [1.1, 0.275, 4.4]],
  [/o3/, [2, 0.5, 8]],
  [/gpt-4\.1-mini/, [0.4, 0.1, 1.6]],
  [/gpt-4\.1/, [2, 0.5, 8]],
  [/gemini-.*flash-lite/, [0.1, 0.025, 0.4]],
  [/gemini-.*flash/, [0.3, 0.075, 2.5]],
  [/gemini-3/, [2, 0.2, 12]],
  [/gemini/, [1.25, 0.31, 10]]
]
const priceOf = (model: string): [number, number, number] => PRICES.find(([re]) => re.test(model))?.[1] ?? [1.25, 0.125, 10]

export interface OtherUsageEntry {
  day: string
  model: string
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
  cost: number
}
const dayOf = (ms: number): string => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// ---------- discovery ----------
function walkCodex(sinceMs: number): string[] {
  const root = join(codexHome(), 'sessions')
  if (!existsSync(root)) return []
  const out: string[] = []
  // day folders from `since` (at most 30 days back, at least the last 3) up to today
  const days = Math.min(30, Math.max(3, Math.ceil((Date.now() - sinceMs) / 86400000) + 1))
  for (let back = 0; back < days; back++) {
    const d = new Date(Date.now() - back * 86400000)
    const dir = join(root, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'))
    if (!existsSync(dir)) continue
    for (const f of readdirSync(dir)) if (f.endsWith('.jsonl')) out.push(join(dir, f))
  }
  return out
}

/** Codex: first line is session_meta with the working directory. */
function codexMeta(path: string): { cwd?: string; at: number } {
  try {
    const first = readFileSync(path, 'utf8').split('\n', 1)[0]
    const j = JSON.parse(first)
    const p = j.payload ?? j
    return { cwd: p.cwd, at: Date.parse(p.timestamp ?? j.timestamp) || statSync(path).birthtimeMs }
  } catch {
    return { at: 0 }
  }
}

export const geminiProjectDir = (cwd: string): string => join(geminiHome(), 'tmp', createHash('sha256').update(cwd).digest('hex'), 'chats')

/** Codex session file by its id (the notify payload's "thread-id"); undefined if not found. */
export function codexSessionById(id: string): string | undefined {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return undefined
  return walkCodex(Date.now() - 30 * 86400000).find((p) => p.endsWith(`${id}.jsonl`))
}

/** Session files of `kind` started in `cwd` after `sinceMs` (oldest first), with their start time. */
export function findSessionsTimed(kind: 'codex' | 'gemini', cwd: string, sinceMs: number): { path: string; at: number }[] {
  if (kind === 'codex') {
    return walkCodex(sinceMs)
      .map((path) => ({ path, m: codexMeta(path) }))
      .filter((x) => x.m.cwd === cwd && x.m.at >= sinceMs - 60_000)
      .map((x) => ({ path: x.path, at: x.m.at }))
      .sort((a, b) => a.at - b.at)
  }
  const dir = geminiProjectDir(cwd)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => join(dir, f))
    .map((path) => {
      const st = statSync(path)
      return { path, at: st.birthtimeMs || st.mtimeMs }
    })
    .filter((x) => x.at >= sinceMs - 60_000)
    .sort((a, b) => a.at - b.at)
}

/** Session files of `kind` started in `cwd` after `sinceMs` (oldest first). */
export const findSessions = (kind: 'codex' | 'gemini', cwd: string, sinceMs: number): string[] =>
  findSessionsTimed(kind, cwd, sinceMs).map((x) => x.path)

// ---------- parsing ----------
type Parsed = { conv: Conversation; usage: OtherUsageEntry[] }
const cache = new Map<string, { size: number; mtime: number; v: Parsed }>()

function cached(path: string, fn: () => Parsed): Parsed {
  let st
  try {
    st = statSync(path)
  } catch {
    return { conv: { items: [], context: null }, usage: [] }
  }
  const hit = cache.get(path)
  if (hit && hit.size === st.size && hit.mtime === st.mtimeMs) return hit.v
  const v = fn()
  cache.set(path, { size: st.size, mtime: st.mtimeMs, v })
  return v
}

const textOf = (c: unknown): string =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map((b: { text?: string }) => b?.text ?? '').join('\n') : ''

function parseCodex(path: string): Parsed {
  const items: ChatItem[] = []
  const usage: OtherUsageEntry[] = []
  const calls = new Map<string, ChatItem>()
  let model = 'gpt-5-codex'
  let prev = { input: 0, cached: 0, output: 0 }
  let context: Conversation['context'] = null
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let j: { timestamp?: string; type?: string; payload?: Record<string, unknown> }
    try {
      j = JSON.parse(line)
    } catch {
      continue
    }
    const p = (j.payload ?? {}) as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
    const at = Date.parse(j.timestamp ?? '') || 0
    if (j.type === 'turn_context' && p.model) model = p.model
    if (j.type === 'response_item') {
      if (p.type === 'message') {
        const t = textOf(p.content).trim()
        if (!t || t.startsWith('<environment_context>') || t.startsWith('<user_instructions>')) continue
        items.push({ kind: p.role === 'user' ? 'user' : 'assistant', text: t, at })
      } else if (p.type === 'function_call' || p.type === 'local_shell_call' || p.type === 'custom_tool_call') {
        let args: Record<string, unknown> = {}
        try {
          args = typeof p.arguments === 'string' ? JSON.parse(p.arguments) : (p.arguments ?? p.action ?? {})
        } catch {
          /* keep raw */
        }
        const cmd = Array.isArray(args.command) ? (args.command as string[]).join(' ') : String(args.command ?? args.path ?? p.input ?? '')
        const it: ChatItem = { kind: 'tool', tool: p.name ?? 'shell', text: `${p.name ?? 'shell'}(${cmd.replace(/^bash -lc /, '').slice(0, 90)})`, input: JSON.stringify(args, null, 2).slice(0, 30000), at }
        items.push(it)
        if (p.call_id) calls.set(p.call_id, it)
      } else if ((p.type === 'function_call_output' || p.type === 'custom_tool_call_output') && p.call_id) {
        const it = calls.get(p.call_id)
        if (it) it.result = String(typeof p.output === 'string' ? p.output : JSON.stringify(p.output)).slice(0, 4000)
      }
    }
    if (j.type === 'event_msg' && p.type === 'token_count' && p.info) {
      const tot = p.info.total_token_usage ?? {}
      const cur = { input: tot.input_tokens ?? 0, cached: tot.cached_input_tokens ?? 0, output: (tot.output_tokens ?? 0) + (tot.reasoning_output_tokens ?? 0) }
      const d = { input: Math.max(0, cur.input - prev.input), cached: Math.max(0, cur.cached - prev.cached), output: Math.max(0, cur.output - prev.output) }
      prev = cur
      if (d.input + d.output > 0) {
        const [pi, pc, po] = priceOf(model)
        const fresh = Math.max(0, d.input - d.cached)
        usage.push({ day: dayOf(at || Date.now()), model, input: fresh, output: d.output, cacheWrite: 0, cacheRead: d.cached, cost: (fresh * pi + d.cached * pc + d.output * po) / 1e6 })
      }
      const last = p.info.last_token_usage
      if (last) context = { used: last.input_tokens ?? 0, window: p.info.model_context_window ?? 272_000, model }
    }
  }
  return { conv: { items, context }, usage }
}

function parseGemini(path: string): Parsed {
  const items: ChatItem[] = []
  const usage: OtherUsageEntry[] = []
  let context: Conversation['context'] = null
  let data: { messages?: Record<string, any>[] } // eslint-disable-line @typescript-eslint/no-explicit-any
  try {
    data = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return { conv: { items, context }, usage }
  }
  for (const m of data.messages ?? []) {
    const at = Date.parse(m.timestamp ?? '') || 0
    const text = textOf(m.content).trim()
    if (m.type === 'user' && text) items.push({ kind: 'user', text, at })
    if (m.type === 'gemini') {
      if (text) items.push({ kind: 'assistant', text, at })
      for (const tc of m.toolCalls ?? []) {
        const args = tc.args ?? {}
        const arg = String(args.command ?? args.file_path ?? args.absolute_path ?? args.path ?? args.pattern ?? '').slice(0, 90)
        items.push({
          kind: 'tool',
          tool: tc.name,
          text: `${tc.displayName ?? tc.name}${arg ? `(${arg})` : ''}`,
          input: JSON.stringify(args, null, 2).slice(0, 30000),
          result: textOf(tc.result?.map?.((r: { functionResponse?: { response?: { output?: string } } }) => ({ text: r.functionResponse?.response?.output ?? '' })) ?? '').slice(0, 4000),
          error: tc.status === 'error',
          at
        })
      }
      const t = m.tokens
      if (t) {
        const model = m.model ?? 'gemini-2.5-pro'
        const [pi, pc, po] = priceOf(model)
        const cachedT = t.cached ?? 0
        const fresh = Math.max(0, (t.input ?? 0) - cachedT)
        const out = (t.output ?? 0) + (t.thoughts ?? 0)
        usage.push({ day: dayOf(at || Date.now()), model, input: fresh, output: out, cacheWrite: 0, cacheRead: cachedT, cost: (fresh * pi + cachedT * pc + out * po) / 1e6 })
        context = { used: t.input ?? 0, window: 1_048_576, model }
      }
    }
  }
  return { conv: { items, context }, usage }
}

export function readOther(path: string): Parsed {
  return cached(path, () => (kindOf(path) === 'codex' ? parseCodex(path) : parseGemini(path)))
}
