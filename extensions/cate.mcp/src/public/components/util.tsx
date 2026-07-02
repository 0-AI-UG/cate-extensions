// Small presentational helpers shared by the panel components: status dots,
// icon buttons, inline errors, and the panel's 14px-grid icon set.

import { useState } from 'react'
import type { ServerStatus } from '../../shared/types'

export const STATUS_LABEL: Record<ServerStatus, string> = {
  stopped: 'Stopped',
  starting: 'Starting',
  running: 'Running',
  degraded: 'Degraded',
  restarting: 'Restarting',
  error: 'Error',
  'needs-auth': 'Needs auth',
  disabled: 'Disabled',
}

export function statusWord(status: ServerStatus, restartAttempt: number): string {
  return status === 'restarting' && restartAttempt > 0 ? `Restarting (${restartAttempt})` : STATUS_LABEL[status]
}

/** Bare 8px status dot (Cate status idiom: no outlined pills). */
export function StatusDot({ status }: { status: ServerStatus }) {
  return <span className={`mcp-dot mcp-dot--${status}`} title={STATUS_LABEL[status]} />
}

export function formatUptime(startedAt: number | null): string {
  if (startedAt === null) return ''
  const s = Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/** 22x22 copy icon button with transient check feedback. */
export function CopyIconButton({ text, title = 'Copy' }: { text: string; title?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      className="cate-iconbtn"
      type="button"
      title={copied ? 'Copied' : title}
      onClick={() => {
        void copyText(text).then((ok) => {
          if (!ok) return
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </button>
  )
}

export function InlineError({ error }: { error: string | null }) {
  if (!error) return null
  return <div className="mcp-inline-error">{error}</div>
}

export function notify(message: string, level: 'info' | 'warn' | 'error' = 'info'): void {
  try {
    void window.cate?.ui.notify(message, level)
  } catch {
    /* best effort */
  }
}

export function openConfigFile(configPath: string): void {
  try {
    void window.cate?.editor.openFile(configPath)
  } catch {
    /* outside Cate */
  }
}

/** Open a URL in a Cate browser panel (needs the `canvas` scope). The sandboxed
 *  webview denies window.open and in-place navigation would eat the panel, so
 *  links route through the host. Returns true when the host opened it, false
 *  otherwise (no host / no grant / error) so callers can fall back. */
export async function openUrlInPanel(url: string): Promise<boolean> {
  try {
    const c = window.cate
    if (!c) return false
    const r = (await c.canvas.createPanel('browser', { url })) as { error?: string } | null | undefined
    if (r && typeof r === 'object' && 'error' in r && r.error) return false
    return true
  } catch {
    return false
  }
}

// --- icons (14px stroke set) -------------------------------------------------

function icon(path: React.ReactNode) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {path}
    </svg>
  )
}

export const PlusIcon = () => icon(<path d="M8 3.5v9M3.5 8h9" />)

export const CopyIcon = () =>
  icon(
    <>
      <rect x="5.5" y="5.5" width="7" height="7" rx="1.2" />
      <path d="M3.5 10.5v-6a1 1 0 0 1 1-1h6" />
    </>,
  )

export const CheckIcon = () => icon(<path d="M3.5 8.5l3 3 6-6.5" />)

export const CompassIcon = () =>
  icon(
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M10.2 5.8 9 9l-3.2 1.2L7 7z" />
    </>,
  )

export const BroadcastIcon = () =>
  icon(
    <>
      <circle cx="8" cy="8" r="1.4" fill="currentColor" stroke="none" />
      <path d="M5.2 10.8a4 4 0 0 1 0-5.6M10.8 5.2a4 4 0 0 1 0 5.6" />
      <path d="M3.4 12.6a6.5 6.5 0 0 1 0-9.2M12.6 3.4a6.5 6.5 0 0 1 0 9.2" />
    </>,
  )

export const EyeIcon = () =>
  icon(
    <>
      <path d="M1.8 8s2.2-4 6.2-4 6.2 4 6.2 4-2.2 4-6.2 4S1.8 8 1.8 8z" />
      <circle cx="8" cy="8" r="1.8" />
    </>,
  )

export const EyeOffIcon = () =>
  icon(
    <>
      <path d="M3 3l10 10M6.7 6.8a1.8 1.8 0 0 0 2.5 2.5" />
      <path d="M4.3 4.9C2.6 6.1 1.8 8 1.8 8s2.2 4 6.2 4c1 0 1.9-.2 2.7-.6M6.9 4.1c.4-.1.7-.1 1.1-.1 4 0 6.2 4 6.2 4s-.6 1.1-1.8 2.1" />
    </>,
  )

export const BracesIcon = () =>
  icon(
    <>
      <path d="M6 2.5c-1.2 0-1.8.6-1.8 1.8v1.9c0 .9-.4 1.5-1.4 1.8 1 .3 1.4.9 1.4 1.8v1.9c0 1.2.6 1.8 1.8 1.8" />
      <path d="M10 2.5c1.2 0 1.8.6 1.8 1.8v1.9c0 .9.4 1.5 1.4 1.8-1 .3-1.4.9-1.4 1.8v1.9c0 1.2-.6 1.8-1.8 1.8" />
    </>,
  )

export const CloseIcon = () => icon(<path d="M4 4l8 8M12 4l-8 8" />)
