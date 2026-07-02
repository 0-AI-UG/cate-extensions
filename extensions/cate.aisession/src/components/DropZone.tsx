// =============================================================================
// Empty / parsing / error state shown before a session is rendered. Pure
// presentation; the drag plumbing lives in App. The drop target stays armed in
// every state, so after an error the user just drops another file.
// =============================================================================

export function DropZone({ error, parsingFile }: { error?: string; parsingFile?: string }) {
  return (
    <div className="dropzone">
      <div className="dropzone-inner">
        <div className="dropzone-icon" aria-hidden>⤓</div>
        {parsingFile ? (
          <p className="dropzone-hint">Parsing “{parsingFile}”…</p>
        ) : (
          <>
            {error && <p className="dropzone-error">{error}</p>}
            <p className="dropzone-hint">
              Drop a Claude Code, Codex, or pi session file (<code>.jsonl</code>), or a JSON chat
              export.{error ? ' Drop another file to try again.' : ''}
            </p>
          </>
        )}
      </div>
    </div>
  )
}
