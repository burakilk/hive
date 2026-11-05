import { useEffect, useMemo, useRef, useState } from 'react'
import { Marked } from 'marked'
import DOMPurify from 'dompurify'
import type { ChatItem, Conversation } from '@shared/chat'
import { useStore } from '../store'
import { Icon } from './common'
import { fmtTok } from './UsageView'
import { speak } from '../speech'
import { linkClick, markPaths } from '../links'
import { Terminal } from './Terminal'

const md = new Marked({ gfm: true, breaks: true })
const html = (s: string): string => DOMPurify.sanitize(md.parse(s, { async: false }) as string)



/** Polls the agent's Claude Code transcript (only while something shows it). */
export function useConversation(agentId: string, enabled: boolean, everyMs = 2500): (Conversation & { none?: boolean }) | null {
  const [conv, setConv] = useState<(Conversation & { none?: boolean }) | null>(null)
  const status = useStore((s) => s.runtimes[agentId]?.status)
  const isClaude = useStore((s) => ['claude', 'codex', 'gemini'].includes(s.app.agents.find((a) => a.id === agentId)?.providerId ?? ''))
  useEffect(() => {
    if (!enabled || !isClaude) return
    let alive = true
    const load = (): void => {
      window.api.conversation(agentId).then((c) => alive && setConv(c)).catch(() => undefined)
    }
    load()
    const t = setInterval(load, status === 'working' ? everyMs : everyMs * 3)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [agentId, enabled, isClaude, status, everyMs])
  return isClaude ? conv : null
}

/** "ctx 42% · 84k / 200k" – turns amber and red as the context window fills. */
export function ContextBadge({ conv }: { conv: Conversation | null }) {
  const c = conv?.context
  if (!c) return null
  const pct = Math.round((c.used / c.window) * 100)
  const lvl = pct >= 80 ? 'hi' : pct >= 55 ? 'mid' : 'lo'
  return (
    <span className={`chip ctx-badge ${lvl}`} title={`Context window: ${c.used.toLocaleString()} of ${c.window.toLocaleString()} tokens (${c.model})${pct >= 80 ? '\nConsider /compact or a fresh session.' : ''}`}>
      <i style={{ width: `${Math.min(100, pct)}%` }} />
      <span>ctx {pct}% · {fmtTok(c.used)}/{fmtTok(c.window)}</span>
    </span>
  )
}

/* ---------------- VS Code–style conversation ---------------- */

type Json = Record<string, unknown>
const parse = (s?: string): Json | null => {
  if (!s) return null
  try {
    return JSON.parse(s) as Json
  } catch {
    return null
  }
}
const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : JSON.stringify(v))

/** normalise tool names across Claude Code, Codex and Gemini */
function toolKind(name = ''): 'edit' | 'write' | 'read' | 'bash' | 'search' | 'todo' | 'web' | 'task' | 'other' {
  const n = name.toLowerCase()
  if (/^(edit|multiedit|replace|apply_patch|str_replace)/.test(n)) return 'edit'
  if (/^(write|write_file|create_file)/.test(n)) return 'write'
  if (/^(read|read_file|read_many_files|view|notebookread)/.test(n)) return 'read'
  if (/^(bash|shell|run_shell_command|local_shell|exec)/.test(n)) return 'bash'
  if (/^(grep|glob|ls|list_directory|search_file_content|find|search)/.test(n)) return 'search'
  if (/^(todowrite|update_plan|todo)/.test(n)) return 'todo'
  if (/^(webfetch|websearch|web_fetch|google_web_search)/.test(n)) return 'web'
  if (/^(task|agent)/.test(n)) return 'task'
  return 'other'
}
const TOOL_LABEL: Record<string, string> = { edit: 'Edit', write: 'Write', read: 'Read', bash: 'Bash', search: 'Search', todo: 'Update Todos', web: 'Web', task: 'Task' }

function Diff({ oldText, newText }: { oldText: string; newText: string }) {
  const [all, setAll] = useState(false)
  const lines = [...oldText.split('\n').map((l) => ['-', l] as const), ...newText.split('\n').map((l) => ['+', l] as const)].filter(([, l], i, arr) => !(l === '' && i === arr.length - 1))
  const shown = all ? lines : lines.slice(0, 14)
  return (
    <div className="cc-diff mono">
      {shown.map(([k, l], i) => (
        <div key={i} className={k === '+' ? 'add' : 'del'}><span>{k}</span>{l || ' '}</div>
      ))}
      {lines.length > 14 && <button className="cc-more" onClick={() => setAll(!all)}>{all ? 'Show less' : `Show ${lines.length - 14} more lines`}</button>}
    </div>
  )
}

function Output({ text, lines = 6 }: { text: string; lines?: number }) {
  const [all, setAll] = useState(false)
  const rows = text.replace(/\s+$/, '').split('\n')
  if (!text.trim()) return null
  return (
    <div className="cc-out mono">
      <pre>{(all ? rows : rows.slice(0, lines)).join('\n')}</pre>
      {rows.length > lines && <button className="cc-more" onClick={() => setAll(!all)}>{all ? 'Show less' : `+${rows.length - lines} lines`}</button>}
    </div>
  )
}

function ToolRow({ it, cwd, pending }: { it: ChatItem; cwd: string; pending: boolean }) {
  const [open, setOpen] = useState(false)
  const kind = toolKind(it.tool)
  const a = parse(it.input) ?? {}
  const file = str(a.file_path ?? a.path ?? a.absolute_path ?? a.notebook_path)
  const rel = file && cwd && file.startsWith(cwd + '/') ? file.slice(cwd.length + 1) : file.split('/').length > 4 ? `…/${file.split('/').slice(-3).join('/')}` : file
  const cmd = Array.isArray(a.command) ? (a.command as string[]).join(' ').replace(/^bash -lc /, '') : str(a.command)
  const label = TOOL_LABEL[kind] ?? it.tool ?? 'Tool'
  const arg =
    kind === 'bash' ? str(a.description) || cmd.split('\n')[0]
    : kind === 'search' ? str(a.pattern ?? a.query ?? a.path)
    : kind === 'web' ? str(a.url ?? a.query)
    : kind === 'task' ? str(a.description ?? a.prompt).slice(0, 120)
    : kind === 'todo' ? ''
    : rel || it.text.replace(/^[^(]*\(|\)$/g, '')
  const resLines = (it.result ?? '').split('\n').filter(Boolean).length
  const summary =
    kind === 'read' && it.result ? `Read ${resLines} line${resLines === 1 ? '' : 's'}`
    : kind === 'search' && it.result ? `${resLines} result${resLines === 1 ? '' : 's'}`
    : ''
  const openFile = (): void => {
    if (!file) return
    if (cwd && file.startsWith(cwd + '/')) useStore.getState().openCode(cwd, file.slice(cwd.length + 1))
    else window.api.openPath(file)
  }
  const edits: { o: string; n: string }[] =
    kind === 'edit'
      ? Array.isArray(a.edits)
        ? (a.edits as Json[]).map((e) => ({ o: str(e.old_string), n: str(e.new_string) }))
        : [{ o: str(a.old_string ?? a.old_str), n: str(a.new_string ?? a.new_str) }]
      : []
  const todos = kind === 'todo' ? ((a.todos ?? a.plan ?? []) as Json[]) : []
  const body = (() => {
    if (kind === 'edit' && edits.some((e) => e.o || e.n)) return edits.map((e, i) => <Diff key={i} oldText={e.o} newText={e.n} />)
    if (kind === 'write' && a.content) return <Diff oldText="" newText={str(a.content).split('\n').slice(0, 200).join('\n')} />
    if (kind === 'bash')
      return (
        <div className="cc-io">
          <div className="cc-io-row"><span>IN</span><pre className="mono">{cmd}</pre></div>
          {it.result !== undefined && <div className="cc-io-row"><span>OUT</span><Output text={it.result} lines={8} /></div>}
        </div>
      )
    if (kind === 'todo' && todos.length)
      return (
        <ul className="cc-todos">
          {todos.map((t, i) => {
            const st = str(t.status)
            return <li key={i} className={st}><i>{st === 'completed' ? '✓' : st === 'in_progress' ? '▸' : '○'}</i>{str(t.content ?? t.step ?? t.title)}</li>
          })}
        </ul>
      )
    return null
  })()
  const expandable = !body && (it.input && it.input !== '{}' || it.result)
  return (
    <div className={`cc-item cc-tool ${it.error ? 'err' : ''} ${pending ? 'pending' : ''}`}>
      <div className="cc-line" onClick={() => expandable && setOpen(!open)} style={{ cursor: expandable ? 'pointer' : undefined }}>
        <b>{label}</b>
        {arg && (kind === 'read' || kind === 'edit' || kind === 'write') && file ? (
          <button className="cc-file mono" title={file} onClick={(e) => (e.stopPropagation(), openFile())}>{arg}</button>
        ) : arg ? <span className="cc-arg mono" title={arg}>{arg}</span> : null}
        {summary && <span className="cc-sum">{summary}</span>}
        {it.error && <span className="cc-errtag">error</span>}
        {expandable && <span className={`cc-chev ${open ? 'open' : ''}`}>›</span>}
      </div>
      {body}
      {it.error && it.result && !body && <Output text={it.result} lines={4} />}
      {open && expandable && (
        <div className="cc-raw">
          {it.input && it.input !== '{}' && <pre className="mono">{it.input}</pre>}
          {it.result && <Output text={it.result} lines={12} />}
        </div>
      )}
    </div>
  )
}

/** A slash command run in the CLI, with what it printed ("/model opus → Set model to …"). */
/**
 * Absolute (or ~/) image file paths written in a message. Paths may contain spaces
 * ("Application Support"), so a path runs from a "/" at a word start to the first image extension.
 */
const IMG_PATH = /(?<=^|[\s`(\[:"'*])~?\/(?:(?![ \t][/~]|, |\.[ \t])[^\n`"'<>()[\]*])*?\.(?:png|jpe?g|gif|webp)(?!\w|\.\w)/gi
export function imagePaths(text: string): string[] {
  return [...new Set(text.match(IMG_PATH) ?? [])].slice(0, 12)
}

/** An image in a message: a data: URL, or a file loaded through main. quiet = hide it if it can't be read. */
function ChatImage({ src, quiet }: { src: string; quiet?: boolean }) {
  const [url, setUrl] = useState(src.startsWith('data:') ? src : '')
  const [failed, setFailed] = useState(false)
  const [big, setBig] = useState(false)
  useEffect(() => {
    if (src.startsWith('data:')) return setUrl(src)
    let live = true
    window.api.media.readImage(src).then(
      (u) => live && (u && u !== 'data:image/png;base64,' ? setUrl(u) : setFailed(true)),
      () => live && setFailed(true)
    )
    return () => {
      live = false
    }
  }, [src])
  useEffect(() => {
    if (!big) return
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setBig(false)
    }
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [big])
  if (failed && quiet) return null
  if (failed) return <span className="cc-image-missing muted small">🖼 {src.split('/').pop()} (not found)</span>
  if (!url) return <span className="cc-image cc-image-loading" />
  return (
    <>
      <img className="cc-image" src={url} alt="" onClick={(e) => (e.stopPropagation(), setBig(true))} />
      {big && (
        <div className="cc-image-zoom" onClick={(e) => (e.stopPropagation(), setBig(false))}>
          <img src={url} alt="" />
        </div>
      )}
    </>
  )
}

function CommandRow({ it }: { it: ChatItem }) {
  return (
    <div className={`cc-item cc-cmd ${it.error ? 'err' : ''}`}>
      <div className="cc-line">
        <b className="mono">/{it.tool}</b>
        {it.text && <span className="cc-arg mono" title={it.text}>{it.text}</span>}
      </div>
      {it.result && <Output text={it.result} lines={10} />}
    </div>
  )
}

/**
 * Built-in commands like /usage, /status or /model open a dialog that exists only in the
 * TUI (nothing reaches the transcript until it closes) – show the live terminal for it.
 */
function LivePanel({ agentId, conv }: { agentId: string; conv: Conversation | null }) {
  const panel = useStore((s) => s.livePanels[agentId])
  const close = useStore((s) => s.setLivePanel)
  // the command finished and its output reached the transcript → the chat shows it now
  const done = !!panel && !!conv?.items.some((x) => x.kind === 'command' && x.tool === panel.cmd && x.result !== undefined && x.at >= panel.since - 3000)
  useEffect(() => {
    if (done) close(agentId, null)
  }, [done, agentId, close])
  if (!panel || done) return null
  return (
    <div className="cc-live">
      <div className="cc-live-head">
        <b className="mono">/{panel.cmd}</b>
        <span className="muted small">live from the terminal – use the keyboard here</span>
        <div className="spacer" />
        <button className="btn ghost sm" title="Send Esc to close the dialog" onClick={() => {
          window.api.input(agentId, '\x1b')
          close(agentId, null)
        }}>Esc</button>
        <button className="icon-btn" title="Hide" onClick={() => close(agentId, null)}><Icon name="x" size={12} /></button>
      </div>
      <div className="cc-live-term"><Terminal agentId={agentId} autoFocus /></div>
    </div>
  )
}

/** A question the CLI asks in the terminal before the session starts ("trust this folder?") – answered from the chat. */
function AskCard({ agentId }: { agentId: string }) {
  const ask = useStore((s) => s.runtimes[agentId]?.ask)
  const cwd = useStore((s) => {
    const a = s.app.agents.find((x) => x.id === agentId)
    return a?.worktreePath ?? s.app.projects.find((p) => p.id === a?.projectId)?.path ?? ''
  })
  const [busy, setBusy] = useState(false)
  useEffect(() => setBusy(false), [ask?.question])
  if (!ask) return null
  const answer = (yes: boolean): void => {
    setBusy(true)
    void window.api.answerAsk(agentId, yes)
  }
  return (
    <div className="cc-ask">
      <div className="cc-ask-head"><Icon name="lock" size={14} /> <b>Claude Code is waiting for you</b></div>
      <p>{ask.question}</p>
      {cwd && <p className="mono small muted">{cwd}</p>}
      <p className="muted small">Only trust folders whose code you know – Claude Code may run commands and read files there. Your first message is sent after you answer.</p>
      <div className="cc-ask-btns">
        <button className="btn" disabled={busy} onClick={() => answer(true)}>Yes, trust this folder</button>
        <button className="btn ghost" disabled={busy} onClick={() => answer(false)}>No, exit</button>
      </div>
    </div>
  )
}

/** The agent's session as a conversation – styled like Claude Code in VS Code. */
export function ChatView({ agentId, conv }: { agentId: string; conv: (Conversation & { none?: boolean }) | null }) {
  const end = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const agent = useStore((s) => s.app.agents.find((a) => a.id === agentId))
  const status = useStore((s) => s.runtimes[agentId]?.status)
  const activity = useStore((s) => s.lastLines[agentId])
  const [cwd, setCwd] = useState('')
  const [speaking, setSpeaking] = useState<number | null>(null)
  useEffect(() => () => window.speechSynthesis?.cancel(), [])
  useEffect(() => {
    window.api.agentCwd(agentId).then(setCwd).catch(() => undefined)
  }, [agentId])
  const items = conv?.items ?? []
  const rendered = useMemo(() => items.map((it) => (it.kind === 'tool' || it.kind === 'command' ? '' : markPaths(html(it.text)))), [items])
  // image files named in the text ("Screenshot: /…/qa-shots/x.png") show as pictures too
  const named = useMemo(() => items.map((it) => (it.kind === 'user' || it.kind === 'assistant' ? imagePaths(it.text).filter((p) => !it.images?.includes(p)) : [])), [items])
  useEffect(() => {
    if (stick.current) end.current?.scrollIntoView({ block: 'end' })
  }, [items.length, status])

  if (!agent || !['claude', 'codex', 'gemini'].includes(agent.providerId))
    return <div className="chat-empty muted">The conversation view reads Claude Code, Codex and Gemini sessions. Use the terminal for {agent?.name ?? 'this agent'}.</div>
  if (!conv) return <div className="chat-empty muted">Loading conversation…</div>
  if (conv.none || !items.length)
    return (
      <div className="chat-wrap">
        <div className="chat-empty">
          <div className="cc-hello">
            <b>{agent.name}</b>
            <span className="muted">{agent.role} · {agent.providerId === 'claude' ? 'Claude Code' : agent.providerId === 'codex' ? 'Codex' : 'Gemini'}</span>
            <p className="muted small">Ask for a change below – the conversation shows up here.</p>
          </div>
        </div>
        <AskCard agentId={agentId} />
        <AskCard agentId={agentId} />
    <LivePanel agentId={agentId} conv={conv} />
      </div>
    )
  const lastUser = items.map((x) => x.kind).lastIndexOf('user')
  const working = status === 'working'

  return (
    <div className="chat-wrap">
    <div className="cc" onClick={(e) => linkClick(e, cwd)} onScroll={(e) => {
      const el = e.currentTarget
      stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    }}>
      <div className="cc-col">
        {items.map((it, i) =>
          it.kind === 'user' ? (
            <div key={i} className="cc-user">
              {it.text && <div className="md-body chat-body" dangerouslySetInnerHTML={{ __html: rendered[i] }} />}
              {it.images?.length || named[i].length ? (
                <div className="cc-images">
                  {(it.images ?? []).map((src, k) => <ChatImage key={k} src={src} />)}
                  {named[i].map((src) => <ChatImage key={src} src={src} quiet />)}
                </div>
              ) : null}
              {it.at ? <time>{new Date(it.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time> : null}
            </div>
          ) : it.kind === 'command' ? (
            <CommandRow key={i} it={it} />
          ) : it.kind === 'tool' ? (
            <ToolRow key={i} it={it} cwd={cwd} pending={working && i > lastUser && it.result === undefined && i === items.length - 1} />
          ) : (
            <div key={i} className="cc-item cc-text">
              <div className="md-body chat-body" dangerouslySetInnerHTML={{ __html: rendered[i] }} />
              {named[i].length ? (
                <div className="cc-images">
                  {named[i].map((src) => <ChatImage key={src} src={src} quiet />)}
                </div>
              ) : null}
              <button className={`icon-btn chat-speak ${speaking === i ? 'on' : ''}`} title={speaking === i ? 'Stop reading' : 'Read aloud'} onClick={() => {
                if (speaking === i) {
                  window.speechSynthesis?.cancel()
                  setSpeaking(null)
                } else {
                  setSpeaking(i)
                  speak(it.text, () => setSpeaking((x) => (x === i ? null : x)))
                }
              }}><Icon name="volume" size={12} /></button>
            </div>
          )
        )}
        {working && (
          <div className="cc-working">
            <span className="cc-spark">✻</span>
            <span className="shimmer">{(() => {
              const t = (activity ?? '').replace(/^[\s✻✽✢✳∗*·●•⏺>]+/, '').trim()
              return t && !/^(Working|Thinking)/i.test(t) && !/ready$/i.test(t) ? t : 'Working…'
            })()}</span>
          </div>
        )}
        {status === 'waiting' && items[items.length - 1]?.kind !== 'user' && <div className="cc-turn muted small">Waiting for your reply</div>}
        <div ref={end} />
      </div>
    </div>
    <LivePanel agentId={agentId} conv={conv} />
    </div>
  )
}
