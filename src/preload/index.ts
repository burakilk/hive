import { contextBridge, ipcRenderer, IpcRendererEvent, webFrame, webUtils } from 'electron'
import type { UsageReport } from '@shared/usage'
import type { Conversation } from '@shared/chat'
import type { ProcInfo } from '@shared/procs'
import type { ReplayTurn, WeeklyReport } from '@shared/insights'
import type { AgentRuntime, AppState, GitSummary, NewAgentInput, Agent, AgentPatch, Project, TeamEvent, RoleDef, SavedPrompt, DevServer, ServerRuntime, AppSettings, Provider, Task, TaskStatus, Schedule, Skill, McpServerDef, ProjectSettings, TestResult, Workflow, WorkflowRun, PlanReview, Conflict, Trigger, PickedElement, DbConnection, Account, AgentQuestion, UpdateInfo, MockServer, MockLogEntry } from '@shared/types'

function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  getState: (): Promise<{ state: AppState; runtimes: AgentRuntime[]; servers: ServerRuntime[]; platform: string }> =>
    ipcRenderer.invoke('state:get'),
  projectFolders: (id: string, op: 'add' | 'remove', path?: string): Promise<void> => ipcRenderer.invoke('project:folders', id, op, path),
  addProject: (): Promise<Project | null> => ipcRenderer.invoke('project:add'),
  removeProject: (id: string): Promise<void> => ipcRenderer.invoke('project:remove', id),
  isRepo: (projectId: string): Promise<boolean> => ipcRenderer.invoke('project:isRepo', projectId),

  createAgent: (input: NewAgentInput): Promise<Agent> => ipcRenderer.invoke('agent:create', input),
  removeAgent: (id: string): Promise<void> => ipcRenderer.invoke('agent:remove', id),
  startAgent: (id: string, resume = false): Promise<void> => ipcRenderer.invoke('agent:start', id, resume),
  stopAgent: (id: string): Promise<void> => ipcRenderer.invoke('agent:stop', id),
  /** resume = keep the conversation (continue the last session) */
  restartAgent: (id: string, resume = false): Promise<void> => ipcRenderer.invoke('agent:restart', id, resume),
  updateAgent: (id: string, patch: AgentPatch): Promise<{ restartHint: string[] }> => ipcRenderer.invoke('agent:update', id, patch),
  duplicateAgent: (id: string): Promise<Agent> => ipcRenderer.invoke('agent:duplicate', id),
  stopAll: (projectId: string): Promise<void> => ipcRenderer.invoke('project:stopAll', projectId),
  startAll: (projectId: string): Promise<void> => ipcRenderer.invoke('project:startAll', projectId),
  copyText: (text: string): Promise<void> => ipcRenderer.invoke('clipboard:write', text),
  agentBuffer: (id: string): Promise<{ data: string; cols: number; rows: number }> => ipcRenderer.invoke('agent:buffer', id),
  agentCwd: (id: string): Promise<string> => ipcRenderer.invoke('agent:cwd', id),
  /** project new projects copy their agents from (null = none) */
  projectTeamSource: (exceptId?: string): Promise<Project | null> => ipcRenderer.invoke('project:teamSource', exceptId),
  /** copies all agents of one project into another; returns how many */
  copyTeam: (fromId: string, toId: string): Promise<number> => ipcRenderer.invoke('project:copyTeam', fromId, toId),
  /** custom slash commands / skills / prompts the agent's CLI offers */
  slashCommands: (id: string): Promise<{ name: string; desc: string; source: string }[]> => ipcRenderer.invoke('agent:slashCommands', id),
  input: (id: string, data: string): void => ipcRenderer.send('agent:input', id, data),
  answerAsk: (id: string, yes: boolean): Promise<void> => ipcRenderer.invoke('agent:answerAsk', id, yes),
  resize: (id: string, cols: number, rows: number): void => ipcRenderer.send('agent:resize', id, cols, rows),

  gitSummary: (id: string): Promise<GitSummary> => ipcRenderer.invoke('git:summary', id),
  gitCommit: (id: string, msg: string): Promise<string> => ipcRenderer.invoke('git:commit', id, msg),
  gitMerge: (id: string): Promise<string> => ipcRenderer.invoke('git:merge', id),
  gitFileDiff: (id: string, file: string): Promise<string> => ipcRenderer.invoke('git:fileDiff', id, file),
  gitRevertFile: (id: string, file: string): Promise<void> => ipcRenderer.invoke('git:revertFile', id, file),
  openFile: (id: string, file: string): Promise<string> => ipcRenderer.invoke('file:open', id, file),
  revealFile: (id: string, file: string): Promise<void> => ipcRenderer.invoke('file:reveal', id, file),
  openPath: (path: string): Promise<string> => ipcRenderer.invoke('shell:open', path),
  openLink: (url: string): Promise<boolean> => ipcRenderer.invoke('shell:openLink', url),

  servers: {
    suggest: (projectId: string): Promise<{ name: string; command: string; cwd: string }[]> => ipcRenderer.invoke('servers:suggest', projectId),
    save: (s: DevServer): Promise<void> => ipcRenderer.invoke('servers:save', s),
    remove: (id: string): Promise<void> => ipcRenderer.invoke('servers:remove', id),
    start: (id: string): Promise<void> => ipcRenderer.invoke('servers:start', id),
    stop: (id: string): Promise<void> => ipcRenderer.invoke('servers:stop', id),
    buffer: (id: string): Promise<string> => ipcRenderer.invoke('servers:buffer', id),
    input: (id: string, data: string): void => ipcRenderer.send('servers:input', id, data),
    resize: (id: string, cols: number, rows: number): void => ipcRenderer.send('servers:resize', id, cols, rows),
    onData: (cb: (p: { serverId: string; data: string }) => void) => on('server:data', cb),
    onRuntime: (cb: (rt: ServerRuntime) => void) => on('server:runtime', cb)
  },

  settings: {
    save: (patch: Partial<AppSettings>): Promise<void> => ipcRenderer.invoke('settings:save', patch),
    saveProviders: (list: Provider[]): Promise<void> => ipcRenderer.invoke('providers:save', list),
    checkCommand: (command: string): Promise<{ ok: boolean; path?: string }> => ipcRenderer.invoke('providers:check', command),
    info: (): Promise<{ version: string; electron: string; node: string; userData: string; hookPort: number | null }> => ipcRenderer.invoke('app:info'),
    openData: (): Promise<string> => ipcRenderer.invoke('app:openData'),
    setZoom: (f: number): void => webFrame.setZoomFactor(f)
  },

  tasks: {
    save: (t: Task): Promise<string | null> => ipcRenderer.invoke('tasks:save', t),
    remove: (id: string): Promise<void> => ipcRenderer.invoke('tasks:remove', id),
    run: (id: string, agentId: string): Promise<string> => ipcRenderer.invoke('tasks:run', id, agentId),
    boardPrompts: (p: Record<TaskStatus, string>): Promise<void> => ipcRenderer.invoke('tasks:boardPrompts', p),
    importGithub: (projectId: string): Promise<{ added: number; updated: number; total: number; via: string }> => ipcRenderer.invoke('github:import', projectId)
  },
  schedules: {
    save: (s: Schedule): Promise<void> => ipcRenderer.invoke('schedules:save', s),
    remove: (id: string): Promise<void> => ipcRenderer.invoke('schedules:remove', id),
    runNow: (id: string): Promise<string> => ipcRenderer.invoke('schedules:runNow', id)
  },
  queue: {
    add: (agentId: string, text: string): Promise<string> => ipcRenderer.invoke('queue:add', agentId, text),
    edit: (agentId: string, op: { remove?: string; up?: string; sendNow?: string; clear?: boolean; update?: { id: string; text: string }; hold?: boolean }): Promise<void> =>
      ipcRenderer.invoke('queue:edit', agentId, op)
  },
  conversation: (agentId: string): Promise<Conversation & { none?: boolean }> => ipcRenderer.invoke('agent:conversation', agentId),
  forkAgent: (id: string): Promise<Agent> => ipcRenderer.invoke('agent:fork', id),
  morphAgent: (id: string, role: string): Promise<void> => ipcRenderer.invoke('agent:morph', id, role),
  askAgent: (id: string, question: string): Promise<string> => ipcRenderer.invoke('agent:ask', id, question),
  pauseAgent: (id: string): Promise<boolean> => ipcRenderer.invoke('agent:pause', id),
  pauseProject: (projectId: string): Promise<number> => ipcRenderer.invoke('project:pause', projectId),
  resumeProject: (projectId: string): Promise<number> => ipcRenderer.invoke('project:resume', projectId),
  review: {
    summary: (id: string): Promise<GitSummary> => ipcRenderer.invoke('git:reviewSummary', id),
    fileDiff: (id: string, file: string): Promise<string> => ipcRenderer.invoke('git:reviewFileDiff', id, file),
    aiMessage: (id: string): Promise<{ message: string; ai: boolean }> => ipcRenderer.invoke('git:aiMessage', id)
  },
  enhancePrompt: (text: string, agentId?: string): Promise<string> => ipcRenderer.invoke('ai:enhance', text, agentId),
  memory: { save: (projectId: string, text: string): Promise<void> => ipcRenderer.invoke('memory:save', projectId, text) },
  skills: {
    save: (s: Skill): Promise<void> => ipcRenderer.invoke('skills:save', s),
    remove: (id: string): Promise<void> => ipcRenderer.invoke('skills:remove', id)
  },
  mcp: { save: (list: McpServerDef[]): Promise<void> => ipcRenderer.invoke('mcp:save', list) },
  procs: {
    list: (): Promise<ProcInfo[]> => ipcRenderer.invoke('procs:list'),
    kill: (pid: number): Promise<boolean> => ipcRenderer.invoke('procs:kill', pid)
  },
  media: {
    screenshot: (): Promise<{ path: string; dataUrl: string } | null> => ipcRenderer.invoke('media:screenshot'),
    readImage: (path: string): Promise<string> => ipcRenderer.invoke('media:readImage', path),
    saveImage: (data: Uint8Array, ext: string): Promise<{ path: string; dataUrl: string }> => ipcRenderer.invoke('media:saveImage', data, ext),
    /** any file without a path on disk (e.g. pasted) → saved copy */
    saveFile: (data: Uint8Array, name: string): Promise<{ path: string; name: string }> => ipcRenderer.invoke('media:saveFile', data, name),
    /** native "choose files" dialog; [] when cancelled */
    pickFiles: (): Promise<string[]> => ipcRenderer.invoke('media:pickFiles'),
    /** real path of a dropped / pasted File ('' when it has none) */
    pathForFile: (f: File): string => {
      try {
        return webUtils.getPathForFile(f)
      } catch {
        return ''
      }
    },
    micAccess: (): Promise<boolean> => ipcRenderer.invoke('media:micAccess'),
    transcribe: (wav: Uint8Array): Promise<string> => ipcRenderer.invoke('media:transcribe', wav),
    onAttach: (cb: (a: { path: string; dataUrl: string }) => void) => on('media:attach', cb)
  },
  automation: {
    saveProject: (projectId: string, p: ProjectSettings): Promise<void> => ipcRenderer.invoke('projectSettings:save', projectId, p),
    detectTest: (projectId: string): Promise<string> => ipcRenderer.invoke('projectSettings:detectTest', projectId),
    runTests: (agentId: string): Promise<TestResult | null> => ipcRenderer.invoke('tests:run', agentId),
    lastTests: (): Promise<TestResult[]> => ipcRenderer.invoke('tests:last'),
    budgetToday: (): Promise<Record<string, number>> => ipcRenderer.invoke('budget:today'),
    conflicts: (): Promise<Conflict[]> => ipcRenderer.invoke('conflicts:list'),
    plans: (): Promise<PlanReview[]> => ipcRenderer.invoke('plans:list'),
    decidePlan: (agentId: string, decision: 'approve' | 'revise', feedback?: string): Promise<void> => ipcRenderer.invoke('plans:decide', agentId, decision, feedback),
    planMode: (agentId: string): Promise<void> => ipcRenderer.invoke('agent:planMode', agentId),
    onTestsRunning: (cb: (p: { agentId: string; command: string }) => void) => on('tests:running', cb),
    onTestResult: (cb: (r: TestResult) => void) => on('tests:result', cb),
    onPlan: (cb: (p: PlanReview) => void) => on('plan:ready', cb),
    onPlanCleared: (cb: (agentId: string) => void) => on('plan:cleared', cb),
    onConflicts: (cb: (c: Conflict[]) => void) => on('conflicts', cb),
    onBudget: (cb: (b: Record<string, number>) => void) => on('budget', cb)
  },
  workflows: {
    save: (w: Workflow): Promise<void> => ipcRenderer.invoke('workflows:save', w),
    remove: (id: string): Promise<void> => ipcRenderer.invoke('workflows:remove', id),
    run: (id: string, input: string): Promise<string> => ipcRenderer.invoke('workflows:run', id, input),
    stop: (runId: string): Promise<void> => ipcRenderer.invoke('workflows:stop', runId)
  },
  extras: {
    pick: (url: string): Promise<PickedElement | null> => ipcRenderer.invoke('preview:pick', url),
    cancelPick: (url: string): Promise<void> => ipcRenderer.invoke('preview:cancelPick', url),
    analyzeIdeas: (projectId: string, raw: string): Promise<number> => ipcRenderer.invoke('ideas:analyze', projectId, raw),
    removeIdea: (id: string): Promise<void> => ipcRenderer.invoke('ideas:remove', id),
    ideaToCard: (id: string): Promise<void> => ipcRenderer.invoke('ideas:toCard', id),
    saveTrigger: (t: Trigger): Promise<void> => ipcRenderer.invoke('triggers:save', t),
    removeTrigger: (id: string): Promise<void> => ipcRenderer.invoke('triggers:remove', id),
    triggerPort: (): Promise<number> => ipcRenderer.invoke('triggers:port'),
    commitHistory: (agentId: string): Promise<{ hash: string; subject: string; when: string; note?: string }[]> => ipcRenderer.invoke('git:commitNote', agentId)
  },
  insights: {
    weekly: (projectId: string, days?: number): Promise<WeeklyReport> => ipcRenderer.invoke('report:weekly', projectId, days),
    sessions: (agentId: string): Promise<{ path: string; id: string }[]> => ipcRenderer.invoke('replay:sessions', agentId),
    replay: (agentId: string, path: string): Promise<ReplayTurn[]> => ipcRenderer.invoke('replay:load', agentId, path)
  },
  secrets: {
    list: (): Promise<{ name: string; projectId?: string; updatedAt: number; length: number }[]> => ipcRenderer.invoke('secrets:list'),
    set: (name: string, value: string, projectId?: string): Promise<boolean> => ipcRenderer.invoke('secrets:set', name, value, projectId),
    remove: (name: string): Promise<void> => ipcRenderer.invoke('secrets:remove', name),
    encrypted: (): Promise<boolean> => ipcRenderer.invoke('secrets:encrypted')
  },
  onEmote: (cb: (e: { agentIds: string[]; kind: string }) => void) => on('agent:emote', cb),
  tunnel: {
    open: (port: number): Promise<{ url: string; tool: string }> => ipcRenderer.invoke('tunnel:open', port),
    close: (port: number): Promise<void> => ipcRenderer.invoke('tunnel:close', port),
    list: (): Promise<{ port: number; url: string; tool: string }[]> => ipcRenderer.invoke('tunnel:list')
  },
  db: {
    list: (): Promise<DbConnection[]> => ipcRenderer.invoke('db:list'),
    save: (d: DbConnection, url?: string): Promise<void> => ipcRenderer.invoke('db:save', d, url),
    remove: (id: string): Promise<void> => ipcRenderer.invoke('db:remove', id),
    query: (id: string, q: string): Promise<string> => ipcRenderer.invoke('db:query', id, q)
  },
  onAwake: (cb: (on: boolean) => void) => on('power:awake', cb),
  onProjectPaused: (cb: (projectId: string) => void) => on('project:paused', cb),

  usage: (projectId?: string): Promise<UsageReport> => ipcRenderer.invoke('usage:report', projectId),

  library: {
    savePrompt: (p: SavedPrompt): Promise<void> => ipcRenderer.invoke('library:savePrompt', p),
    deletePrompt: (id: string): Promise<void> => ipcRenderer.invoke('library:deletePrompt', id),
    saveRole: (r: RoleDef): Promise<void> => ipcRenderer.invoke('library:saveRole', r),
    deleteRole: (id: string): Promise<void> => ipcRenderer.invoke('library:deleteRole', id),
    /** type into running agents (queued if busy) or start stopped ones with it */
    send: (agentIds: string[], text: string): Promise<Record<string, string>> => ipcRenderer.invoke('library:sendPrompt', agentIds, text)
  },

  fs: {
    list: (root: string, rel: string): Promise<{ name: string; path: string; dir: boolean }[]> => ipcRenderer.invoke('fs:list', root, rel),
    listAll: (root: string): Promise<string[]> => ipcRenderer.invoke('fs:listAll', root),
    read: (root: string, rel: string): Promise<{ content: string; binary: boolean; tooLarge: boolean; size: number }> =>
      ipcRenderer.invoke('fs:read', root, rel),
    readOptional: (root: string, rel: string): Promise<string | null> => ipcRenderer.invoke('fs:readOptional', root, rel),
    firstExisting: (paths: string[]): Promise<{ path: string; dir: boolean } | null> => ipcRenderer.invoke('fs:firstExisting', paths),
    write: (root: string, rel: string, content: string): Promise<void> => ipcRenderer.invoke('fs:write', root, rel, content),
    create: (root: string, rel: string, dir: boolean): Promise<void> => ipcRenderer.invoke('fs:create', root, rel, dir),
    move: (root: string, from: string, to: string): Promise<void> => ipcRenderer.invoke('fs:move', root, from, to),
    trash: (root: string, rel: string): Promise<void> => ipcRenderer.invoke('fs:trash', root, rel),
    reveal: (root: string, rel: string): Promise<void> => ipcRenderer.invoke('fs:reveal', root, rel),
    openExternal: (root: string, rel: string): Promise<string> => ipcRenderer.invoke('fs:openExternal', root, rel),
    sources: (root: string): Promise<{ path: string; content: string }[]> => ipcRenderer.invoke('fs:sources', root),
    typeLibs: (root: string): Promise<{ path: string; content: string }[]> => ipcRenderer.invoke('fs:typeLibs', root),
    watch: (root: string): Promise<void> => ipcRenderer.invoke('fs:watch', root),
    unwatch: (root: string): Promise<void> => ipcRenderer.invoke('fs:unwatch', root),
    gitStatus: (root: string): Promise<GitSummary['files']> => ipcRenderer.invoke('git:status', root),
    ides: (): Promise<{ id: string; name: string; family: string }[]> => ipcRenderer.invoke('ide:list'),
    openInIde: (id: string, root: string, rel?: string, line?: number): Promise<void> => ipcRenderer.invoke('ide:open', id, root, rel, line),
    onChanged: (cb: (p: { root: string; paths: string[] }) => void) => on('fs:changed', cb)
  },

  accounts: {
    save: (list: Account[]): Promise<void> => ipcRenderer.invoke('accounts:save', list),
    /** opens a login terminal (server id returned) */
    signin: (providerId: string, accountId?: string): Promise<string> => ipcRenderer.invoke('accounts:signin', providerId, accountId),
    status: (providerId: string, accountId?: string): Promise<string> => ipcRenderer.invoke('accounts:status', providerId, accountId)
  },
  figma: {
    frame: (url: string, projectId?: string): Promise<{ path: string; dataUrl: string; name: string; size: string; texts: string[]; url: string }> =>
      ipcRenderer.invoke('figma:frame', url, projectId)
  },
  tracker: {
    import: (projectId: string, kind: 'linear' | 'jira' | 'notion' | 'azure', opts: Record<string, string>): Promise<{ added: number; updated: number; total: number }> =>
      ipcRenderer.invoke('tracker:import', projectId, kind, opts)
  },
  repos: {
    list: (): Promise<{ name: string; url: string; host: 'github' | 'gitlab'; description: string }[]> => ipcRenderer.invoke('repos:list'),
    clone: (url: string): Promise<Project | null> => ipcRenderer.invoke('repos:clone', url)
  },
  skillFiles: {
    export: (target: 'claude-project' | 'claude-user' | 'codex-user' | 'cursor-project', projectId?: string): Promise<string[]> =>
      ipcRenderer.invoke('skills:export', target, projectId),
    import: (projectId?: string): Promise<number> => ipcRenderer.invoke('skills:importFiles', projectId)
  },
  doctor: (): Promise<{
    clis: { id: string; name: string; command: string; path: string | null; version: string; signin: string }[]
    tools: { bin: string; why: string; path: string | null }[]
    failures: { agentId: string; name: string; reason: string; tail: string; hints: string[] }[]
    shell: string
  }> => ipcRenderer.invoke('doctor:run'),
  externalSessions: {
    list: (projectId: string): Promise<{ path: string; kind: 'claude' | 'codex'; at: number; size: number; title: string }[]> => ipcRenderer.invoke('sessions:external', projectId),
    adopt: (projectId: string, path: string, kind: 'claude' | 'codex', name?: string): Promise<string> => ipcRenderer.invoke('sessions:adopt', projectId, path, kind, name)
  },
  updates: {
    check: (): Promise<UpdateInfo | null> => ipcRenderer.invoke('update:check'),
    install: (): Promise<'opened' | 'installing' | undefined> => ipcRenderer.invoke('update:install'),
    skip: (version: string): Promise<void> => ipcRenderer.invoke('update:skip', version),
    onAvailable: (cb: (u: UpdateInfo) => void) => on('update:available', cb),
    onProgress: (cb: (p: number) => void) => on('update:progress', cb)
  },
  showQaBrowser: (agentId: string): Promise<boolean> => ipcRenderer.invoke('qa:show', agentId),
  mocks: {
    save: (m: MockServer): Promise<void> => ipcRenderer.invoke('mocks:save', m),
    remove: (id: string): Promise<void> => ipcRenderer.invoke('mocks:remove', id),
    start: (id: string): Promise<void> => ipcRenderer.invoke('mocks:start', id),
    stop: (id: string): Promise<void> => ipcRenderer.invoke('mocks:stop', id),
    state: (): Promise<Record<string, boolean>> => ipcRenderer.invoke('mocks:state'),
    logs: (id: string): Promise<MockLogEntry[]> => ipcRenderer.invoke('mocks:logs', id),
    clearLogs: (id: string): Promise<void> => ipcRenderer.invoke('mocks:clearLogs', id),
    freePort: (): Promise<number> => ipcRenderer.invoke('mocks:freePort'),
    try: (url: string, method: string, body?: string): Promise<{ status: number; ms: number; text: string }> => ipcRenderer.invoke('mocks:try', url, method, body),
    openapi: (id: string, text: string): Promise<number> => ipcRenderer.invoke('mocks:openapi', id, text),
    generate: (id: string, description: string): Promise<number> => ipcRenderer.invoke('mocks:generate', id, description),
    onLog: (cb: (e: MockLogEntry) => void) => on('mock:log', cb),
    onState: (cb: (s: Record<string, boolean>) => void) => on('mock:state', cb)
  },
  advisor: (projectId: string, task: string): Promise<{ agentId: string; reason: string }> => ipcRenderer.invoke('advisor:suggest', projectId, task),
  questions: {
    list: (): Promise<AgentQuestion[]> => ipcRenderer.invoke('questions:list'),
    answer: (agentId: string, picks: number[][], other?: string): Promise<void> => ipcRenderer.invoke('questions:answer', agentId, picks, other),
    onReady: (cb: (q: AgentQuestion) => void) => on('question:ready', cb),
    onCleared: (cb: (agentId: string) => void) => on('question:cleared', cb)
  },
  onLimit: (cb: (agentId: string) => void) => on('agent:limit', cb),
  onToast: (cb: (text: string) => void) => on('toast', cb),
  onOpenSettings: (cb: () => void) => on('open:settings', cb),
  onPauseSummary: (cb: (s: { agentId: string; name: string; text: string }[]) => void) => on('pause:summary', cb),

  onData: (cb: (p: { agentId: string; data: string }) => void) => on('agent:data', cb),
  onRuntime: (cb: (rt: AgentRuntime) => void) => on('agent:runtime', cb),
  onActivity: (cb: (p: { agentId: string; text: string }) => void) => on('agent:activity', cb),
  onState: (cb: (s: AppState) => void) => on('state:changed', cb),
  onFocusAgent: (cb: (id: string) => void) => on('agent:focus', cb),
  onTeamEvent: (cb: (e: TeamEvent) => void) => on('team:event', cb)
}

export type Api = typeof api
contextBridge.exposeInMainWorld('api', api)
