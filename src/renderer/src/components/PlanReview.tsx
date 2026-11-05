import { useEffect, useMemo, useState } from 'react'
import { Marked } from 'marked'
import DOMPurify from 'dompurify'
import { useStore } from '../store'
import { Icon, cleanError } from './common'
import { agentRoot, linkClick } from '../links'
import { Character } from './Character'

const md = new Marked({ gfm: true, breaks: true })
const html = (s: string): string => DOMPurify.sanitize(md.parse(s, { async: false }) as string)

interface Step {
  text: string
  /** headings and plain paragraphs are shown but not individually editable */
  kind: 'step' | 'head' | 'text'
  removed: boolean
  comment: string
  edited: boolean
  /** position in the original plan (steps only) */
  orig?: number
  added?: boolean
}

/** split a markdown plan into reviewable steps (list items) */
function parse(plan: string): Step[] {
  const out: Step[] = []
  let para: string[] = []
  const flush = (): void => {
    if (para.join('').trim()) out.push({ text: para.join('\n'), kind: 'text', removed: false, comment: '', edited: false })
    para = []
  }
  for (const line of plan.split('\n')) {
    if (/^\s*#{1,6}\s/.test(line)) {
      flush()
      out.push({ text: line.replace(/^\s*#+\s*/, ''), kind: 'head', removed: false, comment: '', edited: false })
    } else if (/^\s*([-*+]|\d+[.)])\s+/.test(line) && !/^\s{4,}/.test(line)) {
      flush()
      out.push({ text: line.replace(/^\s*([-*+]|\d+[.)])\s+/, ''), kind: 'step', removed: false, comment: '', edited: false })
    } else if (/^\s{2,}\S/.test(line) && out.length && out[out.length - 1].kind === 'step' && !para.length) {
      out[out.length - 1].text += '\n' + line.trim()
    } else para.push(line)
  }
  flush()
  return out
}

/** Review an agent's plan (Claude plan mode): comment, edit, remove steps, then approve or send back. */
export function PlanReviewModal() {
  const id = useStore((s) => s.planOpen)
  const plan = useStore((s) => (s.planOpen ? s.plans[s.planOpen] : undefined))
  const agent = useStore((s) => s.app.agents.find((a) => a.id === s.planOpen))
  const [steps, setSteps] = useState<Step[]>([])
  const [general, setGeneral] = useState('')
  const [editing, setEditing] = useState<number | null>(null)
  useEffect(() => {
    if (plan) {
      let k = 0
      setSteps(parse(plan.plan).map((x) => (x.kind === 'step' ? { ...x, orig: k++ } : x)))
    }
    setGeneral('')
    setEditing(null)
  }, [plan])
  const order = steps.filter((s) => s.kind === 'step' && !s.added).map((s) => s.orig)
  const moved = order.some((o, i) => o !== i)
  const changed = useMemo(() => moved || general.trim() !== '' || steps.some((s) => s.removed || s.comment.trim() || s.edited || s.added), [steps, general, moved])
  if (!id || !plan || !agent) return null
  const close = (): void => useStore.setState({ planOpen: null })
  const patch = (i: number, p: Partial<Step>): void => setSteps(steps.map((s, j) => (j === i ? { ...s, ...p } : s)))
  const move = (i: number, dir: -1 | 1): void => {
    let j = i + dir
    while (j >= 0 && j < steps.length && steps[j].kind !== 'step') j += dir
    if (j < 0 || j >= steps.length) return
    const next = [...steps]
    ;[next[i], next[j]] = [next[j], next[i]]
    setSteps(next)
  }
  const addAfter = (i: number): void => {
    const next = [...steps]
    next.splice(i + 1, 0, { text: '', kind: 'step', removed: false, comment: '', edited: true, added: true })
    setSteps(next)
    setEditing(i + 1)
  }
  const decide = (d: 'approve' | 'revise'): void => {
    let feedback = ''
    if (d === 'revise') {
      const notes = steps
        .map((s, i) => ({ s, n: i + 1 }))
        .filter(({ s }) => s.kind === 'step' && (s.removed || s.comment.trim() || s.edited) && !(s.added && !s.text.trim()))
        .map(({ s }) => (s.removed ? `- REMOVE: “${s.text}”` : s.added ? `- ADD a step: “${s.text}”${s.comment ? ` (${s.comment})` : ''}` : s.edited ? `- CHANGE to: “${s.text}”${s.comment ? ` (${s.comment})` : ''}` : `- “${s.text}”: ${s.comment}`))
      const live = steps.filter((s) => s.kind === 'step' && !s.removed && s.text.trim())
      const reorder = moved || steps.some((s) => s.added) ? `Use this order of steps:\n${live.map((s, i) => `${i + 1}. ${s.text.split('\n')[0]}`).join('\n')}` : ''
      feedback = [general.trim(), notes.length ? `Step notes:\n${notes.join('\n')}` : '', reorder].filter(Boolean).join('\n\n')
    }
    window.api.automation
      .decidePlan(agent.id, d, feedback)
      .then(() => useStore.getState().toast(d === 'approve' ? `Plan approved – ${agent.name} starts working` : `Sent back to ${agent.name}`, 'success'))
      .catch((e) => useStore.getState().toast(cleanError(e), 'error'))
    close()
  }
  let n = 0
  return (
    <div className="backdrop" onMouseDown={close}>
      <div className="modal plan-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <Character head seed={agent.id} color={agent.color} status="waiting" size={32} />
          <div>
            <h2>{agent.name}'s plan</h2>
            <p className="muted small">Comment on steps, edit, reorder, add or remove them, then approve – or send it back with your notes.</p>
          </div>
        </div>
        <div className="plan-steps" onClick={(e) => linkClick(e, () => agentRoot(agent.id))}>
          {steps.map((s, i) =>
            s.kind === 'head' ? (
              <h3 key={i}>{s.text}</h3>
            ) : s.kind === 'text' ? (
              <div key={i} className="md-body plan-text" dangerouslySetInnerHTML={{ __html: html(s.text) }} />
            ) : (
              <div key={i} className={`plan-step ${s.removed ? 'removed' : ''} ${s.comment.trim() || s.edited ? 'noted' : ''}`}>
                <span className="ps-n">{++n}</span>
                <div className="ps-main">
                  {editing === i ? (
                    <textarea autoFocus rows={2} value={s.text} onChange={(e) => patch(i, { text: e.target.value, edited: true })} onBlur={() => setEditing(null)} />
                  ) : (
                    <div className="md-body ps-text" onDoubleClick={() => setEditing(i)} dangerouslySetInnerHTML={{ __html: html(s.text) }} />
                  )}
                  {(s.comment || editing === -i - 1) && (
                    <input className="ps-comment" autoFocus placeholder="Your comment on this step…" value={s.comment} onChange={(e) => patch(i, { comment: e.target.value })} />
                  )}
                </div>
                <div className="ps-actions">
                  <button className="icon-btn" title="Move up" onClick={() => move(i, -1)}><Icon name="chevronUp" size={13} /></button>
                  <button className="icon-btn" title="Move down" onClick={() => move(i, 1)}><span style={{ display: 'inline-flex', transform: 'rotate(180deg)' }}><Icon name="chevronUp" size={13} /></span></button>
                  <button className="icon-btn" title="Add a step after this one" onClick={() => addAfter(i)}><Icon name="plus" size={13} /></button>
                  <button className="icon-btn" title="Comment" onClick={() => setEditing(-i - 1)}><Icon name="message" size={13} /></button>
                  <button className="icon-btn" title="Edit step" onClick={() => setEditing(i)}><Icon name="edit" size={13} /></button>
                  <button className={`icon-btn ${s.removed ? 'on' : ''}`} title={s.removed ? 'Keep step' : 'Remove step'} onClick={() => patch(i, { removed: !s.removed })}>
                    <Icon name={s.removed ? 'undo' : 'trash'} size={13} />
                  </button>
                </div>
              </div>
            )
          )}
        </div>
        <textarea rows={2} placeholder="Overall feedback (optional)…" value={general} onChange={(e) => setGeneral(e.target.value)} />
        <div className="modal-foot">
          <span className="muted small">{new Date(plan.at).toLocaleTimeString()}</span>
          <div className="spacer" />
          <button className="btn ghost" onClick={close}>Later</button>
          <button className="btn ghost" disabled={!changed} onClick={() => decide('revise')}><Icon name="undo" size={14} /> Send back</button>
          <button className="btn approve" disabled={changed} title={changed ? 'You have notes – send them back first' : ''} onClick={() => decide('approve')}><Icon name="check" size={14} /> Approve</button>
        </div>
      </div>
    </div>
  )
}

/** "Plan ready" banner + tests chip shown in the agent header area. */
export function AgentSignals({ agentId }: { agentId: string }) {
  const plan = useStore((s) => s.plans[agentId])
  const test = useStore((s) => s.tests[agentId])
  const testing = useStore((s) => s.testing[agentId])
  const allConflicts = useStore((s) => s.conflicts)
  const conflicts = allConflicts.filter((c) => c.agentIds.includes(agentId))
  const agents = useStore((s) => s.app.agents)
  const [showTest, setShowTest] = useState(false)
  if (!plan && !test && !testing && !conflicts.length) return null
  return (
    <div className="signals">
      {plan && (
        <button className="signal plan" onClick={() => useStore.setState({ planOpen: agentId })}>
          <Icon name="list" size={13} /> Plan ready for review <b>Open</b>
        </button>
      )}
      {(testing || test) && (
        <button className={`signal test ${testing ? 'run' : test?.ok ? 'ok' : 'bad'}`} onClick={() => setShowTest(!showTest)}>
          <Icon name={testing ? 'refresh' : test?.ok ? 'check' : 'x'} size={13} />
          {testing ? 'Running tests…' : test?.ok ? 'Tests pass' : `Tests failed${test?.sentBack ? ' – sent back to fix' : ''}`}
          {test && !testing && <span className="muted">{test.command}</span>}
        </button>
      )}
      {conflicts.length > 0 && (
        <span className="signal conflict" title={conflicts.map((c) => `${c.file}: ${c.agentIds.map((id) => agents.find((a) => a.id === id)?.name).join(', ')}`).join('\n')}>
          <Icon name="branch" size={13} /> {conflicts.length} file{conflicts.length > 1 ? 's' : ''} also changed by {[...new Set(conflicts.flatMap((c) => c.agentIds))].filter((x) => x !== agentId).map((id) => agents.find((a) => a.id === id)?.name).join(', ')}
        </span>
      )}
      {showTest && test && <pre className="test-out mono" onClick={() => setShowTest(false)}>{test.output.slice(-3000) || '(no output)'}</pre>}
    </div>
  )
}
