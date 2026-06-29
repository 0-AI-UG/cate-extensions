// =============================================================================
// Empty / error state shown before a session is loaded (and the hint to drop
// another). Pure presentation; the drag plumbing lives in App.
// =============================================================================

export function DropZone({ error }: { error?: string }) {
  return (
    <div className="dropzone">
      <div className="dropzone-inner">
        <div className="dropzone-icon" aria-hidden>⤓</div>
        <h1>AI Session Viewer</h1>
        <p>Drop a session file to view it as a conversation.</p>
        <p className="dropzone-formats">
          Claude Code · Codex · pi <span className="dim">(.jsonl)</span> or a JSON chat export
        </p>
        {error && <p className="dropzone-error">{error}</p>}
      </div>
    </div>
  )
}
