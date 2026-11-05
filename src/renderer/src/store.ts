import { speak } from './speech'
import { create } from 'zustand'
import { DEFAULT_SETTINGS, type AgentRuntime, type AppState, type Conflict, type PlanReview, type ServerRuntime, type TeamEvent, type TestResult } from '@shared/types'

type View = 'room' | 'grid' | 'focus' | 'code' | 'servers' | 'usage' | 'settings' | 'board' | 'split' | 'project'

interface Store {
  ready: boolean
  platform: string
  app: AppState
  runtimes: Record<string, AgentRuntime>
  serverRuntimes: Record<string, ServerRuntime>
  lastLines: Record<string, string>
  /** chat view: a slash command whose screen (dialog / picker) only exists in the TUI – shown live */
  livePanels: Record<string, { cmd: string; since: number }>
  setLivePanel: (agentId: string, cmd: string | null) => void
  selectedProjectId: string | null
  focusedAgentId: string | null
  view: View
  showNewAgent: boolean
  lastOverview: Exclude<View, 'focus' | 'settings'>
  init: () => Promise<void>
  selectProject: (id: string | null) => void
  focusAgent: (id: string | null) => void
  /** agents that finished a turn you have not looked at yet */
  unread: Record<string, boolean>
  /** tab to open inside the next view (Workspace / Backlog) */
  subTab: string | null
  openTab: (view: 'project' | 'board', tab: string) => void
  setView: (v: View) => void
  setShowNewAgent: (v: boolean) => void
  menu: { x: number; y: number; agentId: string } | null
  openMenu: (e: { clientX: number; clientY: number; preventDefault: () => void; stopPropagation: () => void }, agentId: string) => void
  closeMenu: () => void
  editingAgentId: string | null
  setEditingAgent: (id: string | null) => void
  codeRoot: string | null
  codeOpen: { root: string; path: string; line?: number } | null
  setCodeRoot: (root: string) => void
  /** switch to the Code view, optionally rooted at a folder and opening a file */
  openCode: (root?: string, path?: string, line?: number) => void
  accent: string
  setAccent: (a: string) => void
  /** chosen theme ('system' follows the OS) and the one actually applied */
  theme: ThemeId
  resolvedTheme: 'dark' | 'midnight' | 'light'
  setTheme: (t: ThemeId) => void
  groupBy: 'status' | 'team'
  setGroupBy: (g: 'status' | 'team') => void
  newAgentParentId: string | null
  addMember: (leadId: string) => void
  teamEvents: TeamEvent[]
  showLibrary: null | 'prompts' | 'roles'
  setShowLibrary: (t: null | 'prompts' | 'roles') => void
  promptTarget: { agentIds: string[]; x: number; y: number } | null
  plans: Record<string, PlanReview>
  planOpen: string | null
  tests: Record<string, TestResult>
  testing: Record<string, boolean>
  conflicts: Conflict[]
  budget: Record<string, number>
  /** short reactions shown above agents in the office */
  emotes: Record<string, { kind: string; at: number }>
  emote: (agentIds: string[], kind: string) => void
  replayFor: string | null
  askTarget: string | null
  morphTarget: { agentId: string; x: number; y: number } | null
  /** agent pre-selected when opening the schedule editor */
  scheduleFor: string | null
  /** ⌘K */
  paletteOpen: boolean
  setPalette: (v: boolean) => void
  /** Mac kept awake right now */
  awake: boolean
  /** screenshots waiting to be attached to the next message (⌘⇧2) */
  pendingShots: { path: string; dataUrl: string }[]
  takeShots: () => { path: string; dataUrl: string }[]
  /** text the palette wants to put into the focused composer */
  composerInsert: { text: string; n: number } | null
  insertIntoComposer: (text: string) => void
  toasts: Toast[]
  toast: (text: string, kind?: Toast['kind']) => void
}

export interface Toast {
  id: number
  text: string
  kind: 'info' | 'error' | 'success'
}
let toastSeq = 0

/** Terminal output fan-out: one IPC listener, many xterm instances. */
type DataListener = (data: string) => void
const dataListeners = new Map<string, Set<DataListener>>()
export function subscribeAgentData(agentId: string, fn: DataListener): () => void {
  if (!dataListeners.has(agentId)) dataListeners.set(agentId, new Set())
  dataListeners.get(agentId)!.add(fn)
  return () => dataListeners.get(agentId)?.delete(fn)
}

export const useStore = create<Store>((set, get) => ({
  ready: false,
  platform: 'darwin',
  app: { projects: [], agents: [], providers: [], prompts: [], roles: [], servers: [], settings: DEFAULT_SETTINGS, tasks: [], schedules: [], skills: [], mcpServers: [], boardPrompts: { todo: '', doing: '', done: '' }, memory: {}, projectSettings: {}, workflows: [], workflowRuns: [], ideas: [], triggers: [] },
  serverRuntimes: {},
  runtimes: {},
  lastLines: {},
  livePanels: {},
  setLivePanel: (agentId, cmd) => {
    const { [agentId]: _, ...rest } = get().livePanels
    set({ livePanels: cmd ? { ...rest, [agentId]: { cmd, since: Date.now() } } : rest })
  },
  selectedProjectId: null,
  focusedAgentId: null,
  view: 'room',
  showNewAgent: false,
  lastOverview: 'room',
  plans: {},
  planOpen: null,
  tests: {},
  testing: {},
  conflicts: [],
  budget: {},
  emotes: {},
  emote: (agentIds, kind) => {
    const at = Date.now()
    set({ emotes: { ...get().emotes, ...Object.fromEntries(agentIds.map((id) => [id, { kind, at }])) } })
    setTimeout(() => {
      const cur = { ...get().emotes }
      for (const id of agentIds) if (cur[id]?.at === at) delete cur[id]
      set({ emotes: cur })
    }, kind === 'party' ? 7000 : 5500)
  },
  replayFor: null,
  askTarget: null,
  morphTarget: null,
  scheduleFor: null,
  paletteOpen: false,
  setPalette: (paletteOpen) => set({ paletteOpen }),
  awake: false,
  pendingShots: [],
  takeShots: () => {
    const s = get().pendingShots
    if (s.length) set({ pendingShots: [] })
    return s
  },
  composerInsert: null,
  insertIntoComposer: (text) => set({ composerInsert: { text, n: Date.now() } }),

  init: async () => {
    const { state, runtimes, servers, platform } = await window.api.getState()
    set({
      ready: true,
      platform,
      app: state,
      runtimes: Object.fromEntries(runtimes.map((r) => [r.agentId, r])),
      serverRuntimes: Object.fromEntries(servers.map((r) => [r.serverId, r])),
      selectedProjectId: state.projects[0]?.id ?? null
    })
    const au = window.api.automation
    au.plans().then((l) => set({ plans: Object.fromEntries(l.map((p) => [p.agentId, p])) }))
    au.lastTests().then((l) => set({ tests: Object.fromEntries(l.map((r) => [r.agentId, r])) }))
    au.conflicts().then((conflicts) => set({ conflicts }))
    au.budgetToday().then((budget) => set({ budget }))
    au.onPlan((p) => {
      set({ plans: { ...get().plans, [p.agentId]: p } })
      if (get().focusedAgentId === p.agentId) set({ planOpen: p.agentId })
      get().emote([p.agentId], 'idea')
    })
    au.onPlanCleared((id) => {
      const { [id]: _gone, ...rest } = get().plans
      set({ plans: rest, planOpen: get().planOpen === id ? null : get().planOpen })
    })
    au.onTestsRunning(({ agentId }) => set({ testing: { ...get().testing, [agentId]: true } }))
    au.onTestResult((r) => {
      set({ tests: { ...get().tests, [r.agentId]: r }, testing: { ...get().testing, [r.agentId]: false } })
      const a = get().app.agents.find((x) => x.id === r.agentId)
      get().emote([r.agentId], r.ok ? 'thumbs' : 'facepalm')
      if (!r.ok) get().toast(`🧪 ${a?.name}: tests failed${r.sentBack ? ' – sent back to fix' : ''}`, 'error')
    })
    au.onConflicts((conflicts) => set({ conflicts }))
    au.onBudget((budget) => set({ budget }))
    window.api.onEmote(({ agentIds, kind }) => get().emote(agentIds, kind))
    window.api.onAwake((awake) => get().awake !== awake && set({ awake }))
    window.api.media.onAttach((shot) => {
      set({ pendingShots: [...get().pendingShots, shot] })
      get().toast('Screenshot attached to your next message', 'success')
    })
    window.api.onToast((text) => get().toast(text, 'success'))
    window.api.onOpenSettings(() => get().setView('settings'))
    window.api.onLimit((id) => {
      const a = get().app.agents.find((x) => x.id === id)
      get().toast(`${a?.name ?? 'Agent'} hit its usage limit${get().app.settings.autoSwitch ? ' – switching account / CLI…' : ''}`, 'error')
    })
    window.api.onProjectPaused((pid) => {
      const p = get().app.projects.find((x) => x.id === pid)
      get().toast(`${p?.name ?? 'Project'} paused – safe to close`, 'success')
    })
    window.api.onState((s) => {
      const sel = get().selectedProjectId
      set({
        app: s,
        selectedProjectId: s.projects.some((p) => p.id === sel) ? sel : (s.projects[0]?.id ?? null)
      })
      const f = get().focusedAgentId
      if (f && !s.agents.some((a) => a.id === f)) set({ focusedAgentId: null, view: get().lastOverview })
    })
    window.api.onRuntime((rt) => {
      const prev = get().runtimes[rt.agentId]?.status
      const ra = get().app.settings.readAloud ?? 'off'
      if (prev === 'working' && (rt.status === 'waiting' || rt.status === 'done') && ra !== 'off' && (ra === 'all' || get().focusedAgentId === rt.agentId)) {
        window.api.conversation(rt.agentId).then((c) => {
          const last = [...(c?.items ?? [])].reverse().find((i) => i.kind === 'assistant')
          if (last) speak(last.text)
        }).catch(() => undefined)
      }
      const looking = get().view === 'focus' && get().focusedAgentId === rt.agentId && document.hasFocus()
      const finished = prev === 'working' && (rt.status === 'waiting' || rt.status === 'done' || rt.status === 'error')
      set({
        runtimes: { ...get().runtimes, [rt.agentId]: rt },
        ...(finished && !looking ? { unread: { ...get().unread, [rt.agentId]: true } } : rt.status === 'working' && get().unread[rt.agentId] ? { unread: Object.fromEntries(Object.entries(get().unread).filter(([k]) => k !== rt.agentId)) } : {})
      })
    })
    window.api.onData(({ agentId, data }) => dataListeners.get(agentId)?.forEach((fn) => fn(data)))
    window.api.servers.onData(({ serverId, data }) => dataListeners.get(`srv:${serverId}`)?.forEach((fn) => fn(data)))
    window.api.servers.onRuntime((rt) => set({ serverRuntimes: { ...get().serverRuntimes, [rt.serverId]: rt } }))
    // "what is the agent doing" – computed in the main process from the rendered screen
    window.api.onActivity(({ agentId, text }) => set({ lastLines: { ...get().lastLines, [agentId]: text } }))
    window.api.onTeamEvent((e) => {
      set({ teamEvents: [...get().teamEvents, e].slice(-100) })
      get().toast(e.kind === 'task' ? `${e.from} → ${e.to}: ${e.text.slice(0, 80)}` : `${e.from} reported to ${e.to}: ${e.text.slice(0, 80)}`, 'info')
    })
    if (state.agents.some((a) => a.parentId)) set({ groupBy: 'team' })
    window.api.onFocusAgent((id) => {
      const agent = get().app.agents.find((a) => a.id === id)
      if (agent) set({ selectedProjectId: agent.projectId, focusedAgentId: id, view: 'focus' })
    })
  },
  selectProject: (id) => set({ selectedProjectId: id, view: get().view === 'focus' ? 'room' : get().view, focusedAgentId: null }),
  unread: {},
  subTab: null,
  openTab: (view, tab) => {
    set({ subTab: tab })
    get().setView(view)
  },
  focusAgent: (id) => {
    const u = get().unread
    set({ focusedAgentId: id, view: id ? 'focus' : get().lastOverview, ...(id && u[id] ? { unread: Object.fromEntries(Object.entries(u).filter(([k]) => k !== id)) } : {}) })
  },
  setView: (view) => set(view === 'focus' || view === 'settings' ? { view } : { view, lastOverview: view }),
  setShowNewAgent: (showNewAgent) => set(showNewAgent ? { showNewAgent } : { showNewAgent, newAgentParentId: null }),
  menu: null,
  openMenu: (e, agentId) => {
    e.preventDefault()
    e.stopPropagation()
    set({ menu: { x: e.clientX, y: e.clientY, agentId } })
  },
  closeMenu: () => set({ menu: null }),
  editingAgentId: null,
  setEditingAgent: (editingAgentId) => set({ editingAgentId, menu: null }),
  codeRoot: null,
  codeOpen: null,
  setCodeRoot: (codeRoot) => set({ codeRoot }),
  openCode: (root, path, line) =>
    set({
      view: 'code',
      ...(root ? { codeRoot: root } : {}),
      codeOpen: root && path ? { root, path, line } : null
    }),
  theme: readTheme(),
  resolvedTheme: applyTheme(readTheme()),
  setTheme: (theme) => {
    try {
      localStorage.setItem('hive.theme', theme)
    } catch {
      /* storage unavailable */
    }
    set({ theme, resolvedTheme: applyTheme(theme) })
  },
  accent: readAccent(),
  setAccent: (accent) => {
    document.documentElement.dataset.accent = accent
    try {
      localStorage.setItem('hive.accent', accent)
    } catch {
      /* storage unavailable */
    }
    set({ accent })
  },
  groupBy: 'status',
  setGroupBy: (groupBy) => set({ groupBy }),
  newAgentParentId: null,
  addMember: (leadId) => set({ newAgentParentId: leadId, showNewAgent: true, menu: null }),
  teamEvents: [],
  showLibrary: null,
  setShowLibrary: (showLibrary) => set({ showLibrary }),
  promptTarget: null,
  toasts: [],
  toast: (text, kind = 'info') => {
    const t = { id: ++toastSeq, text, kind }
    set({ toasts: [...get().toasts, t].slice(-4) })
    setTimeout(() => set({ toasts: get().toasts.filter((x) => x.id !== t.id) }), kind === 'error' ? 7000 : 3500)
  }
}))



export type ThemeId = 'dark' | 'midnight' | 'light' | 'system'
export const THEMES: { id: ThemeId; name: string; hint: string }[] = [
  { id: 'dark', name: 'Dark', hint: 'Warm graphite (default)' },
  { id: 'midnight', name: 'Midnight', hint: 'Deeper, blue-black' },
  { id: 'light', name: 'Light', hint: 'Bright, for daylight' },
  { id: 'system', name: 'System', hint: 'Follows macOS / Windows' }
]
function readTheme(): ThemeId {
  try {
    return (localStorage.getItem('hive.theme') as ThemeId) || 'dark'
  } catch {
    return 'dark'
  }
}
function applyTheme(t: ThemeId): 'dark' | 'midnight' | 'light' {
  const r = t === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : t
  document.documentElement.dataset.theme = r
  return r
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  const s = useStore.getState()
  if (s.theme === 'system') useStore.setState({ resolvedTheme: applyTheme('system') })
})

export const ACCENTS: { id: string; color: string; name: string }[] = [
  { id: 'violet', color: '#8b7cf6', name: 'Violet' },
  { id: 'blue', color: '#4f8cff', name: 'Blue' },
  { id: 'teal', color: '#2dd4bf', name: 'Teal' },
  { id: 'rose', color: '#f472b6', name: 'Rose' },
  { id: 'lime', color: '#a3e635', name: 'Lime' },
  { id: 'orange', color: '#f97316', name: 'Orange' }
]

function readAccent(): string {
  let a = 'violet'
  try {
    a = localStorage.getItem('hive.accent') || a
  } catch {
    /* storage unavailable */
  }
  document.documentElement.dataset.accent = a
  return a
}

/** Current terminal colours derived from the CSS theme. */
export function terminalTheme() {
  const css = getComputedStyle(document.documentElement)
  const v = (n: string): string => css.getPropertyValue(n).trim()
  if (document.documentElement.dataset.theme === 'light')
    return {
      background: v('--bg-2') || '#ffffff',
      foreground: '#1f2330',
      cursor: v('--accent') || '#7c6cf0',
      cursorAccent: '#ffffff',
      selectionBackground: '#cfd6e6',
      black: '#1f2330', brightBlack: '#6b7280',
      red: '#c8323f', brightRed: '#e0485a',
      green: '#1b8a4f', brightGreen: '#23a35f',
      yellow: '#a86b00', brightYellow: '#c27d00',
      blue: '#2b5fd9', brightBlue: '#3b72f0',
      magenta: '#8a3fd1', brightMagenta: '#a052e8',
      cyan: '#0f8292', brightCyan: '#139bad',
      white: '#c9ced9', brightWhite: '#8b93a7'
    }
  return {
    background: v('--bg-2') || '#121318',
    foreground: '#e6e8ef',
    cursor: v('--accent-2') || '#a99cff',
    cursorAccent: v('--bg-2') || '#121318',
    selectionBackground: v('--panel-3') || '#242833',
    black: '#252834', brightBlack: '#5d6375',
    red: '#f0717d', brightRed: '#ff8f99',
    green: '#7dd3a0', brightGreen: '#9be7b8',
    yellow: '#f5c66b', brightYellow: '#ffd98f',
    blue: '#7aa8ff', brightBlue: '#9cc0ff',
    magenta: '#c4a5ff', brightMagenta: '#d9c4ff',
    cyan: '#67d4e0', brightCyan: '#8de6ef',
    white: '#d5d8e2', brightWhite: '#ffffff'
  }
}
