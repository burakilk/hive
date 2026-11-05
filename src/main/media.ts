/**
 * Screenshots (attached to prompts) and voice dictation.
 */
import { app, desktopCapturer, screen } from 'electron'
import { execFile } from 'child_process'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'
import { getState } from './store'

const dir = (): string => {
  const d = join(app.getPath('userData'), 'attachments')
  mkdirSync(d, { recursive: true })
  return d
}

export interface Attachment {
  path: string
  /** small preview for the composer */
  dataUrl: string
}

async function preview(path: string): Promise<string> {
  const { nativeImage } = await import('electron')
  const img = nativeImage.createFromPath(path)
  const s = img.getSize()
  const w = Math.min(320, s.width)
  return img.resize({ width: w }).toDataURL()
}

/** Interactive region capture. macOS uses the system tool (drag to select, Space = window). */
export async function captureScreen(): Promise<Attachment | null> {
  const file = join(dir(), `shot-${Date.now()}.png`)
  if (process.platform === 'darwin') {
    await new Promise<void>((resolve) => execFile('screencapture', ['-i', '-x', file], () => resolve()))
    if (!existsSync(file)) return null // cancelled with Esc
    return { path: file, dataUrl: await preview(file) }
  }
  // other platforms: whole primary display
  const d = screen.getPrimaryDisplay()
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) }
  })
  const img = sources[0]?.thumbnail
  if (!img || img.isEmpty()) return null
  writeFileSync(file, img.toPNG())
  return { path: file, dataUrl: await preview(file) }
}

/** Save a file pasted into the composer that has no path on disk (keeps its name). */
export function saveAttachment(data: Uint8Array, name: string): { path: string; name: string } {
  const safe = name.replace(/[/\\:\0]/g, '_').slice(-120) || 'file'
  const sub = join(dir(), randomUUID().slice(0, 8))
  mkdirSync(sub, { recursive: true })
  const file = join(sub, safe)
  writeFileSync(file, data)
  return { path: file, name: safe }
}

/** Save an image pasted / dropped into the composer. */
export async function saveImage(data: Uint8Array, ext = 'png'): Promise<Attachment> {
  const file = join(dir(), `img-${randomUUID().slice(0, 8)}.${ext.replace(/[^a-z0-9]/gi, '') || 'png'}`)
  writeFileSync(file, data)
  return { path: file, dataUrl: await preview(file) }
}

/**
 * Speech to text. The renderer records 16 kHz mono WAV.
 *  1. OpenAI (if a key is set in Settings)
 *  2. a local command from Settings, e.g. `whisper-cli -m ~/models/ggml-base.bin -nt -f {file}`
 */
export async function transcribe(wav: Uint8Array): Promise<string> {
  const { openaiKey, dictationLang, whisperCmd } = getState().settings
  if (openaiKey.trim()) {
    const form = new FormData()
    form.append('file', new Blob([Buffer.from(wav)], { type: 'audio/wav' }), 'speech.wav')
    form.append('model', 'gpt-4o-mini-transcribe')
    if (dictationLang) form.append('language', dictationLang)
    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${openaiKey.trim()}` },
      body: form
    })
    if (!res.ok) throw new Error(`OpenAI: ${res.status} ${(await res.text()).slice(0, 200)}`)
    return ((await res.json()) as { text: string }).text.trim()
  }
  if (whisperCmd.trim()) {
    const file = join(tmpdir(), `hive-dictation-${Date.now()}.wav`)
    writeFileSync(file, wav)
    const cmd = whisperCmd.includes('{file}') ? whisperCmd.replace(/\{file\}/g, `'${file}'`) : `${whisperCmd} '${file}'`
    const shell = process.env.SHELL || '/bin/zsh'
    return new Promise((resolve, reject) =>
      execFile(shell, ['-l', '-i', '-c', cmd], { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 }, (err, out, errOut) => {
        if (err) return reject(new Error(String(errOut || err.message).trim().split('\n').slice(-2).join(' ')))
        // whisper.cpp prints "[00:00.000 --> 00:02.000]  text" unless -nt is given
        resolve(out.replace(/\[[\d:.\s>-]+\]\s*/g, '').replace(/\s+/g, ' ').trim())
      })
    )
  }
  throw new Error('Dictation needs an OpenAI key or a local whisper command – Settings → Input')
}
