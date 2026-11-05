import { useEffect, useRef, useState } from 'react'
import { Marked } from 'marked'
import DOMPurify from 'dompurify'
import { useStore } from '../store'
import { Icon, cleanError } from './common'
import { agentRoot, linkClick } from '../links'
import { Character } from './Character'

const md = new Marked({ gfm: true, breaks: true })

/** Read-only question to a copy of the agent's conversation – the agent itself is not interrupted. */
export function AskBubble() {
  const target = useStore((s) => s.askTarget)
  const agent = useStore((s) => s.app.agents.find((a) => a.id === s.askTarget))
  const [q, setQ] = useState('')
  const [a, setA] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    setQ('')
    setA(null)
    setTimeout(() => ref.current?.focus(), 30)
  }, [target])
  if (!agent) return null
  const close = (): void => useStore.setState({ askTarget: null })
  const ask = async (): Promise<void> => {
    if (!q.trim() || busy) return
    setBusy(true)
    setA(null)
    try {
      setA(await window.api.askAgent(agent.id, q.trim()))
    } catch (e) {
      setA(`⚠️ ${cleanError(e)}`)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="backdrop" onMouseDown={close}>
      <div className="modal ask" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <Character head seed={agent.id} color={agent.color} status="idle" size={30} />
          <div>
            <h2>Ask {agent.name}</h2>
            <p className="muted small">A side question to a copy of its conversation – {agent.name} keeps working, nothing is changed.</p>
          </div>
        </div>
        <textarea ref={ref} rows={3} value={q} placeholder="e.g. Why did you choose that approach? Which files are left?" onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              ask()
            }
            if (e.key === 'Escape') close()
          }} />
        {busy && <div className="ask-wait"><span className="dots"><i /><i /><i /></span> Thinking with {agent.name}'s context…</div>}
        {a && <div className="md-body ask-answer" onClick={(e) => linkClick(e, () => agentRoot(agent.id))} dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(md.parse(a, { async: false }) as string) }} />}
        <div className="modal-foot">
          <button className="btn ghost" onClick={close}>Close</button>
          <button className="btn" disabled={!q.trim() || busy} onClick={ask}><Icon name="bubble" size={14} /> Ask</button>
        </div>
      </div>
    </div>
  )
}

/** Switch a running agent's role (PM → Dev → QA…) without losing the session. */
export function MorphMenu() {
  const t = useStore((s) => s.morphTarget)
  const agent = useStore((s) => s.app.agents.find((a) => a.id === s.morphTarget?.agentId))
  const roles = useStore((s) => s.app.roles)
  const [custom, setCustom] = useState('')
  if (!t || !agent) return null
  const close = (): void => useStore.setState({ morphTarget: null })
  const pick = (role: string): void => {
    close()
    window.api
      .morphAgent(agent.id, role)
      .then(() => useStore.getState().toast(`${agent.name} is now ${role}`, 'success'))
      .catch((e) => useStore.getState().toast(cleanError(e), 'error'))
  }
  return (
    <div className="ctx-layer" onMouseDown={close}>
      <div className="ctx morph" style={{ left: Math.min(t.x, window.innerWidth - 280), top: Math.min(t.y, window.innerHeight - 420) }} onMouseDown={(e) => e.stopPropagation()}>
        <div className="ctx-head"><Icon name="restart" size={14} /><div><b>Change role</b><small>keeps the conversation{agent.roleLog?.length ? ` · ${agent.roleLog.length} change${agent.roleLog.length > 1 ? 's' : ''} so far` : ''}</small></div></div>
        {roles.map((r) => (
          <button key={r.id} className={`ctx-item ${r.name === agent.role ? 'on' : ''}`} onClick={() => pick(r.name)}>
            <i className="dot" style={{ background: r.color }} />
            <span>{r.name}</span>
            {r.name === agent.role && <Icon name="check" size={13} />}
          </button>
        ))}
        <div className="ctx-sep" />
        <form className="morph-custom" onSubmit={(e) => (e.preventDefault(), custom.trim() && pick(custom.trim()))}>
          <input placeholder="Other role…" value={custom} onChange={(e) => setCustom(e.target.value)} />
        </form>
        {agent.roleLog?.length ? (
          <div className="morph-log">
            {agent.roleLog.slice(-4).reverse().map((l, i) => (
              <span key={i}>{new Date(l.at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })} · {l.from} → {l.to}</span>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  )
}
