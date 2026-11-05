/**
 * IPC + background jobs for: backlog, schedules, message queue, conversation view,
 * fork / morph / side questions, review & AI commit, memory / skills / MCP,
 * watchdog, keep-awake, project pause, screenshots, dictation, GitHub import.
 */
import { BrowserWindow, globalShortcut, ipcMain, Notification, powerSaveBlocker, session, systemPreferences } from 'electron'
import { copyFileSync, existsSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { basename, join, resolve } from 'path'
import { randomUUID } from 'crypto'
import type { Agent, McpServerDef, Project, Schedule, Skill, Task, TaskStatus } from '@shared/types'
import { nextRun } from '@shared/schedule'
import { expandRefs } from '@shared/library'
import { getState, updateState } from './store'
import { applyQueueOp, type AgentManager, type QueueOp } from './agents'
import type { ServerManager } from './servers'
import * as git from './git'
import { currentSession, readConversation } from './transcript'
import { askSide, commitMessage, enhancePrompt } from './ai'
import { killProc, scan } from './watchdog'
import { listIssues } from './github'
import { captureScreen, saveAttachment, saveImage, transcribe } from './media'

export interface FeatureCtx {
  agents: AgentManager
  servers: ServerManager
  win: () => BrowserWindow | null
  send: (channel: string, payload: unknown) => void
  broadcastState: () => void
  startAgent: (id: string, resume: boolean, prompt?: string, extraArgs?: string) => void
  findAgent: (id: string) => Agent
  findProject: (id: string) => Project
  agentCwd: (a: Agent) => string
}

export const fill = (tpl: string, t: Task): string =>
  tpl.replace(/\{\{title\}\}/g, t.title).replace(/\{\{body\}\}/g, t.body || '(no details)') +
  (t.effort === 'high' ? '\n\nultrathink' : t.effort === 'medium' ? '\n\nThink hard about this.' : '')
const sessionIdOf = (a: Agent): string | undefined => {
  const t = currentSession(a.sessions)
  return t ? basename(t, '.jsonl') : undefined
}
const claudeProjectDir = (cwd: string): string =>
  join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))

function notify(ctx: FeatureCtx, title: string, body: string, agentId?: string): void {
  if (!Notification.isSupported()) return
  const n = new Notification({ title, body, silent: getState().settings.notify.silent })
  n.on('click', () => {
    ctx.win()?.show()
    if (agentId) ctx.send('agent:focus', agentId)
  })
  n.show()
}

/** Give a task to an agent: typed in / queued if running, otherwise started with it. */
export function handTo(ctx: FeatureCtx, agentId: string, text: string, fresh = false): string {
  if (fresh && ctx.agents.isRunning(agentId)) {
    ctx.agents.restart(agentId, () => ctx.startAgent(agentId, false, text))
    return 'restarted'
  }
  if (ctx.agents.isRunning(agentId)) return ctx.agents.deliver(agentId, text)
  ctx.startAgent(agentId, false, text)
  return 'started'
}

export function registerFeatures(ctx: FeatureCtx): { dispose: () => void; onPaused: (agentId: string) => void } {
  const { agents } = ctx
  const save = (fn: Parameters<typeof updateState>[0]): void => {
    updateState(fn)
    ctx.broadcastState()
  }

  // ---------- backlog ----------
  ipcMain.handle('tasks:save', (_e, t: Task) => {
    const prev = getState().tasks.find((x) => x.id === t.id)
    const next = { ...t, updatedAt: Date.now() }
    save((s) => {
      const i = s.tasks.findIndex((x) => x.id === t.id)
      if (i >= 0) s.tasks[i] = next
      else s.tasks.push({ ...next, createdAt: Date.now() })
    })
    // moving a card into a column with a prompt hands the card to its agent
    const moved = prev && prev.status !== t.status
    const assigned = t.agentId && prev?.agentId !== t.agentId
    const tpl = getState().boardPrompts[t.status]
    if (t.agentId && tpl.trim() && (moved || (assigned && t.status !== 'todo'))) return handTo(ctx, t.agentId, fill(tpl, t))
    return null
  })
  ipcMain.handle('tasks:remove', (_e, id: string) => save((s) => (s.tasks = s.tasks.filter((x) => x.id !== id))))
  ipcMain.handle('tasks:boardPrompts', (_e, p: Record<TaskStatus, string>) => save((s) => (s.boardPrompts = p)))
  /** send a card to an agent right now (moves it to In progress) */
  ipcMain.handle('tasks:run', (_e, id: string, agentId: string) => {
    const t = getState().tasks.find((x) => x.id === id)
    if (!t) throw new Error('Unknown task')
    save((s) => Object.assign(s.tasks.find((x) => x.id === id)!, { agentId, status: 'doing', updatedAt: Date.now() }))
    return handTo(ctx, agentId, fill(getState().boardPrompts.doing || '{{title}}\n\n{{body}}', t))
  })
  ipcMain.handle('github:import', async (_e, projectId: string) => {
    const p = ctx.findProject(projectId)
    const { issues, via } = await listIssues(p.path)
    let added = 0
    let updated = 0
    save((s) => {
      for (const i of issues) {
        const ex = s.tasks.find((t) => t.projectId === projectId && t.source?.kind === 'github' && t.source.number === i.number)
        const source = { kind: 'github' as const, number: i.number, url: i.url, labels: i.labels }
        if (ex) {
          Object.assign(ex, { title: i.title, body: i.body, source, updatedAt: Date.now() })
          updated++
        } else {
          s.tasks.push({ id: randomUUID(), projectId, title: i.title, body: i.body, status: 'todo', source, createdAt: Date.now(), updatedAt: Date.now() })
          added++
        }
      }
    })
    return { added, updated, total: issues.length, via }
  })

  // ---------- schedules ----------
  ipcMain.handle('schedules:save', (_e, sc: Schedule) =>
    save((s) => {
      const i = s.schedules.findIndex((x) => x.id === sc.id)
      // runs are counted from now on – no burst of missed runs
      const v = { ...sc, lastRun: sc.lastRun ?? (sc.kind === 'once' ? undefined : Date.now()) }
      if (i >= 0) s.schedules[i] = v
      else s.schedules.push(v)
    })
  )
  ipcMain.handle('schedules:remove', (_e, id: string) => save((s) => (s.schedules = s.schedules.filter((x) => x.id !== id))))
  ipcMain.handle('schedules:runNow', (_e, id: string) => runSchedule(id))
  const runSchedule = (id: string): string => {
    const sc = getState().schedules.find((x) => x.id === id)
    if (!sc) throw new Error('Unknown schedule')
    const agent = getState().agents.find((a) => a.id === sc.agentId)
    save((s) => {
      const x = s.schedules.find((y) => y.id === id)!
      x.lastRun = Date.now()
      if (x.kind === 'once') x.enabled = false
    })
    if (!agent) return 'missing agent'
    const how = handTo(ctx, agent.id, expandRefs(sc.prompt, getState().prompts, getState().skills), sc.fresh)
    notify(ctx, `⏰ ${sc.title || 'Scheduled task'}`, `${agent.name}: ${how === 'queued' ? 'queued (agent busy)' : 'started'}`, agent.id)
    return how
  }

  // ---------- message queue ----------
  ipcMain.handle('queue:add', (_e, agentId: string, text: string) => {
    if (!agents.isRunning(agentId)) {
      ctx.startAgent(agentId, false, text)
      return 'started'
    }
    return agents.deliver(agentId, text, { queueOnly: true })
  })
  ipcMain.handle('queue:edit', (_e, agentId: string, op: QueueOp) => {
    if (agents.editQueue(agentId, op)) return
    // stopped agent: edit its stored queue; "send now" starts it with that message
    const a = ctx.findAgent(agentId)
    const r = applyQueueOp(a.queue ?? [], !!a.queueHeld, op)
    updateState((s) => {
      const x = s.agents.find((y) => y.id === agentId)
      if (!x) return
      if (r.queue.length) x.queue = r.queue
      else delete x.queue
      if (r.held) x.queueHeld = true
      else delete x.queueHeld
    })
    agents.showStoredQueue(agentId, r.queue, r.held)
    ctx.broadcastState()
    if (r.send) ctx.startAgent(agentId, false, r.send.text)
  })

  // ---------- conversation & context ----------
  ipcMain.handle('agent:conversation', async (_e, id: string) => {
    const a = ctx.findAgent(id)
    const t = currentSession(a.sessions)
    if (!t) return { items: [], context: null, none: true }
    return readConversation(t)
  })

  // ---------- fork / morph / side question ----------
  ipcMain.handle('agent:fork', async (_e, id: string) => {
    const src = ctx.findAgent(id)
    if (src.providerId !== 'claude') throw new Error('Forking needs a Claude Code agent')
    const sid = sessionIdOf(src)
    if (!sid) throw new Error(`${src.name} has no Claude Code session yet – send it a message first`)
    const project = ctx.findProject(src.projectId)
    const agent: Agent = {
      ...src,
      id: randomUUID(),
      name: `${src.name} (fork)`,
      branch: undefined,
      worktreePath: undefined,
      sessions: [],
      workMs: 0,
      roleLog: [],
      paused: undefined,
      forkedFrom: src.id,
      initialPrompt: undefined,
      queue: undefined,
      queueHeld: undefined,
      createdAt: Date.now()
    }
    // a fork of an isolated agent gets its own branch, starting from the source's branch
    if (src.worktreePath) Object.assign(agent, await git.createWorktree(project.path, agent.name, agent.id, undefined, src.branch))
    const srcCwd = ctx.agentCwd(src)
    const cwd = ctx.agentCwd(agent)
    if (cwd !== srcCwd) {
      // Claude looks sessions up per folder – copy the transcript next to the new folder
      const from = currentSession(src.sessions)!
      const dir = claudeProjectDir(cwd)
      mkdirSync(dir, { recursive: true })
      if (existsSync(from)) copyFileSync(from, join(dir, `${sid}.jsonl`))
    }
    save((s) => s.agents.push(agent))
    ctx.startAgent(agent.id, false, undefined, `--resume ${sid} --fork-session`)
    return agent
  })
  ipcMain.handle('agent:morph', (_e, id: string, role: string) => {
    const a = ctx.findAgent(id)
    if (a.role === role) return
    const def = getState().roles.find((r) => r.name.toLowerCase() === role.toLowerCase())
    const color = def?.color
    save((s) => {
      const x = s.agents.find((y) => y.id === id)!
      x.roleLog = [...(x.roleLog ?? []), { from: x.role, to: role, at: Date.now() }].slice(-50)
      x.role = role
      if (color) x.color = color
    })
    if (agents.isRunning(id))
      agents.deliver(
        id,
        `[Role change] From now on you work as the ${role} of this project (until now: ${a.role}). Keep everything you know from this conversation.` +
          (def?.instructions ? `\n\nYour new role:\n${def.instructions}` : '')
      )
  })
  ipcMain.handle('agent:ask', async (_e, id: string, question: string) => {
    const a = ctx.findAgent(id)
    if (a.providerId !== 'claude') throw new Error('Side questions need a Claude Code agent')
    const sid = sessionIdOf(a)
    if (!sid) throw new Error(`${a.name} has no Claude Code session yet`)
    return askSide(sid, ctx.agentCwd(a), question)
  })

  // ---------- review & AI commit ----------
  const baseFor = async (a: Agent): Promise<string | undefined> => (a.branch ? git.currentBranch(ctx.findProject(a.projectId).path) : undefined)
  ipcMain.handle('git:reviewSummary', async (_e, id: string) => {
    const a = ctx.findAgent(id)
    const base = await baseFor(a)
    return base ? git.branchSummary(ctx.agentCwd(a), base) : git.summary(ctx.agentCwd(a))
  })
  ipcMain.handle('git:reviewFileDiff', async (_e, id: string, file: string) => {
    const a = ctx.findAgent(id)
    const base = await baseFor(a)
    return base ? git.branchFileDiff(ctx.agentCwd(a), base, file) : git.fileDiff(ctx.agentCwd(a), file)
  })
  ipcMain.handle('git:aiMessage', async (_e, id: string) => {
    const sum = await git.summary(ctx.agentCwd(ctx.findAgent(id)))
    if (!sum.files.length) throw new Error('Nothing to commit')
    return commitMessage(sum.diff, sum.files.map((f) => f.path))
  })
  ipcMain.handle('ai:enhance', (_e, text: string, agentId?: string) => {
    const a = agentId ? getState().agents.find((x) => x.id === agentId) : undefined
    return enhancePrompt(text, { project: a ? ctx.findProject(a.projectId).name : undefined, role: a?.role, branch: a?.branch })
  })

  // ---------- memory / skills / MCP ----------
  ipcMain.handle('memory:save', (_e, projectId: string, text: string) => save((s) => (s.memory[projectId] = text)))
  ipcMain.handle('skills:save', (_e, sk: Skill) =>
    save((s) => {
      const i = s.skills.findIndex((x) => x.id === sk.id)
      if (i >= 0) s.skills[i] = sk
      else s.skills.push(sk)
    })
  )
  ipcMain.handle('skills:remove', (_e, id: string) => save((s) => (s.skills = s.skills.filter((x) => x.id !== id))))
  ipcMain.handle('mcp:save', (_e, list: McpServerDef[]) => save((s) => (s.mcpServers = list)))

  // ---------- watchdog ----------
  const procAgents = (): { id: string; pid?: number; running: boolean }[] =>
    getState().agents.map((a) => ({ id: a.id, pid: agents.pid(a.id), running: agents.isRunning(a.id) }))
  ipcMain.handle('procs:list', () => scan(procAgents()))
  ipcMain.handle('procs:kill', (_e, pid: number) => killProc(pid))

  // ---------- pause / resume ----------
  ipcMain.handle('project:pause', (_e, projectId: string) => {
    const list = getState().agents.filter((a) => a.projectId === projectId && agents.isRunning(a.id))
    for (const a of list) agents.pauseAfterTurn(a.id)
    pauseWatch.set(projectId, new Set(list.map((a) => a.id)))
    return list.length
  })
  ipcMain.handle('project:resume', async (_e, projectId: string) => {
    const list = getState().agents.filter((a) => a.projectId === projectId && a.paused)
    // "where everyone left off": each agent's last reply before the pause
    const summary: { agentId: string; name: string; text: string }[] = []
    for (const a of list) {
      const path = a.sessions?.[a.sessions.length - 1]
      if (!path) continue
      try {
        const last = [...(await readConversation(path)).items].reverse().find((i) => i.kind === 'assistant')
        if (last) summary.push({ agentId: a.id, name: a.name, text: last.text.slice(0, 600) })
      } catch {
        /* no transcript */
      }
    }
    if (summary.length) ctx.send('pause:summary', summary)
    save((s) => s.agents.forEach((a) => a.projectId === projectId && delete a.paused))
    for (const a of list) if (!agents.isRunning(a.id)) ctx.startAgent(a.id, true)
    for (const a of getState().agents.filter((x) => x.projectId === projectId)) agents.cancelPause(a.id)
    pauseWatch.delete(projectId)
    return list.length
  })
  ipcMain.handle('agent:pause', (_e, id: string) => agents.pauseAfterTurn(id))
  const pauseWatch = new Map<string, Set<string>>()
  const onPaused = (agentId: string): void => {
    save((s) => {
      const a = s.agents.find((x) => x.id === agentId)
      if (a) a.paused = true
    })
    for (const [pid, set] of pauseWatch) {
      if (!set.delete(agentId) || set.size) continue
      pauseWatch.delete(pid)
      const p = getState().projects.find((x) => x.id === pid)
      notify(ctx, `⏸ ${p?.name ?? 'Project'} paused`, 'Every agent finished its turn. It is safe to close the lid or update.')
      ctx.send('project:paused', pid)
    }
  }

  // ---------- screenshots & dictation ----------
  ipcMain.handle('media:screenshot', async () => {
    const w = ctx.win()
    const shot = await captureScreen()
    w?.show()
    w?.focus()
    return shot
  })
  ipcMain.handle('media:readImage', async (_e, path: string) => {
    const { nativeImage, app } = await import('electron')
    // any image file (screenshots in replies may live in qa-shots, the project, /tmp…) – never other files
    const p = resolve(path.replace(/^~(?=\/)/, homedir()))
    if (!/\.(png|jpe?g|gif|webp|bmp)$/i.test(p) && !p.startsWith(join(app.getPath('userData'), 'attachments'))) throw new Error('Not an image')
    const img = nativeImage.createFromPath(p)
    if (img.isEmpty()) throw new Error('Image not found')
    return img.toDataURL()
  })
  ipcMain.handle('media:saveImage', (_e, data: Uint8Array, ext: string) => saveImage(data, ext))
  ipcMain.handle('media:saveFile', (_e, data: Uint8Array, name: string) => saveAttachment(data, name))
  ipcMain.handle('media:pickFiles', async () => {
    const { dialog } = await import('electron')
    const w = ctx.win()
    const opts = { title: 'Attach files', properties: ['openFile', 'multiSelections'] as ('openFile' | 'multiSelections')[] }
    const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts)
    return r.canceled ? [] : r.filePaths
  })
  ipcMain.handle('media:micAccess', async () => {
    if (process.platform !== 'darwin') return true
    if (systemPreferences.getMediaAccessStatus('microphone') === 'granted') return true
    return systemPreferences.askForMediaAccess('microphone')
  })
  ipcMain.handle('media:transcribe', (_e, wav: Uint8Array) => transcribe(wav))
  // microphone for Hive's own window only (never for previewed sites)
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => {
    const own = wc === ctx.win()?.webContents && !details.requestingUrl?.startsWith('http://localhost') && !details.requestingUrl?.startsWith('http://127.')
    cb(own && (permission === 'media' || permission === 'clipboard-read' || permission === 'clipboard-sanitized-write'))
  })
  // ⌘⇧2 anywhere → capture a region and attach it to the next message
  globalShortcut.register('CommandOrControl+Shift+2', async () => {
    const shot = await captureScreen()
    const w = ctx.win()
    w?.show()
    w?.focus()
    if (shot) ctx.send('media:attach', shot)
  })

  // ---------- background loop: schedules, keep-awake, auto-pause ----------
  let blocker: number | null = null
  const waitingSince = new Map<string, number>()
  const loop = setInterval(() => {
    const now = Date.now()
    for (const sc of getState().schedules) {
      if (!sc.enabled) continue
      const due = sc.kind === 'once' ? (sc.onceAt && !sc.lastRun && sc.onceAt <= now ? sc.onceAt : null) : nextRun(sc, sc.lastRun ?? now)
      if (due && due <= now) {
        // missed while Hive was closed (more than 2 minutes late) and catch-up is off: skip to the next one
        if (sc.kind !== 'once' && sc.catchUp === false && now - due > 120_000) {
          updateState((s) => {
            const x = s.schedules.find((y) => y.id === sc.id)
            if (x) x.lastRun = now
          })
          continue
        }
        try {
          runSchedule(sc.id)
        } catch (err) {
          console.error('[schedule]', err)
        }
      }
    }
    const st = getState().settings
    const busy = agents.allRuntimes().some((r) => r.running && r.status === 'working') || ctx.servers.all().some((s) => s.running)
    if (st.keepAwake && busy && blocker === null) blocker = powerSaveBlocker.start('prevent-app-suspension')
    else if ((!st.keepAwake || !busy) && blocker !== null) {
      powerSaveBlocker.stop(blocker)
      blocker = null
    }
    ctx.send('power:awake', blocker !== null)
    // auto-pause idle agents (they resume their conversation with ▶ / Resume)
    for (const r of agents.allRuntimes()) {
      if (!r.running || r.status !== 'waiting' || r.queue?.length) {
        waitingSince.delete(r.agentId)
        continue
      }
      if (!waitingSince.has(r.agentId)) waitingSince.set(r.agentId, now)
      if (st.autoPauseMin > 0 && now - waitingSince.get(r.agentId)! > st.autoPauseMin * 60_000) {
        waitingSince.delete(r.agentId)
        agents.pauseAfterTurn(r.agentId)
      }
    }
  }, 15_000)

  return {
    dispose: () => {
      clearInterval(loop)
      if (blocker !== null) powerSaveBlocker.stop(blocker)
      globalShortcut.unregisterAll()
    },
    onPaused
  }
}
