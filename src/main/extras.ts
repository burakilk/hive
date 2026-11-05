/**
 * Preview element picker, idea radar, webhook triggers and commit context (git notes).
 */
import { ipcMain } from 'electron'
import { createServer, Server } from 'http'
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'crypto'
import simpleGit from 'simple-git'
import type { Agent, Idea, Trigger } from '@shared/types'
import { getState, updateState } from './store'
import type { FeatureCtx } from './features'
import { runClaude } from './ai'
import { readConversation } from './transcript'
import { expandRefs } from '@shared/library'

/** Script injected into the preview frame: hover highlight, click returns a description of the element. */
const PICKER = `new Promise((resolve) => {
  const box = document.createElement('div')
  box.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #8b7cf6;background:rgba(139,124,246,.15);border-radius:3px;transition:all .05s'
  const tag = document.createElement('div')
  tag.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;background:#8b7cf6;color:#fff;font:600 11px/1.6 system-ui;padding:0 6px;border-radius:3px'
  document.body.append(box, tag)
  const sel = (el) => {
    if (el.id) return '#' + CSS.escape(el.id)
    const parts = []
    for (let e = el; e && e.nodeType === 1 && e !== document.body && parts.length < 5; e = e.parentElement) {
      let p = e.tagName.toLowerCase()
      const cls = [...e.classList].filter((c) => !/^(css|sc|jsx|_|ng-)/.test(c)).slice(0, 2)
      if (cls.length) p += '.' + cls.map((c) => CSS.escape(c)).join('.')
      const sib = e.parentElement ? [...e.parentElement.children].filter((x) => x.tagName === e.tagName) : []
      if (sib.length > 1) p += ':nth-of-type(' + (sib.indexOf(e) + 1) + ')'
      parts.unshift(p)
      if (e.id) { parts[0] = '#' + CSS.escape(e.id); break }
    }
    return parts.join(' > ')
  }
  const move = (ev) => {
    const r = ev.target.getBoundingClientRect()
    Object.assign(box.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' })
    tag.textContent = ev.target.tagName.toLowerCase() + ' ' + Math.round(r.width) + '×' + Math.round(r.height)
    Object.assign(tag.style, { left: r.left + 'px', top: Math.max(0, r.top - 18) + 'px' })
  }
  const done = (v) => {
    removeEventListener('mousemove', move, true); removeEventListener('click', click, true); removeEventListener('keydown', key, true)
    box.remove(); tag.remove(); resolve(v)
  }
  const click = (ev) => {
    ev.preventDefault(); ev.stopPropagation()
    const el = ev.target
    const cs = getComputedStyle(el)
    done({
      selector: sel(el),
      tag: el.tagName.toLowerCase(),
      text: (el.innerText || el.value || el.alt || '').trim().slice(0, 160),
      html: el.outerHTML.slice(0, 600),
      url: location.href,
      size: Math.round(el.getBoundingClientRect().width) + '×' + Math.round(el.getBoundingClientRect().height),
      style: 'color ' + cs.color + ', background ' + cs.backgroundColor + ', font ' + cs.fontSize + ' ' + cs.fontWeight
    })
  }
  const key = (ev) => { if (ev.key === 'Escape') done(null) }
  addEventListener('mousemove', move, true); addEventListener('click', click, true); addEventListener('keydown', key, true)
})`

export function registerExtras(ctx: FeatureCtx): { dispose: () => void; commitNote: (agentId: string, cwd: string, commit: string) => Promise<void> } {
  const save = (fn: Parameters<typeof updateState>[0]): void => {
    updateState(fn)
    ctx.broadcastState()
  }

  // ---------- preview element picker ----------
  ipcMain.handle('preview:pick', async (_e, url: string) => {
    const wc = ctx.win()?.webContents
    if (!wc) throw new Error('No window')
    const origin = new URL(url).origin
    const frame = wc.mainFrame.framesInSubtree.find((f) => f !== wc.mainFrame && f.url.startsWith(origin))
    if (!frame) throw new Error('Preview not loaded yet')
    return frame.executeJavaScript(PICKER, true)
  })
  ipcMain.handle('preview:cancelPick', async (_e, url: string) => {
    const wc = ctx.win()?.webContents
    const origin = new URL(url).origin
    const frame = wc?.mainFrame.framesInSubtree.find((f) => f !== wc.mainFrame && f.url.startsWith(origin))
    await frame?.executeJavaScript(`dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`).catch(() => undefined)
  })

  // ---------- idea radar ----------
  ipcMain.handle('ideas:analyze', async (_e, projectId: string, raw: string) => {
    const prompt = [
      'You are grouping raw user feedback for a software product.',
      'Cluster the feedback below into themes. Merge duplicates and near-duplicates. For each theme give:',
      'title (short, imperative, e.g. "Add dark mode"), kind (bug | feature | improvement | question), summary (one sentence),',
      'count (how many separate pieces of feedback ask for it) and up to 3 short representative quotes.',
      'Answer with ONLY a JSON array: [{"title":"","kind":"","summary":"","count":1,"quotes":[""]}] sorted by count, highest first.',
      'Keep the language of the feedback.',
      '',
      'FEEDBACK:',
      raw.slice(0, 40_000)
    ].join('\n')
    const out = await runClaude(prompt, { args: '--model haiku', timeoutMs: 150_000 })
    const json = out.slice(out.indexOf('['), out.lastIndexOf(']') + 1)
    let list: Omit<Idea, 'id' | 'projectId' | 'at'>[]
    try {
      list = JSON.parse(json)
    } catch {
      throw new Error('Could not read the grouping – try again')
    }
    const now = Date.now()
    const ideas: Idea[] = list.map((x) => ({ ...x, id: randomUUID(), projectId, at: now, count: Number(x.count) || 1, quotes: (x.quotes ?? []).slice(0, 3) }))
    // merge with existing ideas of the same title
    save((s) => {
      for (const i of ideas) {
        const ex = s.ideas.find((o) => o.projectId === projectId && o.title.toLowerCase() === i.title.toLowerCase())
        if (ex) {
          ex.count += i.count
          ex.quotes = [...ex.quotes, ...i.quotes].slice(-5)
          ex.at = now
        } else s.ideas.push(i)
      }
    })
    return ideas.length
  })
  ipcMain.handle('ideas:remove', (_e, id: string) => save((s) => (s.ideas = s.ideas.filter((x) => x.id !== id))))
  ipcMain.handle('ideas:toCard', (_e, id: string) => {
    const i = getState().ideas.find((x) => x.id === id)
    if (!i) return
    const body = `${i.summary}\n\nRequested ${i.count}×${i.quotes.length ? '\n\n' + i.quotes.map((q) => `> ${q}`).join('\n') : ''}`
    save((s) => {
      s.tasks.push({ id: randomUUID(), projectId: i.projectId, title: i.title, body, status: 'todo', createdAt: Date.now(), updatedAt: Date.now() })
      s.ideas = s.ideas.filter((x) => x.id !== id)
    })
  })

  // ---------- webhook triggers ----------
  let server: Server | null = null
  let listening = 0
  const startServer = (): void => {
    const port = getState().settings.triggerPort || 4317
    if (server && listening === port) return
    server?.close()
    server = createServer((req, res) => {
      const m = req.url?.match(/^\/trigger\/([\w-]+)(?:\?token=([\w-]+))?/)
      const t = m && getState().triggers.find((x) => x.id === m[1])
      const token = m?.[2] ?? String(req.headers['x-hive-token'] ?? '')
      if (!t || !t.enabled || req.method !== 'POST' || (!t.secret && token !== t.token)) {
        res.writeHead(t ? 403 : 404).end()
        return
      }
      let body = ''
      req.on('data', (c) => body.length < 2_000_000 && (body += c))
      req.on('end', () => {
        // signed webhooks (GitHub X-Hub-Signature-256, or X-Hive-Signature) – HMAC-SHA256 of the raw body
        if (t.secret) {
          const sig = String(req.headers['x-hub-signature-256'] ?? req.headers['x-hive-signature'] ?? '').replace(/^sha256=/, '')
          const want = createHmac('sha256', t.secret).update(body).digest('hex')
          if (!sig || sig.length !== want.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(want))) {
            res.writeHead(401).end('bad signature')
            return
          }
        }
        const ev = String(req.headers['x-github-event'] ?? req.headers['x-event'] ?? '')
        const events = (t.events ?? '').split(',').map((x) => x.trim()).filter(Boolean)
        const skip = (events.length && !events.includes(ev)) || (t.match?.trim() && !body.toLowerCase().includes(t.match.trim().toLowerCase()))
        if (skip) {
          res.writeHead(202, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, skipped: true }))
          return
        }
        let summary = body
        try {
          summary = JSON.stringify(JSON.parse(body), null, 1)
        } catch {
          /* plain text */
        }
        const event = String(req.headers['x-github-event'] ?? req.headers['x-event'] ?? '')
        const text = expandRefs(t.prompt, getState().prompts, getState().skills)
          .replace(/\{\{payload\}\}/g, summary.slice(0, 6000))
          .replace(/\{\{event\}\}/g, event || 'webhook')
        const a = getState().agents.find((x) => x.id === t.agentId)
        if (!a) {
          res.writeHead(410).end('agent removed')
          return
        }
        if (ctx.agents.isRunning(a.id)) ctx.agents.deliver(a.id, `[Webhook "${t.name}"${event ? ` · ${event}` : ''}]\n${text}`)
        else ctx.startAgent(a.id, false, `[Webhook "${t.name}"${event ? ` · ${event}` : ''}]\n${text}`)
        save((s) => {
          const x = s.triggers.find((y) => y.id === t.id)
          if (x) {
            x.lastFired = Date.now()
            x.fired = (x.fired ?? 0) + 1
          }
        })
        res.writeHead(202, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, agent: a.name }))
      })
    })
    server.on('error', (e) => console.error('[triggers]', e.message))
    server.listen(port, '127.0.0.1', () => (listening = port))
  }
  if (getState().triggers.length) startServer()
  ipcMain.handle('triggers:save', (_e, t: Trigger) => {
    save((s) => {
      const v = { ...t, token: t.token || randomBytes(12).toString('hex') }
      const i = s.triggers.findIndex((x) => x.id === t.id)
      if (i >= 0) s.triggers[i] = v
      else s.triggers.push(v)
    })
    startServer()
  })
  ipcMain.handle('triggers:remove', (_e, id: string) => save((s) => (s.triggers = s.triggers.filter((x) => x.id !== id))))
  ipcMain.handle('triggers:port', () => listening || getState().settings.triggerPort || 4317)

  // ---------- commit context ----------
  async function commitNote(agentId: string, cwd: string, commit: string): Promise<void> {
    const a: Agent | undefined = getState().agents.find((x) => x.id === agentId)
    const t = a?.sessions?.[a.sessions.length - 1]
    if (!a || !t) return
    const conv = await readConversation(t)
    const msgs = conv.items.filter((i) => i.kind === 'user' || i.kind === 'assistant').slice(-16)
    if (!msgs.length) return
    const note = [
      `Hive · ${a.name} (${a.role}) · session ${t.split('/').pop()?.replace('.jsonl', '')}`,
      '',
      ...msgs.map((m) => `${m.kind === 'user' ? '## You' : `## ${a.name}`}\n${m.text.slice(0, 2000)}\n`)
    ]
      .join('\n')
      .slice(0, 30_000)
    await simpleGit(cwd).raw(['notes', '--ref=hive', 'add', '-f', '-m', note, commit])
  }
  ipcMain.handle('git:commitNote', async (_e, agentId: string) => {
    const a = ctx.findAgent(agentId)
    const cwd = ctx.agentCwd(a)
    const log = await simpleGit(cwd).raw(['log', '-20', '--format=%H%x09%s%x09%ar'])
    const out: { hash: string; subject: string; when: string; note?: string }[] = []
    for (const line of log.trim().split('\n').filter(Boolean)) {
      const [hash, subject, when] = line.split('\t')
      const note = await simpleGit(cwd).raw(['notes', '--ref=hive', 'show', hash]).catch(() => '')
      out.push({ hash, subject, when, note: note || undefined })
    }
    return out
  })

  return {
    dispose: () => server?.close(),
    commitNote: (agentId, cwd, commit) => commitNote(agentId, cwd, commit).catch((e) => console.warn('[commit note]', e.message))
  }
}
