import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { applyTheme, monaco } from './monaco'
import { installJetBrainsKeymap, KEYMAP_HELP, type KeymapId } from './keymaps'
import { useStore } from '../store'
import { clamp, fontStack, useLayout } from '../layout'
import { Resizer } from '../components/Resizer'
import { Icon, cleanError } from '../components/common'
import { FileIcon } from './FileIcon'
import { loadWorkspace, SOURCE_RE } from './intellisense'
import { MarkdownPreview } from './MarkdownPreview'

type Entry = { name: string; path: string; dir: boolean }
type Tab = { path: string; dirty: boolean; kind: 'text' | 'binary' | 'large'; stale?: boolean }
type Menu = { x: number; y: number; entry: Entry | null }
type Ask = { title: string; value: string; ok: string; run: (v: string) => Promise<void> | void }

const modelUri = (root: string, path: string): monaco.Uri => monaco.Uri.file(`${root}/${path}`)

export default function CodeView() {
  const { app, selectedProjectId, codeRoot, codeOpen, setCodeRoot, toast, accent } = useStore()
  const L = useLayout()
  const project = app.projects.find((p) => p.id === selectedProjectId)!
  const roots = useMemo(
    () => [
      { path: project.path, label: `${project.name} (project folder)` },
      ...app.agents
        .filter((a) => a.projectId === project.id && a.worktreePath)
        .map((a) => ({ path: a.worktreePath!, label: `${a.name} · ${a.branch}` }))
    ],
    [app.agents, project]
  )
  const root = roots.some((r) => r.path === codeRoot) ? codeRoot! : project.path

  // ---------- explorer state ----------
  const [tree, setTree] = useState<Record<string, Entry[]>>({})
  const [open, setOpen] = useState<Set<string>>(new Set(['']))
  const [git, setGit] = useState<Record<string, string>>({})
  const [selected, setSelected] = useState<string | null>(null)
  const [menu, setMenu] = useState<Menu | null>(null)
  const [ask, setAsk] = useState<Ask | null>(null)
  const [quick, setQuick] = useState<null | 'files' | 'recent'>(null)
  const [showKeys, setShowKeys] = useState(false)
  const [ides, setIdes] = useState<{ id: string; name: string; family: string }[]>([])
  const [ideMenu, setIdeMenu] = useState<false | { x: number; y: number }>(false)

  // ---------- editor state ----------
  const [tabs, setTabs] = useState<Tab[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [cursor, setCursor] = useState({ line: 1, col: 1 })
  const host = useRef<HTMLDivElement>(null)
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const jbKey = useRef<monaco.editor.IContextKey<boolean> | null>(null)
  const saved = useRef(new Map<string, number>()) // path -> alternative version id at last save
  const viewStates = useRef(new Map<string, monaco.editor.ICodeEditorViewState | null>())
  const recent = useRef<string[]>([])
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs
  const activeRef = useRef(active)
  activeRef.current = active
  const base = useRef(0)
  const rootRef = useRef(root)
  rootRef.current = root
  const autoTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const [lastSaved, setLastSaved] = useState<number | null>(null)
  const [sense, setSense] = useState({ loading: false, files: 0, libs: 0 })

  /** Write one open file to disk. Auto-saves never overwrite a file an agent changed meanwhile. */
  const saveFile = useRef(async (path: string, auto = false): Promise<void> => {
    const r = rootRef.current
    const m = monaco.editor.getModel(modelUri(r, path))
    if (!m) return
    const tab = tabsRef.current.find((t) => t.path === path)
    const version = m.getAlternativeVersionId()
    if (auto && (!tab || tab.stale || saved.current.get(path) === version)) return
    clearTimeout(autoTimers.current.get(path))
    try {
      await window.api.fs.write(r, path, m.getValue())
      saved.current.set(path, version)
      const stillClean = m.getAlternativeVersionId() === version
      setTabs((ts) => ts.map((t) => (t.path === path ? { ...t, dirty: !stillClean, stale: false } : t)))
      setLastSaved(Date.now())
    } catch (e) {
      useStore.getState().toast(cleanError(e), 'error')
    }
  }).current
  const flushAuto = (): void => {
    if (useLayout.getState().autoSave === 'off') return
    for (const t of tabsRef.current) if (t.dirty) saveFile(t.path, true)
  }

  const loadDir = useCallback(
    async (rel: string) => {
      try {
        const items = await window.api.fs.list(root, rel)
        setTree((t) => ({ ...t, [rel]: items }))
      } catch (e) {
        if (rel === '') toast(cleanError(e), 'error')
      }
    },
    [root, toast]
  )
  const loadGit = useCallback(async () => {
    try {
      const files = await window.api.fs.gitStatus(root)
      setGit(Object.fromEntries(files.map((f) => [f.path.replace(/\/$/, ''), f.status.trim()[0] ?? '?'])))
    } catch {
      setGit({})
    }
  }, [root])

  // switch root: reset explorer, close tabs from the other root
  useEffect(() => {
    setTree({})
    setOpen(new Set(['']))
    setTabs([])
    setActive(null)
    editor.current?.setModel(null)
    loadDir('')
    loadGit()
    window.api.fs.watch(root)
    let cancelled = false
    let ws: { dispose: () => void } | null = null
    setSense({ loading: true, files: 0, libs: 0 })
    loadWorkspace(root, () => cancelled).then((w) => {
      if (cancelled) return w.dispose()
      ws = w
      setSense({ loading: false, files: w.files, libs: w.libs })
    })
    return () => {
      cancelled = true
      ws?.dispose()
      window.api.fs.unwatch(root)
    }
  }, [root]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    window.api.fs.ides().then(setIdes).catch(() => setIdes([]))
  }, [])

  // ---------- monaco ----------
  useEffect(() => {
    applyTheme()
    const ed = monaco.editor.create(host.current!, {
      model: null,
      theme: 'hive',
      automaticLayout: true,
      fontFamily: fontStack(useLayout.getState().editorFont),
      fontSize: useLayout.getState().editorFontSize,
      lineHeight: Math.round(useLayout.getState().editorFontSize * 1.55),
      fontLigatures: useLayout.getState().editorLigatures,
      wordWrap: useLayout.getState().editorWrap ? 'on' : 'off',
      minimap: { enabled: useLayout.getState().editorMinimap, scale: 1, renderCharacters: false },
      smoothScrolling: true,
      cursorSmoothCaretAnimation: 'on',
      renderWhitespace: 'selection',
      bracketPairColorization: { enabled: true },
      guides: { bracketPairs: true, indentation: true },
      stickyScroll: { enabled: true },
      padding: { top: 10 },
      scrollBeyondLastLine: false,
      tabSize: useLayout.getState().editorTabSize,
      // completion / IntelliSense
      quickSuggestions: { other: 'on', comments: 'off', strings: 'on' },
      quickSuggestionsDelay: 10,
      suggestOnTriggerCharacters: true,
      acceptSuggestionOnEnter: 'on',
      tabCompletion: 'on',
      wordBasedSuggestions: 'allDocuments',
      suggestSelection: 'recentlyUsedByPrefix',
      snippetSuggestions: 'inline',
      parameterHints: { enabled: true, cycle: true },
      inlineSuggest: { enabled: true },
      suggest: { preview: true, showStatusBar: true, localityBonus: true, showWords: true, insertMode: 'replace' },
      autoClosingBrackets: 'languageDefined',
      autoClosingQuotes: 'languageDefined',
      autoIndent: 'full',
      formatOnPaste: true,
      linkedEditing: true,
      hover: { enabled: true, delay: 300 }
    })
    editor.current = ed
    jbKey.current = installJetBrainsKeymap(monaco, ed, { quickOpen: () => setQuick('files'), recentFiles: () => setQuick('recent') })
    ed.onDidChangeCursorPosition((e) => setCursor({ line: e.position.lineNumber, col: e.position.column }))
    ed.onDidChangeModelContent(() => {
      const p = activeRef.current
      const m = ed.getModel()
      if (!p || !m) return
      const dirty = saved.current.get(p) !== m.getAlternativeVersionId()
      setTabs((ts) => ts.map((t) => (t.path === p && t.dirty !== dirty ? { ...t, dirty } : t)))
      // auto save after a pause in typing
      const { autoSave, autoSaveDelay } = useLayout.getState()
      if (dirty && autoSave === 'afterDelay') {
        clearTimeout(autoTimers.current.get(p))
        autoTimers.current.set(p, setTimeout(() => saveFile(p, true), autoSaveDelay))
      }
    })
    // leaving the editor saves too (both auto-save modes)
    ed.onDidBlurEditorText(() => flushAuto())
    const onWinBlur = (): void => flushAuto()
    window.addEventListener('blur', onWinBlur)
    return () => {
      window.removeEventListener('blur', onWinBlur)
      flushAuto()
      autoTimers.current.forEach((t) => clearTimeout(t))
      ed.dispose()
      monaco.editor.getModels().forEach((m) => m.dispose())
      editor.current = null
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    jbKey.current?.set(L.keymap === 'jetbrains')
  }, [L.keymap])
  const resolvedTheme = useStore((s) => s.resolvedTheme)
  useEffect(() => {
    requestAnimationFrame(applyTheme)
  }, [accent, resolvedTheme])
  // Settings → Editor, applied live
  useEffect(() => {
    editor.current?.updateOptions({
      fontFamily: fontStack(L.editorFont),
      fontSize: L.editorFontSize,
      lineHeight: Math.round(L.editorFontSize * 1.55),
      fontLigatures: L.editorLigatures,
      wordWrap: L.editorWrap ? 'on' : 'off',
      minimap: { enabled: L.editorMinimap },
      tabSize: L.editorTabSize
    })
  }, [L.editorFont, L.editorFontSize, L.editorLigatures, L.editorWrap, L.editorMinimap, L.editorTabSize])

  // ---------- open / save / close ----------
  const openFile = useCallback(
    async (path: string, line?: number) => {
      const ed = editor.current
      if (!ed) return
      const cur = activeRef.current
      if (cur) viewStates.current.set(cur, ed.saveViewState())
      if (cur && cur !== path) flushAuto()
      setSelected(path)
      recent.current = [path, ...recent.current.filter((p) => p !== path)].slice(0, 30)
      // reveal in tree
      const parts = path.split('/')
      const parents = parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'))
      setOpen((o) => new Set([...o, ...parents]))
      parents.forEach((d) => !tree[d] && loadDir(d))

      let model = monaco.editor.getModel(modelUri(root, path))
      let kind: Tab['kind'] = 'text'
      if (model && !saved.current.has(path)) saved.current.set(path, model.getAlternativeVersionId())
      if (!model) {
        try {
          const f = await window.api.fs.read(root, path)
          if (f.binary || f.tooLarge) kind = f.binary ? 'binary' : 'large'
          else {
            model = monaco.editor.createModel(f.content, undefined, modelUri(root, path))
            saved.current.set(path, model.getAlternativeVersionId())
          }
        } catch (e) {
          // a link to a folder: show it in the tree instead
          if (/EISDIR|is a directory/i.test(String((e as Error)?.message ?? e))) {
            setOpen((o) => new Set([...o, path]))
            if (!tree[path]) loadDir(path)
            return
          }
          toast(cleanError(e), 'error')
          return
        }
      }
      setTabs((ts) => (ts.some((t) => t.path === path) ? ts : [...ts, { path, dirty: false, kind }]))
      setActive(path)
      ed.setModel(model ?? null)
      if (model) {
        // pop-up suggestions only make sense for code, not prose
        const prose = ['markdown', 'plaintext'].includes(model.getLanguageId())
        ed.updateOptions({ quickSuggestions: prose ? false : { other: 'on', comments: 'off', strings: 'on' } })
        const vs = viewStates.current.get(path)
        if (vs) ed.restoreViewState(vs)
        if (line) {
          ed.revealLineInCenter(line)
          ed.setPosition({ lineNumber: line, column: 1 })
        }
        ed.focus()
      }
    },
    [root, tree, loadDir, toast]
  )

  const saveActive = async (): Promise<void> => {
    if (activeRef.current) await saveFile(activeRef.current)
  }

  const closeTab = (path: string): void => {
    const t = tabsRef.current.find((x) => x.path === path)
    if (t?.dirty && !confirm(`${path} has unsaved changes. Close anyway?`)) return
    monaco.editor.getModel(modelUri(root, path))?.dispose()
    saved.current.delete(path)
    viewStates.current.delete(path)
    const rest = tabsRef.current.filter((x) => x.path !== path)
    setTabs(rest)
    if (activeRef.current === path) {
      const next = rest[rest.length - 1]
      if (next) openFile(next.path)
      else {
        setActive(null)
        editor.current?.setModel(null)
      }
    }
  }

  // pending "open this file" requests from elsewhere (Changes panel, etc.)
  useEffect(() => {
    if (codeOpen && codeOpen.root === root) {
      openFile(codeOpen.path, codeOpen.line)
      useStore.setState({ codeOpen: null })
    }
  }, [codeOpen, root, openFile])

  // ---------- disk changes ----------
  useEffect(
    () =>
      window.api.fs.onChanged(({ root: r, paths }) => {
        if (r !== root) return
        const dirs = new Set(paths.map((p) => p.split('/').slice(0, -1).join('/')))
        dirs.forEach((d) => tree[d] && loadDir(d))
        loadGit()
        for (const path of paths) {
          const t = tabsRef.current.find((x) => x.path === path)
          if (t && t.kind !== 'text') continue
          const m = monaco.editor.getModel(modelUri(root, path))
          if (t?.dirty && m) {
            setTabs((ts) => ts.map((x) => (x.path === path ? { ...x, stale: true } : x)))
            continue
          }
          // keep open tabs AND background IntelliSense models in sync with disk
          if (!m && !SOURCE_RE.test(path)) continue
          window.api.fs.readOptional(root, path).then((content) => {
            const cur = monaco.editor.getModel(modelUri(root, path))
            if (content === null) {
              // deleted (or now a folder): drop background models, keep open tabs
              if (cur && !t) cur.dispose()
              return
            }
            if (content.includes('\u0000')) return // binary
            if (!cur) {
              if (SOURCE_RE.test(path)) monaco.editor.createModel(content, undefined, modelUri(root, path))
              return
            }
            if (content === cur.getValue()) return
            cur.pushEditOperations([], [{ range: cur.getFullModelRange(), text: content }], () => null)
            if (t) {
              saved.current.set(path, cur.getAlternativeVersionId())
              setTabs((ts) => ts.map((x) => (x.path === path ? { ...x, dirty: false } : x)))
            }
          })
        }
      }),
    [root, tree, loadDir, loadGit]
  )

  // ---------- global shortcuts ----------
  useEffect(() => {
    let lastShift = 0
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key.toLowerCase() === 'p' && !e.shiftKey) (e.preventDefault(), setQuick('files'))
      else if (mod && e.key.toLowerCase() === 's') (e.preventDefault(), saveActive())
      else if (mod && e.key.toLowerCase() === 'w' && activeRef.current) (e.preventDefault(), closeTab(activeRef.current))
      else if (e.key === 'Shift' && !e.repeat && L.keymap === 'jetbrains') {
        const now = Date.now()
        if (now - lastShift < 350) setQuick('files')
        lastShift = now
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // ---------- file operations ----------
  const parentOf = (e: Entry | null): string => (!e ? '' : e.dir ? e.path : e.path.split('/').slice(0, -1).join('/'))
  const join = (dir: string, name: string): string => (dir ? `${dir}/${name}` : name)
  const fileOps = {
    newFile: (e: Entry | null) =>
      setAsk({
        title: `New file in /${parentOf(e)}`, value: '', ok: 'Create',
        run: async (name) => {
          const p = join(parentOf(e), name)
          await window.api.fs.create(root, p, false)
          await loadDir(parentOf(e))
          openFile(p)
        }
      }),
    newFolder: (e: Entry | null) =>
      setAsk({
        title: `New folder in /${parentOf(e)}`, value: '', ok: 'Create',
        run: async (name) => {
          await window.api.fs.create(root, join(parentOf(e), name), true)
          await loadDir(parentOf(e))
          setOpen((o) => new Set([...o, parentOf(e)]))
        }
      }),
    rename: (e: Entry) =>
      setAsk({
        title: `Rename ${e.name}`, value: e.name, ok: 'Rename',
        run: async (name) => {
          const dir = e.path.split('/').slice(0, -1).join('/')
          const to = join(dir, name)
          await window.api.fs.move(root, e.path, to)
          if (tabsRef.current.some((t) => t.path === e.path)) {
            closeTab(e.path)
            openFile(to)
          }
          loadDir(dir)
        }
      }),
    trash: async (e: Entry) => {
      if (!confirm(`Move ${e.path} to the Trash?`)) return
      try {
        await window.api.fs.trash(root, e.path)
        tabsRef.current.filter((t) => t.path === e.path || t.path.startsWith(e.path + '/')).forEach((t) => closeTab(t.path))
        loadDir(e.path.split('/').slice(0, -1).join('/'))
      } catch (err) {
        toast(cleanError(err), 'error')
      }
    }
  }

  const toggleDir = (e: Entry): void => {
    setSelected(e.path)
    setOpen((o) => {
      const n = new Set(o)
      if (n.has(e.path)) n.delete(e.path)
      else {
        n.add(e.path)
        if (!tree[e.path]) loadDir(e.path)
      }
      return n
    })
  }

  // folder status = any changed file inside
  const dirStatus = useMemo(() => {
    const m: Record<string, string> = {}
    for (const [p, s] of Object.entries(git)) {
      const parts = p.split('/')
      for (let i = 1; i < parts.length; i++) m[parts.slice(0, i).join('/')] ||= s === '?' ? 'U' : 'M'
    }
    return m
  }, [git])

  const renderDir = (rel: string, depth: number): React.ReactNode =>
    (tree[rel] ?? []).map((e) => {
      const st = e.dir ? dirStatus[e.path] : git[e.path]
      const stCls = st ? `g-${st === '?' ? 'U' : st}` : ''
      return (
        <div key={e.path}>
          <div
            className={`tree-item ${selected === e.path ? 'sel' : ''} ${active === e.path ? 'active' : ''} ${stCls}`}
            style={{ paddingLeft: 8 + depth * 14 }}
            onClick={() => (e.dir ? toggleDir(e) : openFile(e.path))}
            onContextMenu={(ev) => {
              ev.preventDefault()
              ev.stopPropagation()
              setSelected(e.path)
              setMenu({ x: ev.clientX, y: ev.clientY, entry: e })
            }}
            title={e.path}
          >
            <span className={`twisty ${e.dir ? (open.has(e.path) ? 'open' : '') : 'none'}`}>
              {e.dir && <Icon name="chevron" size={11} />}
            </span>
            <FileIcon name={e.name} dir={e.dir} open={open.has(e.path)} />
            <span className="tname">{e.name}</span>
            {st && <span className="tstat">{st === '?' ? 'U' : st}</span>}
          </div>
          {e.dir && open.has(e.path) && renderDir(e.path, depth + 1)}
        </div>
      )
    })

  const activeTab = tabs.find((t) => t.path === active)
  const lang = editor.current?.getModel()?.getLanguageId()
  const isMd = !!active && /\.(md|mdx|markdown)$/i.test(active) && activeTab?.kind === 'text'
  const activeModel = active ? monaco.editor.getModel(modelUri(root, active)) : null

  return (
    <div className="code-view" style={{ gridTemplateColumns: `${L.explorerW}px 6px minmax(0, 1fr)` }}>
      {/* explorer */}
      <aside className="explorer" onContextMenu={(e) => (e.preventDefault(), setMenu({ x: e.clientX, y: e.clientY, entry: null }))}>
        <div className="explorer-head">
          <select value={root} onChange={(e) => setCodeRoot(e.target.value)} title={root}>
            {roots.map((r) => <option key={r.path} value={r.path}>{r.label}</option>)}
          </select>
        </div>
        <div className="explorer-tools">
          <span>Explorer</span>
          <div className="spacer" />
          <button className="icon-btn" title="New file" onClick={() => fileOps.newFile(null)}><Icon name="filePlus" size={14} /></button>
          <button className="icon-btn" title="New folder" onClick={() => fileOps.newFolder(null)}><Icon name="folderPlus" size={14} /></button>
          <button className="icon-btn" title="Refresh" onClick={() => { Object.keys(tree).forEach((d) => loadDir(d)); loadGit() }}><Icon name="refresh" size={13} /></button>
          <button className="icon-btn" title="Collapse all" onClick={() => setOpen(new Set(['']))}><Icon name="collapseAll" size={14} /></button>
        </div>
        <div className="file-tree" onClick={(e) => e.currentTarget === e.target && setSelected(null)}>{renderDir('', 0)}</div>
      </aside>
      <Resizer axis="x" onStart={() => (base.current = L.explorerW)} onDrag={(d) => L.set({ explorerW: clamp(base.current + d, 160, 600) })} onReset={() => L.reset('explorerW')} />

      {/* editor */}
      <section className="editor-area">
        <div className="tabs">
          {tabs.map((t) => (
            <div key={t.path} className={`tab ${t.path === active ? 'on' : ''}`} onClick={() => openFile(t.path)}
              onMouseDown={(e) => e.button === 1 && (e.preventDefault(), closeTab(t.path))} title={t.path}>
              <FileIcon name={t.path.split('/').pop()!} />
              <span>{t.path.split('/').pop()}</span>
              {t.stale && <span className="tab-stale" title="Changed on disk">!</span>}
              <button className={`tab-x ${t.dirty ? 'dirty' : ''}`} onClick={(e) => (e.stopPropagation(), closeTab(t.path))} title="Close">
                <span className="dot-dirty" />
                <Icon name="x" size={12} />
              </button>
            </div>
          ))}
          <div className="spacer" />
          <div className="tab-tools">
            <button className="icon-btn" title="Go to file (⌘P)" onClick={() => setQuick('files')}><Icon name="search" size={14} /></button>
            <div className="ide-wrap">
              <button className="btn ghost sm" title="Open in an installed IDE"
                onClick={(e) => {
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                  setIdeMenu(ideMenu ? false : { x: r.right, y: r.bottom + 6 })
                  window.api.fs.ides().then(setIdes).catch(() => setIdes([]))
                }}>
                <Icon name="external" size={13} /> Open in IDE
              </button>
            </div>
          </div>
        </div>
        {active && (
          <div className="breadcrumb">
            {active.split('/').map((seg, i, arr) => (
              <span key={i}>{seg}{i < arr.length - 1 && <Icon name="chevronRight" size={11} />}</span>
            ))}
            {isMd && (
              <div className="seg sm md-toggle">
                {([['edit', 'Edit', 'code'], ['split', 'Split', 'columns'], ['preview', 'Preview', 'eye']] as const).map(([k, l, i]) => (
                  <button key={k} className={L.mdMode === k ? 'on' : ''} title={l} onClick={() => L.set({ mdMode: k })}>
                    <Icon name={i} size={13} /> {l}
                  </button>
                ))}
              </div>
            )}
            {activeTab?.stale && (
              <button className="btn ghost sm" style={{ marginLeft: 'auto' }} onClick={async () => {
                const f = await window.api.fs.read(root, active)
                const m = editor.current?.getModel()
                if (m) { m.setValue(f.content); saved.current.set(active, m.getAlternativeVersionId()) }
                setTabs((ts) => ts.map((t) => (t.path === active ? { ...t, stale: false, dirty: false } : t)))
              }}>File changed on disk – reload</button>
            )}
          </div>
        )}
        <div className={`editor-body md-${isMd ? L.mdMode : 'none'}`} style={{ display: activeTab?.kind === 'text' ? 'flex' : 'none' }}>
          <div className="monaco-host" ref={host} />
          {isMd && L.mdMode !== 'edit' && activeModel && (
            <MarkdownPreview model={activeModel} path={active!} root={root} />
          )}
        </div>
        {!active && (
          <div className="editor-empty">
            <h2>{root.split('/').pop()}</h2>
            <p className="muted">Open a file from the explorer, or press <span className="kbd">⌘P</span>{L.keymap === 'jetbrains' && <> / <span className="kbd">⇧⇧</span></>}</p>
            <div className="row">
              <button className="btn ghost" onClick={() => setQuick('files')}><Icon name="search" size={14} /> Go to file</button>
              <button className="btn ghost" onClick={() => fileOps.newFile(null)}><Icon name="filePlus" size={14} /> New file</button>
            </div>
          </div>
        )}
        {activeTab && activeTab.kind !== 'text' && (
          <div className="editor-empty">
            <p className="muted">{activeTab.kind === 'binary' ? 'Binary file – can’t be shown here.' : 'File is too large for the editor (> 5 MB).'}</p>
            <button className="btn ghost" onClick={() => window.api.fs.openExternal(root, active!)}>Open with default app</button>
          </div>
        )}
        <footer className="statusbar">
          <span><Icon name="branch" size={11} /> {app.agents.find((a) => a.worktreePath === root)?.branch ?? 'project folder'}</span>
          {Object.keys(git).length > 0 && <span>{Object.keys(git).length} changed</span>}
          <span title="Files and type definitions loaded for autocomplete">
            <Icon name="bolt" size={11} /> {sense.loading ? 'IntelliSense loading…' : `IntelliSense · ${sense.files} files${sense.libs ? ` · ${sense.libs} packages` : ''}`}
          </span>
          <div className="spacer" />
          {activeTab?.kind === 'text' && <span>Ln {cursor.line}, Col {cursor.col}</span>}
          {activeTab?.kind === 'text' && <span>{lang}</span>}
          <span>UTF-8</span>
          <button className={`autosave-btn ${L.autoSave !== 'off' ? 'on' : ''}`} onClick={() => setShowKeys(!showKeys)}
            title="Auto save – click to change">
            <Icon name="save" size={12} />
            {L.autoSave === 'off' ? 'Auto save off' : tabs.some((t) => t.dirty) ? 'Saving…' : lastSaved ? 'Saved' : 'Auto save'}
          </button>
          <button className="keymap-btn" onClick={() => setShowKeys(!showKeys)} title="Keymap & shortcuts">
            <Icon name="keyboard" size={12} /> {L.keymap === 'jetbrains' ? 'JetBrains' : 'VS Code'} keymap
          </button>
        </footer>
        {showKeys && (
          <div className="keymap-pop" onMouseLeave={() => setShowKeys(false)}>
            <div className="pop-label">Keymap</div>
            <div className="seg sm">
              {(['vscode', 'jetbrains'] as KeymapId[]).map((k) => (
                <button key={k} className={L.keymap === k ? 'on' : ''} onClick={() => L.set({ keymap: k })} style={{ width: 'auto', padding: '0 10px' }}>
                  {k === 'vscode' ? 'VS Code' : 'JetBrains'}
                </button>
              ))}
            </div>
            <div className="pop-label">Auto save</div>
            <div className="seg sm">
              {([['off', 'Off'], ['afterDelay', 'After delay'], ['onFocusChange', 'On focus change']] as const).map(([k, l]) => (
                <button key={k} className={L.autoSave === k ? 'on' : ''} onClick={() => L.set({ autoSave: k })} style={{ width: 'auto', padding: '0 10px' }}>{l}</button>
              ))}
            </div>
            {L.autoSave === 'afterDelay' && (
              <label className="delay-row">
                Delay
                <input type="range" min={300} max={5000} step={100} value={L.autoSaveDelay} onChange={(e) => L.set({ autoSaveDelay: Number(e.target.value) })} />
                <span className="mono">{(L.autoSaveDelay / 1000).toFixed(1)}s</span>
              </label>
            )}
            <p className="muted small" style={{ margin: '6px 0 0' }}>
              {L.autoSave === 'off' ? 'Save with ⌘S.' : L.autoSave === 'afterDelay' ? 'Saves after you stop typing, and when you leave the editor or switch files.' : 'Saves when you switch files, click outside the editor or leave the app.'}
              {' '}Auto save never overwrites a file an agent changed meanwhile.
            </p>
            <div className="pop-label">Shortcuts</div>
            <ul>
              {KEYMAP_HELP[L.keymap].map(([k, d]) => <li key={k}><span className="kbd">{k}</span>{d}</li>)}
            </ul>
          </div>
        )}
      </section>

      {menu && (
        <div className="ctx-layer" onMouseDown={() => setMenu(null)} onContextMenu={(e) => (e.preventDefault(), setMenu(null))}>
          <div className="ctx" style={{ left: Math.min(menu.x, innerWidth - 230), top: Math.min(menu.y, innerHeight - 300) }} onMouseDown={(e) => e.stopPropagation()}>
            {[
              { l: 'New file…', i: 'filePlus', f: () => fileOps.newFile(menu.entry) },
              { l: 'New folder…', i: 'folderPlus', f: () => fileOps.newFolder(menu.entry) },
              ...(menu.entry
                ? [
                    '-',
                    { l: 'Rename…', i: 'edit', f: () => fileOps.rename(menu.entry!) },
                    { l: 'Copy relative path', i: 'copy', f: () => window.api.copyText(menu.entry!.path).then(() => toast('Copied', 'success')) },
                    { l: 'Reveal in Finder', i: 'folder', f: () => window.api.fs.reveal(root, menu.entry!.path) },
                    ...(menu.entry.dir ? [] : [{ l: 'Open with default app', i: 'external', f: () => window.api.fs.openExternal(root, menu.entry!.path) }]),
                    '-',
                    { l: 'Move to Trash', i: 'trash', f: () => fileOps.trash(menu.entry!), danger: true }
                  ]
                : [])
            ].map((it, k) =>
              it === '-' ? <div key={k} className="ctx-sep" /> : (
                <button key={k} className={`ctx-item ${(it as { danger?: boolean }).danger ? 'danger' : ''}`}
                  onClick={() => { setMenu(null); (it as { f: () => void }).f() }}>
                  <Icon name={(it as { i: Parameters<typeof Icon>[0]['name'] }).i} size={14} />
                  <span>{(it as { l: string }).l}</span>
                </button>
              )
            )}
          </div>
        </div>
      )}

      {ideMenu && (
        <div className="ctx-layer" onMouseDown={() => setIdeMenu(false)}>
          <div className="ctx ide-menu" style={{ right: Math.max(8, innerWidth - ideMenu.x), top: ideMenu.y }} onMouseDown={(e) => e.stopPropagation()}>
            <div className="ctx-head"><div><b>Open {active ? active.split('/').pop() : 'folder'} in…</b><small>{active ? `line ${cursor.line}` : root}</small></div></div>
            {ides.length === 0 && <div className="muted small pad">No supported IDE found (VS Code, Cursor, JetBrains IDEs, Zed…)</div>}
            {ides.map((i) => (
              <button key={i.id} className="ctx-item" onClick={() => {
                setIdeMenu(false)
                const ln = active ? cursor.line : undefined
                toast(`Opening in ${i.name}…`)
                window.api.fs.openInIde(i.id, root, active ?? undefined, ln)
                  .catch((e) => toast(`${i.name}: ${cleanError(e)}`, 'error'))
              }}>
                <span className={`ide-dot ${i.family}`} /> {i.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {ask && <AskDialog ask={ask} onClose={() => setAsk(null)} onError={(e) => toast(cleanError(e), 'error')} />}
      {quick && (
        <QuickOpen root={root} mode={quick} recent={recent.current} onClose={() => { setQuick(null); editor.current?.focus() }}
          onPick={(p) => { setQuick(null); openFile(p) }} />
      )}
    </div>
  )
}

function AskDialog({ ask, onClose, onError }: { ask: Ask; onClose: () => void; onError: (e: unknown) => void }) {
  const [v, setV] = useState(ask.value)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const el = ref.current!
    el.focus()
    const dot = ask.value.lastIndexOf('.')
    el.setSelectionRange(0, dot > 0 ? dot : ask.value.length)
  }, [ask.value])
  const submit = async (): Promise<void> => {
    const name = v.trim()
    if (!name) return
    try {
      await ask.run(name)
      onClose()
    } catch (e) {
      onError(e)
    }
  }
  return (
    <div className="backdrop" onMouseDown={onClose}>
      <div className="modal small-modal" onMouseDown={(e) => e.stopPropagation()}>
        <h2>{ask.title}</h2>
        <input ref={ref} className="mono" value={v} onChange={(e) => setV(e.target.value)} placeholder="name or path/to/file.ts"
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') onClose() }} />
        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn" onClick={submit}>{ask.ok}</button>
        </div>
      </div>
    </div>
  )
}

/** ⌘P / ⇧⇧ fuzzy file finder (and ⌘E recent files). */
function QuickOpen({ root, mode, recent, onClose, onPick }: {
  root: string; mode: 'files' | 'recent'; recent: string[]; onClose: () => void; onPick: (p: string) => void
}) {
  const [all, setAll] = useState<string[]>(mode === 'recent' ? recent : [])
  const [q, setQ] = useState('')
  const [i, setI] = useState(0)
  useEffect(() => {
    if (mode === 'files') window.api.fs.listAll(root).then(setAll)
  }, [root, mode])
  const results = useMemo(() => {
    if (!q) return (mode === 'files' ? [...recent, ...all.filter((p) => !recent.includes(p))] : all).slice(0, 60)
    const needle = q.toLowerCase()
    const score = (p: string): number => {
      const s = p.toLowerCase()
      const name = s.split('/').pop()!
      if (name.startsWith(needle)) return 0
      if (name.includes(needle)) return 1
      if (s.includes(needle)) return 2
      let k = 0
      for (const ch of s) if (ch === needle[k]) k++
      return k === needle.length ? 3 + s.length / 1000 : Infinity
    }
    return all.map((p) => [p, score(p)] as const).filter(([, s]) => s < Infinity).sort((a, b) => a[1] - b[1]).slice(0, 60).map(([p]) => p)
  }, [q, all, recent, mode])
  return (
    <div className="backdrop top" onMouseDown={onClose}>
      <div className="quick" onMouseDown={(e) => e.stopPropagation()}>
        <input autoFocus value={q} placeholder={mode === 'recent' ? 'Recent files' : 'Search files by name'}
          onChange={(e) => { setQ(e.target.value); setI(0) }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') (e.preventDefault(), setI((x) => Math.min(x + 1, results.length - 1)))
            if (e.key === 'ArrowUp') (e.preventDefault(), setI((x) => Math.max(x - 1, 0)))
            if (e.key === 'Enter' && results[i]) onPick(results[i])
            if (e.key === 'Escape') onClose()
          }} />
        <ul>
          {results.map((p, k) => (
            <li key={p} className={k === i ? 'on' : ''} onMouseEnter={() => setI(k)} onClick={() => onPick(p)}>
              <FileIcon name={p.split('/').pop()!} />
              <b>{p.split('/').pop()}</b>
              <span>{p.split('/').slice(0, -1).join('/')}</span>
            </li>
          ))}
          {results.length === 0 && <li className="muted">No matching files</li>}
        </ul>
      </div>
    </div>
  )
}
