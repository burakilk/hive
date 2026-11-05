import { useEffect, useMemo, useRef, useState } from 'react'
import { Marked } from 'marked'
import DOMPurify from 'dompurify'
import { highlightLine, languageFor } from '../components/highlight'
import type { monaco } from './monaco'
import { openHref } from '../links'

const marked = new Marked({ gfm: true, breaks: false })
marked.use({
  renderer: {
    code({ text, lang }) {
      const l = lang ? languageFor(`x.${lang}`) ?? lang : undefined
      const html = text.split('\n').map((line) => highlightLine(line, l)).join('\n')
      return `<pre class="md-code"><code>${html}</code></pre>`
    }
  }
})

/** GitHub-style heading anchor: "Getting Started!" → "getting-started" */
const slug = (t: string): string => t.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-')

/**
 * Live, sanitised markdown preview of a Monaco model.
 * Links: http(s) open in the browser; files and folders (relative, root-relative, absolute,
 * with #L12 / :12 line numbers) open in the editor.
 */
export function MarkdownPreview({ model, path, root }: {
  model: monaco.editor.ITextModel
  path: string
  root: string
}) {
  const [text, setText] = useState(model.getValue())
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    setText(model.getValue())
    let t: ReturnType<typeof setTimeout>
    const sub = model.onDidChangeContent(() => {
      clearTimeout(t)
      t = setTimeout(() => setText(model.getValue()), 120)
    })
    return () => {
      clearTimeout(t)
      sub.dispose()
    }
  }, [model])

  const html = useMemo(() => {
    const raw = marked.parse(text, { async: false }) as string
    return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true }, FORBID_TAGS: ['style', 'form', 'button', 'iframe', 'textarea', 'select'], FORBID_ATTR: ['style'] })
  }, [text])

  const dir = path.split('/').slice(0, -1).join('/')
  return (
    <div
      className="md-preview"
      ref={ref}
      onClick={(e) => {
        const a = (e.target as HTMLElement).closest('a')
        if (!a) return
        e.preventDefault()
        const href = a.getAttribute('href') ?? ''
        if (href.startsWith('#')) {
          const id = decodeURIComponent(href.slice(1))
          const el = ref.current?.querySelector(`[id="${CSS.escape(id)}"]`) ?? [...(ref.current?.querySelectorAll('h1,h2,h3,h4,h5,h6') ?? [])].find((h) => slug(h.textContent ?? '') === id.toLowerCase())
          el?.scrollIntoView({ behavior: 'smooth' })
        } else if (href) void openHref(href, root, dir)
      }}
    >
      <article className="md-body" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  )
}
