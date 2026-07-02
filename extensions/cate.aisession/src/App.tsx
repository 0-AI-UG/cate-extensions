// =============================================================================
// App — drop target + state machine. A dropped file becomes a parsed
// Conversation, or an error. Two drop sources converge on `loadFile`:
//   1. Cate forwards file-explorer / OS drops via cate.files.onDrop (host reads
//      the file; we get { name, text }).
//   2. Native webview drops (OS Finder) land on our own DOM — we read the File
//      with file.text(). This is the fallback for windows where Cate's host
//      overlay isn't armed, and works standalone in a browser.
// Whichever fires, we parse the first file and render it.
// =============================================================================

import { useCallback, useEffect, useRef, useState } from 'react'
import { parseSession, type Conversation } from './parsers'
import { ConversationView } from './components/Conversation'
import { DropZone } from './components/DropZone'

const cateApi = (globalThis as { cate?: CateHost }).cate

type State =
  | { status: 'empty' }
  | { status: 'parsing'; fileName: string }
  | { status: 'ready'; convo: Conversation; fileName: string }
  | { status: 'error'; error: string }

export function App() {
  const [state, setState] = useState<State>({ status: 'empty' })
  const [dragging, setDragging] = useState(false)
  // Monotonic drop counter so a slow parse can't clobber a newer drop.
  const loadSeq = useRef(0)

  const loadFile = useCallback((file: { name: string; text: string }) => {
    const seq = ++loadSeq.current
    if (!file.text.trim()) {
      setState({ status: 'error', error: `“${file.name}” is empty.` })
      return
    }
    if (file.text.includes('\u0000')) {
      setState({ status: 'error', error: `“${file.name}” looks like a binary file, not a session log.` })
      return
    }
    // Parsing is synchronous; show the parsing state and defer a tick so it
    // actually paints before a multi-MB file occupies the main thread.
    setState({ status: 'parsing', fileName: file.name })
    setTimeout(() => {
      if (seq !== loadSeq.current) return // superseded by a newer drop
      try {
        const convo = parseSession(file.text)
        setState({ status: 'ready', convo, fileName: file.name })
        void cateApi?.panel.setTitle(convo.title ?? file.name).catch(() => undefined)
      } catch (err) {
        setState({ status: 'error', error: err instanceof Error ? err.message : String(err) })
      }
    }, 0)
  }, [])

  // Source 1: Cate-forwarded drops (host already read the file content).
  useEffect(() => {
    if (!cateApi?.files?.onDrop) return
    return cateApi.files.onDrop((files) => {
      const first = files[0]
      if (first) loadFile({ name: first.name, text: first.text })
    })
  }, [loadFile])

  // Source 2: native OS drops onto our own DOM.
  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setDragging(false)
      const file = e.dataTransfer.files?.[0]
      if (!file) return
      void file.text().then(
        (text) => loadFile({ name: file.name, text }),
        () => setState({ status: 'error', error: `Could not read “${file.name}”.` }),
      )
    },
    [loadFile],
  )

  const onDragOver = useCallback((e: React.DragEvent) => {
    if (Array.from(e.dataTransfer.types).includes('Files')) {
      e.preventDefault()
      setDragging(true)
    }
  }, [])

  const onDragLeave = useCallback((e: React.DragEvent) => {
    if (!e.relatedTarget) setDragging(false)
  }, [])

  return (
    <div
      className={`app${dragging ? ' dragging' : ''}`}
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
    >
      {state.status === 'ready' ? (
        <ConversationView convo={state.convo} fileName={state.fileName} />
      ) : (
        <DropZone
          error={state.status === 'error' ? state.error : undefined}
          parsingFile={state.status === 'parsing' ? state.fileName : undefined}
        />
      )}
      {dragging && (
        <div className="drag-overlay">
          <div className="drag-overlay-label">Drop session file</div>
        </div>
      )}
    </div>
  )
}
