import type { RoleDef, SavedPrompt } from './library'
export type { RoleDef, SavedPrompt } from './library'
export type AgentStatus = 'idle' | 'working' | 'waiting' | 'done' | 'error'

export interface Provider {
  id: string
  name: string
  /** Shell command used to launch the CLI */
  command: string
  /** Extra args appended when resuming a previous session (optional) */
  resumeArgs?: string
  /**
   * How to pass the first task on the command line. '' = positional argument,
   * e.g. '-i' = flag. Undefined = type it into the terminal once the CLI is idle.
   */
  promptArg?: string
  /** default reasoning effort for new sessions ('' = the CLI's own default) */
  effort?: '' | 'low' | 'medium' | 'high'
  /** default model ('' = the CLI's own default) */
  model?: string
}

export const DEFAULT_PROVIDERS: Provider[] = [
  { id: 'claude', name: 'Claude Code', command: 'claude', resumeArgs: '--continue', promptArg: '' },
  { id: 'codex', name: 'Codex CLI', command: 'codex', resumeArgs: 'resume --last', promptArg: '' },
  { id: 'gemini', name: 'Gemini CLI', command: 'gemini', promptArg: '-i' },
  { id: 'pi', name: 'Pi Coding Agent', command: 'pi', resumeArgs: '--continue', promptArg: '' },
  { id: 'shell', name: 'Plain shell', command: '' }
]

export const ROLE_PRESETS = [
  { role: 'Frontend Developer', color: '#38bdf8' },
  { role: 'Backend Developer', color: '#a78bfa' },
  { role: 'Full Stack', color: '#f97316' },
  { role: 'Tests / QA', color: '#34d399' },
  { role: 'DevOps', color: '#facc15' },
  { role: 'Code Reviewer', color: '#f472b6' },
  { role: 'Docs Writer', color: '#94a3b8' }
]

export interface Project {
  id: string
  name: string
  path: string
  createdAt: number
  /** more folders agents may read and edit (Claude/Codex --add-dir, Gemini --include-directories) */
  folders?: string[]
}

export interface Agent {
  id: string
  projectId: string
  name: string
  role: string
  color: string
  providerId: string
  /** First prompt sent to the agent once its CLI starts (optional) */
  initialPrompt?: string
  /** If set, the agent works inside its own git worktree on this branch */
  branch?: string
  worktreePath?: string
  /** the lead agent this agent reports to */
  parentId?: string
  /** Claude Code transcripts of this agent's sessions (for usage/cost) */
  sessions?: string[]
  /** total time spent in the 'working' state */
  workMs?: number
  /** role changes made while the agent was running (morphing) */
  roleLog?: { from: string; to: string; at: number }[]
  /** sign-in used by this agent (undefined = project default, then your normal login) */
  accountId?: string
  /** overrides the CLI's default reasoning effort */
  effort?: '' | 'low' | 'medium' | 'high'
  /** overrides the CLI's default model (alias like "opus" or a full model id) */
  model?: string
  /** run the CLI on another machine over SSH */
  ssh?: { host: string; path: string }
  /** stopped by "Pause project" – resume picks the conversation back up */
  paused?: boolean
  /** agent this one was forked from */
  forkedFrom?: string
  createdAt: number
}

export interface AgentRuntime {
  agentId: string
  status: AgentStatus
  running: boolean
  lastActivity: number
  exitCode?: number
  /** Why the process ended with an error (shown in the UI) */
  exitReason?: string
  /** messages waiting to be typed in, oldest first */
  queue?: QueuedMessage[]
  /** a project pause is waiting for this agent's turn to finish */
  pausing?: boolean
}

export interface QueuedMessage {
  id: string
  text: string
  at: number
}

/** Backlog card */
export interface Task {
  id: string
  projectId: string
  title: string
  body: string
  status: TaskStatus
  agentId?: string
  /** how hard the agent should think about this card (Claude Code: think hard / ultrathink) */
  effort?: 'low' | 'medium' | 'high'
  /** imported from a tracker (read-only link) */
  source?: { kind: 'github' | 'linear' | 'jira' | 'notion' | 'azure'; number?: number; key?: string; url: string; labels?: string[] }
  createdAt: number
  updatedAt: number
}
export type TaskStatus = 'todo' | 'doing' | 'done'

/** A prompt that runs on a schedule */
export interface Schedule {
  id: string
  agentId: string
  title: string
  prompt: string
  kind: 'once' | 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'monthly'
  /** 1–31 (monthly; clamped to the month's last day) */
  monthDay?: number
  /** run a missed run once when Hive opens again (default true) */
  catchUp?: boolean
  /** HH:MM (daily / weekdays / weekly), minute for hourly */
  time: string
  /** 0 = Sunday (weekly) */
  weekday?: number
  /** epoch ms (once) */
  onceAt?: number
  enabled: boolean
  lastRun?: number
  /** start a fresh session for every run instead of typing into the running one */
  fresh?: boolean
}

/** Reusable procedure agents can look up (MCP get_skill) or you can insert */
export interface Skill {
  id: string
  name: string
  description: string
  body: string
}

/** MCP server shared with every Claude Code agent */
export interface McpServerDef {
  id: string
  name: string
  type: 'stdio' | 'http'
  command?: string
  args?: string
  url?: string
  /** KEY=value per line (stdio env) or header lines (http) */
  env?: string
  enabled: boolean
}

export interface AppState {
  projects: Project[]
  agents: Agent[]
  providers: Provider[]
  prompts: SavedPrompt[]
  roles: RoleDef[]
  servers: DevServer[]
  settings: AppSettings
  tasks: Task[]
  schedules: Schedule[]
  skills: Skill[]
  mcpServers: McpServerDef[]
  /** prompt sent to the assigned agent when a card enters a column ({{title}}, {{body}}) */
  boardPrompts: Record<TaskStatus, string>
  /** project id -> shared memory notes (markdown) */
  memory: Record<string, string>
  /** per-project automation: test guard, budget */
  projectSettings: Record<string, ProjectSettings>
  workflows: Workflow[]
  workflowRuns: WorkflowRun[]
  ideas: Idea[]
  triggers: Trigger[]
  /** mock API servers */
  mocks?: MockServer[]
  /** what was running when Hive quit (session restore) */
  lastRunning?: { agents: string[]; servers: string[]; at: number }
}

/** A theme found by the idea radar in raw user feedback */
export interface Idea {
  id: string
  projectId: string
  title: string
  kind: 'bug' | 'feature' | 'improvement' | 'question' | string
  summary: string
  count: number
  quotes: string[]
  at: number
}

/** POST http://127.0.0.1:<port>/trigger/<id>?token=… starts / messages an agent */
export interface Trigger {
  id: string
  name: string
  agentId: string
  /** {{payload}} = request body, {{event}} = X-GitHub-Event / X-Event header */
  prompt: string
  token: string
  /** HMAC-SHA256 secret – when set, requests must be signed (GitHub "Secret", X-Hub-Signature-256) */
  secret?: string
  /** only these events (X-GitHub-Event / X-Event), comma separated */
  events?: string
  /** only when the payload contains this text */
  match?: string
  enabled: boolean
  lastFired?: number
  fired?: number
}

export interface ProjectSettings {
  /** default reasoning effort for this project's agents (between the agent's own and the CLI default) */
  effort?: 'low' | 'medium' | 'high'
  /** Obsidian (or any) folder mirrored with project memory as Hive Memory.md */
  memorySync?: string
  /** run after an agent finishes a turn that changed files; failures go back to the agent */
  testGuard?: boolean
  testCommand?: string
  /** max automatic "fix the tests" round-trips in a row */
  testRetries?: number
  /** daily spend limit in USD (estimated, Claude Code agents) – agents pause when reached */
  dailyBudget?: number
  /** idle agents take the next Todo card by themselves */
  autoPick?: 'off' | 'assigned' | 'any'
  /** default sign-in per CLI for this project (provider id -> account id) */
  accounts?: Record<string, string>
}

/** An extra sign-in for a CLI (its own config folder: CLAUDE_CONFIG_DIR / CODEX_HOME) */
export interface Account {
  id: string
  providerId: 'claude' | 'codex'
  name: string
  /** empty = Hive keeps it in its data folder */
  configDir?: string
}

export interface TestResult {
  agentId: string
  ok: boolean
  command: string
  output: string
  at: number
  /** sent back to the agent to fix */
  sentBack?: boolean
}

export interface Workflow {
  id: string
  projectId: string
  name: string
  steps: WorkflowStep[]
}
export interface WorkflowStep {
  agentId: string
  /** {{input}} = what you typed when starting, {{previous}} = the previous step's result */
  prompt: string
}
export interface WorkflowRun {
  id: string
  workflowId: string
  projectId: string
  name: string
  input: string
  step: number
  status: 'running' | 'done' | 'stopped' | 'failed'
  log: { step: number; agentId: string; output: string; at: number }[]
  startedAt: number
}

export interface PlanReview {
  agentId: string
  plan: string
  at: number
}

export interface Conflict {
  file: string
  agentIds: string[]
}

/** App-wide settings kept in state.json (UI-only preferences live in the renderer's localStorage). */
export interface AppSettings {
  /** desktop notifications per event */
  notify: { waiting: boolean; done: boolean; error: boolean; whenFocused: boolean; silent: boolean }
  /** dock / taskbar badge with the number of agents waiting for you */
  badge: boolean
  /** CLI pre-selected for new agents */
  defaultProviderId: string
  /** git worktree isolation for new agents: auto = from the 2nd agent on */
  worktreeDefault: 'auto' | 'always' | 'never'
  /** keep the Mac awake while agents work or dev servers run */
  keepAwake: boolean
  /** pause (stop + resume later) agents idle for this many minutes, 0 = never */
  autoPauseMin: number
  /** give Claude agents the project memory: off / read / read-write */
  memoryMode: 'off' | 'read' | 'readwrite'
  /** rules for AI commit messages */
  commitRules: string
  /** OpenAI key for voice dictation (optional – local whisper is used if found) */
  openaiKey: string
  /** dictation language hint, '' = auto */
  dictationLang: string
  /** local speech-to-text command, {file} = path of a 16 kHz WAV */
  whisperCmd: string
  /** let the message box queue messages while the agent is busy */
  queueWhenBusy: boolean
  /** local port for webhook triggers */
  triggerPort: number
  /** attach the agent's conversation to commits made in Hive (git notes, ref "hive") */
  commitContext: boolean
  /** extra sign-ins (multi-account) */
  accounts: Account[]
  /** account every agent uses unless the project or the agent picks another ('' = your normal login) */
  defaultAccounts?: Record<string, string>
  /** on a usage limit: continue on the next account of the same CLI */
  autoSwitch: boolean
  /** …or, when there is none, hand the task to this CLI ('' = off) */
  fallbackProvider: string
  /** restart the agents and dev servers that were running when Hive quit */
  restoreSession: boolean
  /** language agents should answer in ('' = whatever you write) */
  agentLanguage: string
  /** menu bar / tray icon with the agents' status */
  trayIcon?: boolean
  /** QA browser tools for agents (browser_open, click, type, screenshot, console) */
  browserTools?: boolean
  /** look for a new Hive release on launch and every few hours */
  autoUpdateCheck?: boolean
  lastUpdateCheck?: number
  /** "skip this version" */
  skipVersion?: string
  /** new agents alternate between Claude Code and Codex */
  alternateCli?: boolean
  /** new projects start with the agents of this project ('' / unset = the first project with agents, 'none' = off) */
  newProjectAgents?: string
  /** after a usage limit, continue automatically when the window resets */
  resumeOnReset?: boolean
  /** pass Hive's and the shared MCP servers to Codex agents (-c mcp_servers…) */
  codexMcp?: boolean
  /** read an agent's reply aloud when its turn ends */
  readAloud?: 'off' | 'focused' | 'all'
}

export const DEFAULT_SETTINGS: AppSettings = {
  notify: { waiting: true, done: true, error: true, whenFocused: false, silent: false },
  badge: true,
  defaultProviderId: 'claude',
  worktreeDefault: 'auto',
  keepAwake: true,
  autoPauseMin: 0,
  memoryMode: 'readwrite',
  commitRules: 'Conventional Commits (feat:, fix:, refactor:, docs:, test:, chore:). Imperative mood, subject ≤ 72 chars, short body with the why when useful.',
  openaiKey: '',
  dictationLang: '',
  whisperCmd: '',
  queueWhenBusy: true,
  triggerPort: 4317,
  commitContext: true,
  accounts: [],
  autoSwitch: true,
  fallbackProvider: '',
  restoreSession: true,
  agentLanguage: ''
}

export const DEFAULT_BOARD_PROMPTS: Record<TaskStatus, string> = {
  todo: '',
  doing: 'Work on this task:\n\n# {{title}}\n\n{{body}}\n\nWhen you are done, summarise what you changed.',
  done: 'Review your work on "{{title}}": run the tests / build, double-check edge cases and tell me anything left to do.'
}

export interface DevServer {
  id: string
  projectId: string
  name: string
  command: string
  /** sub-folder of the project to run in ('' = project root) */
  cwd: string
  /** preview URL override (otherwise detected from the output) */
  url?: string
}

export interface ServerRuntime {
  serverId: string
  running: boolean
  url?: string
  startedAt?: number
  exitCode?: number
}

export interface NewAgentInput {
  projectId: string
  name: string
  role: string
  color: string
  providerId: string
  initialPrompt?: string
  useWorktree: boolean
  /** custom branch name when useWorktree is on (default hive/<name>) */
  branch?: string
  parentId?: string
  ssh?: { host: string; path: string }
  /** account id, '' = main login, undefined = project default */
  accountId?: string
  effort?: 'low' | 'medium' | 'high'
}

export interface AgentPatch {
  name?: string
  role?: string
  color?: string
  providerId?: string
  initialPrompt?: string
  /** turn worktree isolation on/off (agent must be stopped) */
  useWorktree?: boolean
  /** rename the agent's branch, or choose it when enabling isolation */
  branch?: string
  /** lead agent id, or '' to detach */
  parentId?: string
  /** null = run locally again */
  ssh?: { host: string; path: string } | null
  /** account id, '' = main login, null = project default */
  accountId?: string | null
  /** '' = CLI default */
  effort?: string
  /** '' = CLI default */
  model?: string
}

export interface TeamEvent {
  kind: 'task' | 'report'
  from: string
  to: string
  text: string
  at: number
}

export interface GitSummary {
  isRepo: boolean
  branch?: string
  files: { path: string; status: string; added?: number; removed?: number }[]
  diff: string
}

/** Element clicked in the dev-server preview */
export interface PickedElement {
  selector: string
  tag: string
  text: string
  html: string
  url: string
  size: string
  style: string
}

/** Database an agent can query (connection string is stored encrypted, never shown to agents) */
export interface DbConnection {
  id: string
  name: string
  type: 'postgres' | 'mysql' | 'mongodb'
  /** undefined = available in every project */
  projectId?: string
  readOnly: boolean
  /** host:port shown in the UI */
  host?: string
}

/** Claude's AskUserQuestion, shown as clickable options */
export interface AgentQuestion {
  agentId: string
  questions: { question: string; header?: string; multiSelect?: boolean; options?: { label: string; description?: string }[] }[]
  at: number
}

/** a newer Hive release on GitHub */
export interface UpdateInfo {
  version: string
  notes: string
  url: string
  asset?: { name: string; url: string; size: number }
  canInstall: boolean
}

/** A local mock API: fixed routes, optional fallback to a real backend, request log */
export interface MockServer {
  id: string
  projectId: string
  name: string
  port: number
  /** started with Hive */
  autoStart: boolean
  /** unmatched requests go here (e.g. https://api.example.com) */
  fallbackUrl?: string
  /** save proxied answers as new routes */
  record?: boolean
  /** extra delay for every answer (ms) */
  latencyMs?: number
  routes: MockRoute[]
}
export interface MockRoute {
  id: string
  /** GET, POST, … or ANY */
  method: string
  /** /users/:id, /files/*, … */
  path: string
  status: number
  /** response body – {{params.id}}, {{query.q}}, {{body.name}}, {{uuid}}, {{now}} are filled in */
  body: string
  /** "Header: value" per line */
  headers?: string
  delayMs?: number
  enabled: boolean
  note?: string
}
export interface MockLogEntry {
  mockId: string
  at: number
  method: string
  path: string
  status: number
  ms: number
  routeId?: string
  proxied?: boolean
  body?: string
}
