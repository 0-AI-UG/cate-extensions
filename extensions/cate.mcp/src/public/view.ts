// Which pane the panel shows, plus its storage-persisted (de)serialization.
// Kept out of main.tsx so the pure logic is unit-testable without booting the
// React root. Dashboard is the default: an unset or unparseable saved value
// resolves to it (never auto-select-first-server).

export type View =
  | { kind: 'dashboard' }
  | { kind: 'server'; name: string }
  | { kind: 'discover' }
  | { kind: 'endpoint' }

export function serializeView(view: View): string {
  return view.kind === 'server' ? `server:${view.name}` : view.kind
}

export function parseView(raw: unknown): View | null {
  if (typeof raw !== 'string') return null
  if (raw === 'dashboard' || raw === 'discover' || raw === 'endpoint') return { kind: raw }
  if (raw.startsWith('server:')) return { kind: 'server', name: raw.slice('server:'.length) }
  return null // legacy 'servers'/unknown value falls through to the Dashboard default
}
