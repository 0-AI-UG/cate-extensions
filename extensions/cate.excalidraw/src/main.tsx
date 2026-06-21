// =============================================================================
// Excalidraw, mounted as a Cate extension panel.
//
// This is glue, not a re-implementation: it renders the upstream @excalidraw
// React component and wires two Cate host APIs around it —
//   - cate.theme  : match the panel's light/dark theme to Cate's.
//   - cate.storage: autosave the scene per-panel, restore it on reload.
//
// Fonts are vendored under dist/ (see scripts/postbuild.mjs) and pointed at via
// EXCALIDRAW_ASSET_PATH in assetPath.ts, so everything is served same-origin
// under Cate's strict extension CSP (no CDN, no external fetch).
// =============================================================================

// MUST be the first import: it sets EXCALIDRAW_ASSET_PATH before the Excalidraw
// module below is evaluated and captures its (CDN) font host. See assetPath.ts.
import './assetPath'

import { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Excalidraw, serializeAsJSON } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
import './styles.css'

const SCENE_KEY = 'scene'
const SAVE_DEBOUNCE_MS = 700

type Theme = 'light' | 'dark'

/** Cate injects `window.cate`; outside Cate (a plain browser) it's undefined and
 *  the board still works, just without theme/persistence. */
const cate = (globalThis as { cate?: CateHost }).cate

async function readTheme(): Promise<Theme> {
  try {
    const theme = await cate?.theme.get()
    return theme?.type === 'light' ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}

async function readScene(): Promise<Record<string, unknown> | undefined> {
  try {
    const raw = await cate?.storage.panel.get(SCENE_KEY)
    if (typeof raw !== 'string' || raw.length === 0) return undefined
    const parsed = JSON.parse(raw) as {
      elements?: unknown[]
      appState?: Record<string, unknown>
      files?: Record<string, unknown>
    }
    return {
      elements: parsed.elements ?? [],
      appState: parsed.appState ?? {},
      files: parsed.files,
      scrollToContent: true,
    }
  } catch {
    return undefined
  }
}

function Board() {
  const [boot, setBoot] = useState<{
    initialData: Record<string, unknown> | undefined
    theme: Theme
  } | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    let alive = true
    void (async () => {
      const [theme, initialData] = await Promise.all([readTheme(), readScene()])
      if (alive) setBoot({ initialData, theme })
    })()
    return () => {
      alive = false
      clearTimeout(saveTimer.current)
    }
  }, [])

  const onChange = useCallback(
    (elements: readonly unknown[], appState: unknown, files: unknown) => {
      if (!cate) return
      clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => {
        try {
          // serializeAsJSON strips transient appState, so it round-trips cleanly.
          const json = serializeAsJSON(
            elements as never,
            appState as never,
            files as never,
            'local',
          )
          void cate.storage.panel.set(SCENE_KEY, json)
        } catch {
          /* a single failed autosave is not worth surfacing */
        }
      }, SAVE_DEBOUNCE_MS)
    },
    [],
  )

  if (!boot) return <div className="excal-loading">Loading…</div>

  return (
    <div className="excal-root">
      <Excalidraw theme={boot.theme} initialData={boot.initialData as never} onChange={onChange} />
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Board />)
