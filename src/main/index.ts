import { app, BrowserWindow, clipboard, dialog, ipcMain, Notification, shell } from 'electron'
import { basename, join, resolve } from 'path'
import { randomUUID } from 'crypto'
import { cpSync, existsSync } from 'fs'
import { execFile } from 'child_process'
import { AgentManager } from './agents'
import { getState, loadState, mergeProviders, updateState } from './store'
import { claudeHookSettingsJson, getHookPort, startHookServer, stopHookServer, writeClaudeHookSettings } from './hooks'
import * as git from './git'
import * as files from './files'
import { listIdes, openInIde } from './ide'
import { ServerManager, suggestServers } from './servers'
import { usageReport } from './usage'
import { registerFeatures } from './features'
import { registerAutomation } from './automation'
import { registerExtras } from './extras'
import { registerMocks } from './mock'
import { registerInsights, secretEnv, secretValues } from './insights'
import { registerRemote } from './remote'
import { findSessions } from './otherclis'
import { accountEnv, registerMore } from './more'
import { copyTeam, seedNewProject, teamSource } from './projectTeam'
import { utf8Locale } from './agents'
import { registerUpdater } from './updater'
import { createTray } from './tray'
import { childrenOf, handleMcpHttp, initTeam, mcpArgsFor, codexMcpArgs, wouldCycle } from './team'
import { Agent, AgentPatch, AgentRuntime, AppSettings, DevServer, Provider, NewAgentInput, Project, RoleDef, SavedPrompt } from '@shared/types'

let win: BrowserWindow | null = null

/**
 * The app used to be called AgentRoom. On the first start as Hive, copy the old data
 * folder (projects, agents, settings, UI preferences) so nothing is lost. Runs before
 * 'ready' so Chromium hasn't opened its profile yet.
 */
function migrateFromAgentRoom(): void {
  try {
    const dir = app.getPath('userData')
    const old = join(app.getPath('appData'), 'AgentRoom')
    if (old === dir || existsSync(join(dir, 'state.json')) || !existsSync(join(old, 'state.json'))) return
    cpSync(old, dir, {
      recursive: true,
      force: false,
      filter: (src) => !/Singleton(Lock|Socket|Cookie)|[\\/](Cache|Code Cache|GPUCache|DawnCache|blob_storage|Crashpad)([\\/]|$)/.test(src)
    })
    console.log('[migrate] copied AgentRoom data to', dir)
  } catch (err) {
    console.error('[migrate] could not copy AgentRoom data', err)
  }
}
migrateFromAgentRoom()
let agents: AgentManager
let servers: ServerManager
let features: ReturnType<typeof registerFeatures> | null = null
let automation: ReturnType<typeof registerAutomation> | null = null
let extras: ReturnType<typeof registerExtras> | null = null
let more: ReturnType<typeof registerMore> | null = null

function send(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

/** In development the window / dock use build/icon.png; packaged builds get the icon from electron-builder. */
const devIcon = (): string => join(app.getAppPath(), 'build', 'icon.png')

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#0b0d12',
    ...(existsSync(devIcon()) ? { icon: devIcon() } : {}),
    title: 'Hive',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })
  win.on('closed', () => (win = null))
  win.webContents.setWindowOpenHandler(({ url }) => {
    openLink(url)
    return { action: 'deny' }
  })
  // never navigate the app window itself to a link
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win?.webContents.getURL()) {
      e.preventDefault()
      openLink(url)
    }
  })
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
}

// ---------- helpers ----------
/** Open a link in the user's default browser / mail app. Only safe schemes are allowed. */
function openLink(url: string): boolean {
  try {
    const u = new URL(url)
    if (!['http:', 'https:', 'mailto:'].includes(u.protocol)) return false
    shell.openExternal(u.toString())
    return true
  } catch {
    return false
  }
}

const findAgent = (id: string): Agent => {
  const a = getState().agents.find((x) => x.id === id)
  if (!a) throw new Error(`Unknown agent ${id}`)
  return a
}
const findProject = (id: string): Project => {
  const p = getState().projects.find((x) => x.id === id)
  if (!p) throw new Error(`Unknown project ${id}`)
  return p
}
const agentCwd = (a: Agent): string => a.worktreePath ?? findProject(a.projectId).path
const broadcastState = (): void => send('state:changed', getState())

function onRuntime(rt: AgentRuntime): void {
  send('agent:runtime', rt)
  updateBadge()
  automation?.onRuntime(rt)
  if (rt.status !== 'waiting' && rt.status !== 'done' && rt.status !== 'error') return
  const { notify } = getState().settings
  if (!notify[rt.status]) return
  if (win?.isFocused() && !notify.whenFocused) return
  const agent = getState().agents.find((a) => a.id === rt.agentId)
  if (!agent || !Notification.isSupported()) return
  const body =
    rt.status === 'waiting' ? 'Waiting for your input' : rt.status === 'done' ? 'Finished' : (rt.exitReason ?? `Exited with code ${rt.exitCode}`)
  const n = new Notification({ title: `${agent.name} · ${agent.role}`, body, silent: notify.silent })
  n.on('click', () => {
    win?.show()
    win?.focus()
    send('agent:focus', agent.id)
  })
  n.show()
}

function updateBadge(): void {
  const waiting = getState().settings.badge ? agents.allRuntimes().filter((r) => r.status === 'waiting').length : 0
  app.setBadgeCount?.(waiting)
}

// ---------- IPC ----------
function registerIpc(): void {
  ipcMain.handle('state:get', () => ({ state: getState(), runtimes: agents.allRuntimes(), servers: servers.all(), platform: process.platform }))

  ipcMain.handle('project:folders', async (_e, id: string, op: 'add' | 'remove', path?: string) => {
    let dir = path
    if (op === 'add') {
      const r = await dialog.showOpenDialog(win!, { title: 'Link another folder to this project', properties: ['openDirectory', 'createDirectory', 'multiSelections'] })
      if (r.canceled || !r.filePaths.length) return
      updateState((s) => {
        const p = s.projects.find((x) => x.id === id)
        if (p) p.folders = [...new Set([...(p.folders ?? []), ...r.filePaths.filter((f) => f !== p.path)])]
      })
    } else if (dir) {
      updateState((s) => {
        const p = s.projects.find((x) => x.id === id)
        if (p) p.folders = (p.folders ?? []).filter((f) => f !== dir)
      })
    }
    dir = undefined
    broadcastState()
  })
  ipcMain.handle('project:add', async () => {
    const res = await dialog.showOpenDialog(win!, {
      title: 'Choose project folder',
      properties: ['openDirectory', 'createDirectory']
    })
    if (res.canceled || !res.filePaths[0]) return null
    const path = res.filePaths[0]
    const existing = getState().projects.find((p) => p.path === path)
    if (existing) return existing
    const project: Project = { id: randomUUID(), name: basename(path), path, createdAt: Date.now() }
    updateState((s) => s.projects.push(project))
    await seedNewProject(project)
    broadcastState()
    return project
  })
  /** template project for "start with the same agents" (null = none) */
  ipcMain.handle('project:teamSource', (_e, exceptId?: string) => teamSource(exceptId) ?? null)
  ipcMain.handle('project:copyTeam', async (_e, fromId: string, toId: string) => {
    const added = await copyTeam(fromId, toId)
    broadcastState()
    return added.length
  })

  ipcMain.handle('project:remove', async (_e, id: string) => {
    const project = findProject(id)
    for (const a of getState().agents.filter((x) => x.projectId === id)) await removeAgent(a, project)
    for (const sv of getState().servers.filter((x) => x.projectId === id)) servers.forget(sv.id)
    updateState((s) => {
      s.projects = s.projects.filter((p) => p.id !== id)
      s.servers = s.servers.filter((x) => x.projectId !== id)
    })
    broadcastState()
  })

  ipcMain.handle('project:isRepo', (_e, id: string) => git.isRepo(findProject(id).path))

  ipcMain.handle('agent:create', async (_e, input: NewAgentInput) => {
    const project = findProject(input.projectId)
    const agent: Agent = {
      id: randomUUID(),
      projectId: project.id,
      name: input.name.trim() || 'Agent',
      role: input.role.trim() || 'General',
      color: input.color,
      providerId: input.providerId,
      initialPrompt: input.initialPrompt,
      parentId: input.parentId || undefined,
      accountId: input.accountId,
      effort: input.effort,
      ssh: input.ssh?.host.trim() ? { host: input.ssh.host.trim(), path: input.ssh.path.trim() } : undefined,
      createdAt: Date.now()
    }
    if (input.useWorktree && !agent.ssh) Object.assign(agent, await git.createWorktree(project.path, agent.name, agent.id, input.branch))
    updateState((s) => s.agents.push(agent))
    broadcastState()
    startAgent(agent.id, false)
    return agent
  })

  ipcMain.handle('agent:remove', async (_e, id: string) => {
    const agent = findAgent(id)
    await removeAgent(agent, findProject(agent.projectId))
    broadcastState()
  })

  ipcMain.handle('agent:start', (_e, id: string, resume: boolean) => startAgent(id, resume))
  ipcMain.handle('agent:stop', (_e, id: string) => agents.stop(id))
  ipcMain.handle('agent:restart', (_e, id: string, resume?: boolean) => {
    findAgent(id)
    agents.restart(id, () => startAgent(id, !!resume))
  })
  ipcMain.handle('agent:update', async (_e, id: string, patch: AgentPatch) => {
    const agent = findAgent(id)
    const project = findProject(agent.projectId)
    const next: Partial<Agent> = {}
    for (const k of ['name', 'role', 'color', 'providerId', 'initialPrompt'] as const)
      if (patch[k] !== undefined) next[k] = patch[k] || undefined
    if (next.name === undefined && patch.name !== undefined) next.name = agent.name

    const wantWorktree = patch.useWorktree ?? !!agent.worktreePath
    const branch = patch.branch?.trim()
    if (wantWorktree !== !!agent.worktreePath) {
      if (agents.isRunning(id)) throw new Error('Stop the agent before changing its workspace')
      if (wantWorktree) {
        Object.assign(next, await git.createWorktree(project.path, next.name ?? agent.name, agent.id, branch))
      } else {
        if (await git.isDirty(agent.worktreePath!))
          throw new Error('The worktree has uncommitted changes – commit or discard them first')
        await git.removeWorktree(project.path, agent.worktreePath!)
        next.worktreePath = undefined
        next.branch = undefined
      }
    } else if (wantWorktree && branch && branch !== agent.branch) {
      await git.renameBranch(project.path, agent.branch!, branch)
      next.branch = branch
    }

    if (patch.accountId !== undefined) (next as Partial<Agent>).accountId = patch.accountId ?? undefined
    if (patch.effort !== undefined) (next as Partial<Agent>).effort = (patch.effort || undefined) as Agent['effort']
    if (patch.model !== undefined) (next as Partial<Agent>).model = patch.model.trim() || undefined
    if (patch.ssh !== undefined) (next as Partial<Agent> & { ssh?: Agent['ssh'] }).ssh = patch.ssh?.host.trim() ? { host: patch.ssh.host.trim(), path: patch.ssh.path.trim() } : undefined
    let restartHint: string[] = []
    if (patch.parentId !== undefined && (patch.parentId || undefined) !== agent.parentId) {
      const pid = patch.parentId || undefined
      if (pid) {
        const lead = findAgent(pid)
        if (lead.projectId !== agent.projectId) throw new Error('The lead must be in the same project')
        if (wouldCycle(id, pid)) throw new Error(`${lead.name} already reports to ${agent.name} – that would be a loop`)
      }
      next.parentId = pid
      // running Claude agents read their tools at start-up
      const touched = [agent, pid ? findAgent(pid) : undefined, agent.parentId ? findAgent(agent.parentId) : undefined]
      restartHint = touched.filter((a): a is Agent => !!a && agents.isRunning(a.id)).map((a) => a.name)
    }

    updateState((s) => {
      const a = s.agents.find((x) => x.id === id)!
      Object.assign(a, next)
      if ('parentId' in next && !next.parentId) delete a.parentId
      if ('ssh' in next && !next.ssh) delete a.ssh
      if ('model' in next && !next.model) delete a.model
      if ('effort' in next && !next.effort) delete a.effort
      if ('worktreePath' in next && !next.worktreePath) {
        delete a.worktreePath
        delete a.branch
      }
    })
    broadcastState()
    return { restartHint }
  })
  ipcMain.handle('agent:duplicate', async (_e, id: string) => {
    const src = findAgent(id)
    const agent: Agent = {
      ...src,
      id: randomUUID(),
      name: `${src.name} (copy)`,
      branch: undefined,
      worktreePath: undefined,
      createdAt: Date.now()
    }
    if (src.worktreePath) Object.assign(agent, await git.createWorktree(findProject(src.projectId).path, agent.name, agent.id))
    updateState((s) => s.agents.push(agent))
    broadcastState()
    return agent
  })
  ipcMain.handle('project:stopAll', (_e, projectId: string) => {
    for (const a of getState().agents.filter((x) => x.projectId === projectId)) agents.stop(a.id)
  })
  ipcMain.handle('project:startAll', (_e, projectId: string) => {
    for (const a of getState().agents.filter((x) => x.projectId === projectId))
      if (!agents.isRunning(a.id)) startAgent(a.id, false)
  })
  ipcMain.handle('clipboard:write', (_e, text: string) => clipboard.writeText(text))
  ipcMain.handle('agent:buffer', (_e, id: string) => agents.buffer(id))
  ipcMain.on('agent:input', (_e, id: string, data: string) => agents.write(id, data))
  ipcMain.on('agent:resize', (_e, id: string, cols: number, rows: number) => agents.resize(id, cols, rows))

  ipcMain.handle('git:summary', (_e, id: string) => git.summary(agentCwd(findAgent(id))))
  ipcMain.handle('git:commit', async (_e, id: string, msg: string) => {
    const cwd = agentCwd(findAgent(id))
    const hash = await git.commitAll(cwd, msg)
    // keep the conversation that produced the commit (git notes --ref=hive)
    if (hash && getState().settings.commitContext) await extras?.commitNote(id, cwd, hash)
    return hash
  })

  ipcMain.handle('git:merge', async (_e, id: string) => {
    const a = findAgent(id)
    if (!a.branch) throw new Error('This agent does not use its own branch')
    const res = await git.mergeBranch(findProject(a.projectId).path, a.branch)
    // a little celebration in the office
    send('agent:emote', { agentIds: getState().agents.filter((x) => x.projectId === a.projectId).map((x) => x.id), kind: 'party' })
    return res
  })
  ipcMain.handle('git:fileDiff', (_e, id: string, file: string) => git.fileDiff(agentCwd(findAgent(id)), file))
  ipcMain.handle('git:revertFile', (_e, id: string, file: string) => git.revertFile(agentCwd(findAgent(id)), file))
  ipcMain.handle('file:open', (_e, id: string, file: string) => shell.openPath(join(agentCwd(findAgent(id)), file)))
  ipcMain.handle('file:reveal', (_e, id: string, file: string) => shell.showItemInFolder(join(agentCwd(findAgent(id)), file)))
  ipcMain.handle('shell:open', (_e, path: string) => shell.openPath(path))
  // ---- usage & cost ----
  ipcMain.handle('usage:report', (_e, projectId?: string) => {
    const st = getState()
    const list = projectId ? st.agents.filter((a) => a.projectId === projectId) : st.agents
    const projects = projectId ? st.projects.filter((p) => p.id === projectId) : st.projects
    const folders = [...projects.map((p) => p.path), ...list.filter((a) => a.worktreePath).map((a) => a.worktreePath!)]
    return usageReport(list, folders, (id) => agents.currentWork(id))
  })

  // ---- dev servers ----
  const serverCwd = (s: DevServer): string => join(findProject(s.projectId).path, s.cwd || '')
  ipcMain.handle('servers:suggest', (_e, projectId: string) => suggestServers(findProject(projectId).path))
  ipcMain.handle('servers:save', (_e, srv: DevServer) => {
    updateState((s) => {
      const i = s.servers.findIndex((x) => x.id === srv.id)
      if (i >= 0) s.servers[i] = srv
      else s.servers.push(srv)
    })
    broadcastState()
  })
  ipcMain.handle('servers:remove', (_e, id: string) => {
    servers.forget(id)
    updateState((s) => (s.servers = s.servers.filter((x) => x.id !== id)))
    broadcastState()
  })
  ipcMain.handle('servers:start', (_e, id: string) => {
    const srv = getState().servers.find((x) => x.id === id)
    if (!srv) throw new Error('Unknown server')
    servers.start(srv, serverCwd(srv), utf8Locale())
  })
  ipcMain.handle('servers:stop', (_e, id: string) => servers.stop(id))
  ipcMain.handle('servers:buffer', (_e, id: string) => servers.buffer(id))
  ipcMain.on('servers:input', (_e, id: string, data: string) => servers.write(id, data))
  ipcMain.on('servers:resize', (_e, id: string, cols: number, rows: number) => servers.resize(id, cols, rows))

  // ---- prompt & role library ----
  // ---------- settings ----------
  ipcMain.handle('settings:save', (_e, patch: Partial<AppSettings>) => {
    updateState((s) => {
      s.settings = { ...s.settings, ...patch, notify: { ...s.settings.notify, ...patch.notify } }
    })
    updateBadge()
    broadcastState()
  })
  ipcMain.handle('providers:save', (_e, list: Provider[]) => {
    updateState((s) => {
      // built-in CLIs can be edited but not removed (mergeProviders restores them)
      s.providers = mergeProviders(list.filter((p) => p.id && p.name))
    })
    broadcastState()
  })
  ipcMain.handle('providers:check', async (_e, command: string) => {
    const bin = command.trim().split(/\s+/)[0]
    if (!bin) return { ok: true, path: '(shell)' }
    const shellBin = process.env.SHELL || '/bin/zsh'
    if (process.platform === 'win32') return { ok: true, path: bin }
    return await new Promise<{ ok: boolean; path?: string }>((res) => {
      execFile(shellBin, ['-l', '-i', '-c', `command -v ${JSON.stringify(bin)}`], { timeout: 8000 }, (err, out) => {
        const path = out.toString().trim().split('\n').pop()
        res(err || !path ? { ok: false } : { ok: true, path })
      })
    })
  })
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    userData: app.getPath('userData'),
    hookPort: getHookPort() || null
  }))
  ipcMain.handle('app:openData', () => shell.openPath(app.getPath('userData')))

  ipcMain.handle('library:savePrompt', (_e, p: SavedPrompt) => {
    updateState((s) => {
      const i = s.prompts.findIndex((x) => x.id === p.id)
      if (i >= 0) s.prompts[i] = p
      else s.prompts.push(p)
    })
    broadcastState()
  })
  ipcMain.handle('library:deletePrompt', (_e, id: string) => {
    updateState((s) => (s.prompts = s.prompts.filter((x) => x.id !== id)))
    broadcastState()
  })
  ipcMain.handle('library:saveRole', (_e, r: RoleDef) => {
    updateState((s) => {
      const i = s.roles.findIndex((x) => x.id === r.id)
      if (i >= 0) {
        // keep agents attached to a renamed role
        const old = s.roles[i].name
        if (old !== r.name) s.agents.forEach((a) => a.role === old && (a.role = r.name))
        s.roles[i] = r
      } else s.roles.push(r)
    })
    broadcastState()
  })
  ipcMain.handle('library:deleteRole', (_e, id: string) => {
    updateState((s) => (s.roles = s.roles.filter((x) => x.id !== id)))
    broadcastState()
  })
  ipcMain.handle('library:sendPrompt', (_e, agentIds: string[], text: string) => {
    const result: Record<string, string> = {}
    for (const id of agentIds) {
      if (agents.isRunning(id)) result[id] = agents.deliver(id, text)
      else {
        startAgent(id, false, text)
        result[id] = 'started'
      }
    }
    return result
  })
  ipcMain.handle('shell:openLink', (_e, url: string) => openLink(url))

  // ---- built-in editor ----
  ipcMain.handle('fs:list', (_e, root: string, rel: string) => files.list(root, rel))
  ipcMain.handle('fs:listAll', (_e, root: string) => files.listAll(root))
  ipcMain.handle('fs:readOptional', (_e, root: string, rel: string) => files.readOptional(root, rel))
  ipcMain.handle('fs:read', (_e, root: string, rel: string) => files.read(root, rel))
  ipcMain.handle('fs:write', (_e, root: string, rel: string, content: string) => files.write(root, rel, content))
  ipcMain.handle('fs:create', (_e, root: string, rel: string, dir: boolean) => files.create(root, rel, dir))
  ipcMain.handle('fs:move', (_e, root: string, from: string, to: string) => files.move(root, from, to))
  ipcMain.handle('fs:trash', (_e, root: string, rel: string) => files.trash(root, rel))
  ipcMain.handle('fs:reveal', (_e, root: string, rel: string) => shell.showItemInFolder(files.absolute(root, rel)))
  ipcMain.handle('fs:openExternal', (_e, root: string, rel: string) => shell.openPath(files.absolute(root, rel)))
  ipcMain.handle('fs:sources', (_e, root: string) => files.sourceFiles(root))
  ipcMain.handle('fs:typeLibs', (_e, root: string) => files.typeLibs(root))
  ipcMain.handle('fs:watch', (_e, root: string) => files.watchRoot(root, () => win))
  ipcMain.handle('fs:unwatch', (_e, root: string) => files.unwatchRoot(root))
  ipcMain.handle('ide:list', () => listIdes())
  ipcMain.handle('ide:open', (_e, id: string, root: string, rel?: string, line?: number) =>
    openInIde(id, files.absolute(root, ''), rel ? files.absolute(root, rel) : undefined, line))
  ipcMain.handle('git:status', async (_e, root: string) => (await git.summary(root)).files)
  ipcMain.handle('agent:cwd', (_e, id: string) => agentCwd(findAgent(id)))
}

function startAgent(id: string, resume: boolean, prompt?: string, forkArgs?: string): void {
  const agent = findAgent(id)
  const provider = getState().providers.find((p) => p.id === agent.providerId) ?? getState().providers[0]
  const cwd = agentCwd(agent)
  if (!agent.ssh && !existsSync(cwd)) throw new Error(`Folder not found: ${cwd}`)
  let extraArgs = provider.id === 'claude' ? mcpArgsFor(agent, getHookPort(), !!agent.ssh) : provider.id === 'codex' && !agent.ssh && getState().settings.codexMcp !== false ? codexMcpArgs(agent, getHookPort()) : undefined
  // role instructions travel with every Claude Code session
  const role = getState().roles.find((r) => r.name.toLowerCase() === agent.role.toLowerCase())
  if (provider.id === 'claude' && role?.instructions.trim()) {
    const q = `'${role.instructions.trim().replace(/'/g, `'\\''`)}'`
    extraArgs = `${extraArgs ?? ''} --append-system-prompt ${q}`.trim()
  }
  // answer language (Claude Code)
  const lang = getState().settings.agentLanguage
  if (provider.id === 'claude' && lang) extraArgs = `${extraArgs ?? ''} --append-system-prompt '${`Always write your replies to the user in ${lang}.`.replace(/'/g, `'\\''`)}'`.trim()
  // model + reasoning effort (agent overrides the CLI default)
  const effort = agent.effort || getState().projectSettings[agent.projectId]?.effort || provider.effort || ''
  const model = agent.model?.trim() || provider.model?.trim()
  const env: Record<string, string> = { ...secretEnv(agent.projectId), ...accountEnv(agent) }
  if (model && !forkArgs) extraArgs = `${extraArgs ?? ''} ${provider.id === 'claude' || provider.id === 'pi' ? '--model' : '-m'} '${model.replace(/'/g, '')}'`.trim()
  if (effort && provider.id === 'codex') extraArgs = `${extraArgs ?? ''} -c model_reasoning_effort='"${effort}"'`.trim()
  if (effort && provider.id === 'claude') env.MAX_THINKING_TOKENS = String({ low: 4000, medium: 16000, high: 31999 }[effort])
  // linked folders: the agent may work in these too
  const linked = (getState().projects.find((p) => p.id === agent.projectId)?.folders ?? []).filter((f) => agent.ssh || existsSync(f))
  if (linked.length) {
    const qq = (f: string): string => `'${f.replace(/'/g, `'\\''`)}'`
    if (provider.id === 'claude' || provider.id === 'codex') extraArgs = `${extraArgs ?? ''} ${linked.map((f) => `--add-dir ${qq(f)}`).join(' ')}`.trim()
    else if (provider.id === 'gemini') extraArgs = `${extraArgs ?? ''} --include-directories ${qq(linked.join(','))}`.trim()
  }
  if (forkArgs) extraArgs = `${extraArgs ?? ''} ${forkArgs}`.trim()
  if (agent.paused) updateState((s) => s.agents.forEach((a) => a.id === id && delete a.paused))
  agents.start(agent, provider, cwd, { resume, prompt, extraArgs, env, ssh: agent.ssh })
}

async function removeAgent(agent: Agent, project: Project): Promise<void> {
  agents.forget(agent.id)
  // members of a removed lead move up one level
  updateState((s) => s.agents.forEach((a) => a.parentId === agent.id && (a.parentId = agent.parentId)))
  if (agent.worktreePath) await git.removeWorktree(project.path, agent.worktreePath)
  updateState((s) => {
    s.agents = s.agents.filter((a) => a.id !== agent.id)
    s.schedules = s.schedules.filter((x) => x.agentId !== agent.id)
    s.tasks.forEach((x) => x.agentId === agent.id && delete x.agentId)
  })
}

// ---------- lifecycle ----------
app.whenReady().then(async () => {
  app.setName('Hive')
  if (process.platform === 'darwin' && existsSync(devIcon())) app.dock?.setIcon(devIcon())
  loadState()
  const port = await startHookServer((agentId, event, payload) => {
    agents?.handleHook(agentId, event)
    automation?.onHook(agentId, event, payload)
    // remember this agent's Claude Code transcript for usage / cost
    const t = typeof payload.transcript_path === "string" ? resolve(payload.transcript_path) : undefined
    if (t) {
      const a = getState().agents.find((x) => x.id === agentId)
      if (a && !(a.sessions ?? []).includes(t)) {
        updateState((s) => {
          const x = s.agents.find((y) => y.id === agentId)
          if (x) x.sessions = [...(x.sessions ?? []), t].slice(-200)
        })
      }
    }
  }, handleMcpHttp)
  agents = new AgentManager(
    {
      onData: (agentId, data) => {
        send('agent:data', { agentId, data })
        more?.onData(agentId, data)
      },
      onActivity: (agentId, text) => send('agent:activity', { agentId, text }),
      onWorked: (agentId, ms) =>
        updateState((s) => {
          const a = s.agents.find((x) => x.id === agentId)
          if (a) a.workMs = (a.workMs ?? 0) + ms
        }),
      onRuntime,
      onPaused: (agentId) => features?.onPaused(agentId),
      onResumeFailed: (agentId) => {
        try {
          startAgent(agentId, false)
        } catch (err) {
          console.error(err)
        }
      }
    },
    { hookPort: port || getHookPort(), claudeSettingsFile: writeClaudeHookSettings(), claudeSettingsJson: claudeHookSettingsJson }
  )
  servers = new ServerManager({
    onData: (serverId, data) => send('server:data', { serverId, data }),
    onRuntime: (rt) => send('server:runtime', rt)
  })
  initTeam({
    agents,
    startAgent,
    onEvent: (e) => send('team:event', e),
    remember: (projectId, line) => {
      updateState((s) => (s.memory[projectId] = `${(s.memory[projectId] ?? '').trimEnd()}\n${line}`.trimStart()))
      broadcastState()
    }
  })
  registerIpc()
  const fctx = { agents, servers, win: () => win, send, broadcastState, startAgent, findAgent, findProject, agentCwd }
  features = registerFeatures(fctx)
  automation = registerAutomation(fctx)
  extras = registerExtras(fctx)
  registerMocks({ send, broadcastState })
  // Codex / Gemini have no SessionStart hook: find their session files by folder + start time
  setInterval(() => {
    const st = getState()
    const owned = new Set(st.agents.flatMap((a) => a.sessions ?? []))
    for (const a of st.agents) {
      if ((a.providerId !== 'codex' && a.providerId !== 'gemini') || a.ssh || !agents.isRunning(a.id)) continue
      const since = agents.startedAt(a.id) ?? Date.now()
      const fresh = findSessions(a.providerId, agentCwd(a), since).filter((p) => !owned.has(p))
      if (!fresh.length) continue
      updateState((s) => {
        const x = s.agents.find((y) => y.id === a.id)
        if (x) x.sessions = [...(x.sessions ?? []), ...fresh].slice(-200)
      })
      fresh.forEach((p) => owned.add(p))
    }
  }, 8000)
  more = registerMore(fctx)
  registerUpdater(send)
  createTray({
    agents,
    win: () => win,
    show: () => {
      if (!win || win.isDestroyed()) createWindow()
      else {
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
      }
    },
    send
  })
  setTimeout(() => more?.restore(), 2500)
  const remote = registerRemote(fctx)
  app.on('before-quit', () => remote.dispose())
  registerInsights(fctx).onSecretsChanged(() => agents.setRedactions(secretValues()))
  agents.setRedactions(secretValues())
  createWindow()
  app.on('activate', () => {
    // hidden QA browser windows do not count
    if (!win || win.isDestroyed()) createWindow()
    else win.show()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
app.on('browser-window-created', (_e, w) => {
  // closing the main window quits on Windows / Linux even while QA browser windows exist
  setImmediate(() => {
    if (w === win) w.on('closed', () => process.platform !== 'darwin' && app.quit())
  })
})

app.on('before-quit', () => {
  more?.recordRunning()
  features?.dispose()
  automation?.dispose()
  extras?.dispose()
  agents?.dispose()
  servers?.dispose()
  stopHookServer()
})
