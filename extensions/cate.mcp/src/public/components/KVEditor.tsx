// Key/value editor rows for env vars and HTTP headers.

export interface KVRow {
  key: string
  value: string
}

export function kvRowsFromRecord(rec: Record<string, string> | undefined): KVRow[] {
  return Object.entries(rec ?? {}).map(([key, value]) => ({ key, value }))
}

export function recordFromKvRows(rows: KVRow[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const row of rows) {
    if (row.key.trim() !== '') out[row.key.trim()] = row.value
  }
  return out
}

export function KVEditor({
  rows,
  onChange,
  keyPlaceholder,
  valuePlaceholder,
}: {
  rows: KVRow[]
  onChange: (rows: KVRow[]) => void
  keyPlaceholder: string
  valuePlaceholder: string
}) {
  return (
    <div className="mcp-kvedit">
      {rows.map((row, i) => (
        <div className="mcp-kvedit__row" key={i}>
          <input
            className="cate-input"
            value={row.key}
            placeholder={keyPlaceholder}
            onChange={(e) => onChange(rows.map((r, j) => (j === i ? { ...r, key: e.target.value } : r)))}
          />
          <input
            className="cate-input"
            value={row.value}
            placeholder={valuePlaceholder}
            onChange={(e) => onChange(rows.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))}
          />
          <button
            className="cate-iconbtn"
            type="button"
            title="Remove"
            onClick={() => onChange(rows.filter((_r, j) => j !== i))}
          >
            ×
          </button>
        </div>
      ))}
      <div>
        <button className="cate-btn cate-btn--small" type="button" onClick={() => onChange([...rows, { key: '', value: '' }])}>
          + Add
        </button>
      </div>
    </div>
  )
}
