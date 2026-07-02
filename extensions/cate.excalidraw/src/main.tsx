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
import { createAutosaver } from './autosave'
import { sanitizeStoredScene, themeFromHost, type RestoredScene, type Theme } from './scene'

const SCENE_KEY = 'scene'
const SAVE_DEBOUNCE_MS = 700

/** Cate injects `window.cate`; outside Cate (a plain browser) it's undefined and
 *  the board still works, just without theme/persistence. */
const cate = (globalThis as { cate?: CateHost }).cate

async function readTheme(): Promise<Theme> {
  try {
    return themeFromHost(await cate?.theme.get())
  } catch {
    return 'dark'
  }
}

async function readScene(): Promise<RestoredScene | undefined> {
  try {
    return sanitizeStoredScene(await cate?.storage.panel.get(SCENE_KEY))
  } catch {
    return undefined
  }
}

function Board() {
  const [boot, setBoot] = useState<{
    initialData: RestoredScene | undefined
    theme: Theme
  } | null>(null)
  const saver = useRef(
    createAutosaver((json) => {
      // A rejected write (host gone, storage error) must not become an
      // unhandled rejection; losing one autosave is acceptable.
      cate?.storage.panel.set(SCENE_KEY, json).catch(() => {})
    }, SAVE_DEBOUNCE_MS),
  )

  useEffect(() => {
    let alive = true
    void (async () => {
      const [theme, initialData] = await Promise.all([readTheme(), readScene()])
      if (alive) setBoot({ initialData, theme })
    })()
    // Flush the pending autosave when the panel is hidden/closed (or unmounted)
    // so edits inside the debounce window aren't lost on a quick close.
    const flush = () => saver.current.flush()
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush()
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', flush)
    return () => {
      alive = false
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', flush)
      flush()
    }
  }, [])

  const onChange = useCallback(
    (elements: readonly unknown[], appState: unknown, files: unknown) => {
      if (!cate) return
      // serializeAsJSON strips transient appState, so it round-trips cleanly.
      // Serialization is deferred to save time (see autosave.ts).
      saver.current.schedule(() =>
        serializeAsJSON(elements as never, appState as never, files as never, 'local'),
      )
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
