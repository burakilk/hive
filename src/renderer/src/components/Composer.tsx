import { useEffect, useRef, useState } from 'react'
import { PromptPicker, promptFor, sendPrompt } from './Library'
import { FigmaButton } from './More'
import { useStore } from '../store'
import { useLayout } from '../layout'
import { Recorder } from '../dictation'
import { Icon, cleanError } from './common'
import { SketchEditor } from './Sketch'
import { BUILTIN_SLASH, matchSlash, type SlashCommand } from './slashCommands'

type Shot = { path: string; dataUrl: string }

/** Prompt box: send / queue, prompt library, screenshots & images, dictation, prompt enhancer. */
export function Composer({ agentId, compact }: { agentId: string; compact?: boolean }) {
  const draftKey = (id: string): string => `hive.draft.${id}`
  const [text, setText] = useState(() => {
    try {
      return localStorage.getItem(draftKey(agentId)) ?? ''
    } catch {
      return ''
    }
  })
  // unsent text survives switching agents and restarting Hive
  const firstDraft = useRef(true)
  useEffect(() => {
    if (firstDraft.current) {
      firstDraft.current = false
      return
    }
    try {
      setText(localStorage.getItem(draftKey(agentId)) ?? '')
    } catch {
      setText('')
    }
  }, [agentId]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    try {
      if (text.trim()) localStorage.setItem(draftKey(agentId), text)
      else localStorage.removeItem(draftKey(agentId))
    } catch {
      /* storage unavailable */
    }
  }, [text]) // eslint-disable-line react-hooks/exhaustive-deps
  const [shots, setShots] = useState<Shot[]>([])
  const [files, setFiles] = useState<{ path: string; name: string }[]>([])
  const attachPaths = (paths: string[]): void =>
    setFiles((x) => [...x, ...paths.filter((p) => !x.some((f) => f.path === p)).map((p) => ({ path: p, name: p.split(/[\\/]/).pop() || p }))])
  const [picker, setPicker] = useState<{ x: number; y: number } | null>(null)
  const [rec, setRec] = useState<'idle' | 'rec' | 'busy'>('idle')
  const [level, setLevel] = useState(0)
  const [enhancing, setEnhancing] = useState(false)
  const [undo, setUndo] = useState<string | null>(null)
  const [sketch, setSketch] = useState<{ i: number; src: string } | null>(null)
  const recorder = useRef<Recorder | null>(null)
  const ta = useRef<HTMLTextAreaElement>(null)
  const agent = useStore((s) => s.app.agents.find((a) => a.id === agentId))
  const rt = useStore((s) => s.runtimes[agentId])
  const queueWhenBusy = useStore((s) => s.app.settings.queueWhenBusy)
  const insert = useStore((s) => s.composerInsert)
  const pending = useStore((s) => s.pendingShots)
  const toast = useStore((s) => s.toast)
  const running = !!rt?.running
  const busy = running && rt?.status === 'working'

  // "/" menu: the CLI's built-in commands plus custom commands / skills / prompts
  const [custom, setCustom] = useState<SlashCommand[]>([])
  const [slashSel, setSlashSel] = useState(0)
  const [slashOff, setSlashOff] = useState(false)
  const slashList = useRef<HTMLDivElement>(null)
  useEffect(() => {
    setCustom([])
    window.api.slashCommands(agentId).then(setCustom).catch(() => undefined)
  }, [agentId, agent?.providerId])
  const slashQ = text.match(/^\/(\S*)$/)?.[1]
  const slashItems = slashQ === undefined || slashOff ? [] : matchSlash([...custom, ...(BUILTIN_SLASH[agent?.providerId ?? ''] ?? [])], slashQ).slice(0, 60)
  const slashOpen = slashItems.length > 0
  useEffect(() => setSlashSel(0), [slashQ])
  useEffect(() => {
    if (!text.startsWith('/')) setSlashOff(false)
  }, [text])
  useEffect(() => {
    slashList.current?.querySelector('.on')?.scrollIntoView({ block: 'nearest' })
  }, [slashSel])
  const pickSlash = (c: SlashCommand, run: boolean): void => {
    if (run) void send('auto', `/${c.name}`)
    else {
      setText(`/${c.name} `)
      ta.current?.focus()
    }
  }

  // ⌘⇧2 screenshots and ⌘K "insert prompt" land in the visible composer
  useEffect(() => {
    if (pending.length) setShots((s) => [...s, ...useStore.getState().takeShots()])
  }, [pending])
  useEffect(() => {
    if (!insert) return
    setText((t) => (t.trim() ? `${t}\n\n${insert.text}` : insert.text))
    ta.current?.focus()
  }, [insert])

  const message = (override?: string): string => {
    const t = (override ?? text).trim()
    const att = shots.map((s) => `[Screenshot: ${s.path}]`).join('\n')
    const fl = files.map((f) => `[File: ${f.path}]`).join('\n')
    return [
      t,
      att && `${att}\n(Look at the attached image file${shots.length > 1 ? 's' : ''}.)`,
      fl && `${fl}\n(Read the attached file${files.length > 1 ? 's' : ''}.)`
    ].filter(Boolean).join('\n\n')
  }

  const send = async (mode: 'auto' | 'queue' = 'auto', override?: string): Promise<void> => {
    const m = message(override)
    if (!m) return
    // built-in commands draw their output (dialogs, pickers, /usage…) only in the TUI –
    // in the conversation view show the live terminal for them until they finish
    const cmd = m.match(/^\/([\w:-]+)\s*$|^\/([\w:-]+)\s/)
    const name = cmd?.[1] ?? cmd?.[2]
    const builtin = !!name && (BUILTIN_SLASH[agent?.providerId ?? ''] ?? []).some((c) => c.name === name) && !custom.some((c) => c.name === name)
    const st = useStore.getState()
    const chatMode = useLayout.getState().focusMode === 'chat'
    try {
      if (!running) {
        await window.api.startAgent(agentId, false)
        await window.api.queue.add(agentId, m)
        toast(`Starting ${agent?.name} – your message is sent when it is ready`, 'info')
      } else if (mode === 'queue' || (busy && queueWhenBusy)) {
        await window.api.queue.add(agentId, m)
      } else {
        // a dialog is still open in the TUI – close it first or the text lands in the dialog
        const panelOpen = !!st.livePanels[agentId] && !busy
        if (panelOpen) window.api.input(agentId, '\x1b')
        st.setLivePanel(agentId, builtin && chatMode ? name! : null)
        const type = (): void => {
          // bracketed paste keeps multi-line prompts in one message for TUIs like Claude Code
          window.api.input(agentId, m.includes('\n') ? `\x1b[200~${m}\x1b[201~` : m)
          setTimeout(() => window.api.input(agentId, '\r'), 80)
        }
        if (panelOpen) setTimeout(type, 150)
        else type()
      }
      setText('')
      setShots([])
      setFiles([])
      setUndo(null)
    } catch (e) {
      toast(cleanError(e), 'error')
    }
  }

  const screenshot = async (): Promise<void> => {
    const s = await window.api.media.screenshot().catch((e) => (toast(cleanError(e), 'error'), null))
    if (s) setShots((x) => [...x, s])
  }

  /** images become thumbnails (you can draw on them); any other file is attached by its path */
  const addFiles = async (list: FileList | File[]): Promise<boolean> => {
    let any = false
    for (const f of Array.from(list)) {
      any = true
      try {
        if (f.type.startsWith('image/') && f.type !== 'image/svg+xml') {
          const a = await window.api.media.saveImage(new Uint8Array(await f.arrayBuffer()), f.type.split('/')[1] || 'png')
          setShots((x) => [...x, a])
          continue
        }
        const p = window.api.media.pathForFile(f)
        if (p) attachPaths([p])
        else {
          const saved = await window.api.media.saveFile(new Uint8Array(await f.arrayBuffer()), f.name || 'file')
          setFiles((x) => [...x, saved])
        }
      } catch (e) {
        toast(`${f.name}: ${cleanError(e)}`, 'error')
      }
    }
    return any
  }

  const pickFiles = async (): Promise<void> => {
    const paths = await window.api.media.pickFiles().catch((e) => (toast(cleanError(e), 'error'), [] as string[]))
    if (paths.length) attachPaths(paths)
    ta.current?.focus()
  }

  const mic = async (): Promise<void> => {
    if (rec === 'busy') return
    if (rec === 'idle') {
      try {
        recorder.current = new Recorder()
        await recorder.current.start(setLevel)
        setRec('rec')
      } catch (e) {
        toast(cleanError(e), 'error')
      }
      return
    }
    setRec('busy')
    try {
      const said = await recorder.current!.stop()
      if (said) setText((t) => (t.trim() ? `${t.trimEnd()} ${said}` : said))
      ta.current?.focus()
    } catch (e) {
      toast(cleanError(e), 'error')
    } finally {
      setRec('idle')
      setLevel(0)
    }
  }
  useEffect(() => () => recorder.current?.cancel(), [])

  const enhance = async (): Promise<void> => {
    if (!text.trim() || enhancing) return
    setEnhancing(true)
    try {
      const better = await window.api.enhancePrompt(text, agentId)
      setUndo(text)
      setText(better)
    } catch (e) {
      toast(`Prompt enhancer: ${cleanError(e)}`, 'error')
    } finally {
      setEnhancing(false)
    }
  }

  // stop what the agent is doing right now (same as Esc in the CLI); the conversation stays
  // queued messages are put on hold too, so the next one doesn't go out right after you stopped it
  const interrupt = (): void => {
    window.api.input(agentId, '\x1b')
    if (queue.length && !held) void window.api.queue.edit(agentId, { hold: true })
    toast(queue.length ? `Stopping ${agent?.name ?? 'the agent'} – queue on hold` : `Stopping ${agent?.name ?? 'the agent'}…`, 'info')
  }

  // a stopped agent keeps its unsent messages (from the runtime, or stored on the agent after a restart of Hive)
  const queue = (rt?.running ? rt.queue : rt?.queue ?? agent?.queue) ?? []
  const held = !!(rt?.running ? rt.queueHeld : rt?.queueHeld ?? agent?.queueHeld)
  return (
    <div className={`composer ${compact ? 'compact' : ''}`}
      onDragOver={(e) => e.dataTransfer.types.includes('Files') && e.preventDefault()}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return
        e.preventDefault()
        addFiles(e.dataTransfer.files)
      }}>
      {queue.length > 0 && (
        <div className="queue">
          <div className="queue-head">
            <Icon name={held ? 'pause' : 'list'} size={12} />
            {held ? <>On hold · nothing is sent until you resume</>
              : running ? <>Queued · sent one by one when {agent?.name} is free</>
              : <>Queued · sent when {agent?.name} starts again</>}
            <div className="spacer" />
            {held && <button className="link-btn" onClick={() => window.api.queue.edit(agentId, { hold: false })}><Icon name="play" size={11} /> Resume</button>}
            {!held && running && <button className="link-btn" title="Don't send these for now" onClick={() => window.api.queue.edit(agentId, { hold: true })}>Hold</button>}
            <button className="link-btn" onClick={() => window.api.queue.edit(agentId, { clear: true })}>Clear</button>
          </div>
          {queue.map((q, i) => (
            <div key={q.id} className="queue-item">
              <span className="qn">{i + 1}</span>
              <span className="qt" title={q.text}>{q.text}</span>
              {i > 0 && <button className="icon-btn" title="Move up" onClick={() => window.api.queue.edit(agentId, { up: q.id })}><Icon name="chevronUp" size={12} /></button>}
              <button className="icon-btn" title="Send now" onClick={() => window.api.queue.edit(agentId, { sendNow: q.id })}><Icon name="send" size={12} /></button>
              <button className="icon-btn" title="Remove" onClick={() => window.api.queue.edit(agentId, { remove: q.id })}><Icon name="x" size={12} /></button>
            </div>
          ))}
        </div>
      )}
      {sketch && (
        <SketchEditor src={sketch.src} onClose={() => setSketch(null)} onSave={async (png) => {
          const a = await window.api.media.saveImage(png, 'png')
          setShots((x) => x.map((s, j) => (j === sketch.i ? a : s)))
          setSketch(null)
        }} />
      )}
      {files.length > 0 && (
        <div className="att-files">
          {files.map((f) => (
            <span key={f.path} className="att-file" title={f.path}>
              <Icon name="paperclip" size={11} />
              <span className="att-name">{f.name}</span>
              <button title="Remove" onClick={() => setFiles((x) => x.filter((y) => y.path !== f.path))}><Icon name="x" size={10} /></button>
            </span>
          ))}
        </div>
      )}
      {shots.length > 0 && (
        <div className="shots">
          {shots.map((s, i) => (
            <div key={s.path} className="shot" title="Click to draw on it">
              <img src={s.dataUrl} alt="" onClick={async () => setSketch({ i, src: await window.api.media.readImage(s.path) })} />
              <button onClick={() => setShots(shots.filter((_, j) => j !== i))}><Icon name="x" size={11} /></button>
            </div>
          ))}
        </div>
      )}
      {slashOpen && (
        <div className="slash-menu" ref={slashList} onMouseDown={(e) => e.preventDefault()}>
          {slashItems.map((c, i) => (
            <button key={`${c.source}:${c.name}`} className={`slash-item ${i === slashSel ? 'on' : ''}`} onMouseEnter={() => setSlashSel(i)} onClick={() => pickSlash(c, true)}>
              <b className="mono">/{c.name}</b>
              <span className="slash-desc">{c.desc}</span>
              {c.source !== 'built-in' && <span className="slash-src">{c.source}</span>}
            </button>
          ))}
          <div className="slash-hint">↑↓ choose · Enter run · Tab add arguments · Esc close</div>
        </div>
      )}
      <textarea
        ref={ta}
        rows={compact ? 2 : 3}
        value={text}
        placeholder={
          !running
            ? 'Agent is stopped – type a task and press Enter to start it with that task'
            : busy && queueWhenBusy
              ? `${agent?.name} is working – Enter adds to the queue, ⌘Enter sends right away`
              : 'Give your agent a prompt or task: Enter to send, Shift+Enter for a new line'
        }
        onChange={(e) => setText(e.target.value)}
        onPaste={async (e) => {
          const pasted = Array.from(e.clipboardData.files)
          // pasted files (images or anything copied in Finder); plain text pastes as usual
          if (pasted.length) {
            e.preventDefault()
            await addFiles(pasted)
          }
        }}
        onKeyDown={(e) => {
          if (slashOpen && !e.nativeEvent.isComposing) {
            const n = slashItems.length
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault()
              setSlashSel((i) => (i + (e.key === 'ArrowDown' ? 1 : n - 1)) % n)
              return
            }
            if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
              e.preventDefault()
              const c = slashItems[Math.min(slashSel, n - 1)]
              // Enter runs the command, Tab completes it so you can add arguments
              pickSlash(c, e.key === 'Enter')
              return
            }
            if (e.key === 'Escape') {
              e.preventDefault()
              setSlashOff(true)
              return
            }
          }
          if (e.key === 'Escape' && busy && !text.trim() && !shots.length && !files.length) {
            e.preventDefault()
            interrupt()
            return
          }
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            if ((e.metaKey || e.ctrlKey) && running) {
              const m = message()
              if (m) {
                window.api.input(agentId, m.includes('\n') ? `\x1b[200~${m}\x1b[201~` : m)
                setTimeout(() => window.api.input(agentId, '\r'), 80)
                setText('')
                setShots([])
                setFiles([])
              }
            } else send()
          }
        }}
      />
      <div className="composer-bar">
        <button className="btn ghost sm" title="Prompt library" onClick={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
          setPicker({ x: r.left, y: r.top - 430 })
        }}>
          <Icon name="book" size={13} /> {compact ? '' : 'Prompts'}
        </button>
        {picker && agent && (
          <PromptPicker style={{ left: picker.x, top: Math.max(10, picker.y) }} onClose={() => setPicker(null)}
            onPick={(p, now) => {
              setPicker(null)
              if (now) sendPrompt([agent], p.body)
              else setText(promptFor(p.body, agent))
            }} />
        )}
        <button className="icon-btn" title="Attach files – or drop / paste them into the box" onClick={pickFiles}>
          <Icon name="paperclip" size={15} />
        </button>
        <button className="icon-btn" title="Attach a screenshot (⌘⇧2 works anywhere) – or paste / drop an image" onClick={screenshot}>
          <Icon name="camera" size={15} />
        </button>
        <FigmaButton />
        <button className={`icon-btn mic ${rec}`} title={rec === 'rec' ? 'Stop & transcribe' : 'Dictate'} onClick={mic}
          style={rec === 'rec' ? { ['--lvl' as string]: level } : undefined}>
          <Icon name={rec === 'busy' ? 'refresh' : 'mic'} size={15} />
        </button>
        <button className={`icon-btn ${enhancing ? 'spin' : ''}`} disabled={!text.trim() || enhancing} title="Enhance prompt (goal, context, constraints, done when)" onClick={enhance}>
          <Icon name="sparkle" size={15} />
        </button>
        {undo !== null && (
          <button className="link-btn" onClick={() => (setText(undo), setUndo(null))}>Undo enhance</button>
        )}
        {running && (
          <>
            <button className="icon-btn" title="Send Esc (interrupt the agent)" onClick={() => window.api.input(agentId, '\x1b')}><span className="kbd">esc</span></button>
            {!compact && <button className="icon-btn" title="Send Ctrl+C" onClick={() => window.api.input(agentId, '\x03')}><span className="kbd">^C</span></button>}
          </>
        )}
        <div className="spacer" />
        {running && busy && (
          <button className="btn ghost sm" disabled={!text.trim() && !shots.length && !files.length} title="Add to queue" onClick={() => send('queue')}>
            <Icon name="list" size={13} /> Queue
          </button>
        )}
        {busy && (
          <button className="send stop" title="Stop – cancel what the agent is doing now (Esc). The conversation is kept." onClick={interrupt}>
            <Icon name="stop" size={14} />
          </button>
        )}
        <button className="send" disabled={!text.trim() && !shots.length && !files.length} onClick={() => send()} title={running ? 'Send' : 'Start with this task'}>
          <Icon name={running ? 'send' : 'play'} size={16} />
        </button>
      </div>
    </div>
  )
}
