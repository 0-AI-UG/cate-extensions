// =============================================================================
// Empty / error state shown before a session is loaded (and the hint to drop
// another). Pure presentation; the drag plumbing lives in App.
// =============================================================================

export function DropZone({ error }: { error?: string }) {
  return (
    <div className="dropzone">
      <div className="dropzone-inner">
        <div className="dropzone-icon" aria-hidden>⤓</div>
        {error && <p className="dropzone-error">{error}</p>}
      </div>
    </div>
  )
}
