// =============================================================================
// Deterministic namespacing for the unified MCP endpoint. Tools and prompts of
// upstream server "foo" surface as "foo__<name>". Server names cannot contain
// "__" (enforced by validateServerName), so splitting on the FIRST "__" is
// unambiguous even when the item name itself contains "__".
// =============================================================================

import { NAMESPACE_SEP } from './config'

export function namespaceName(server: string, item: string): string {
  return `${server}${NAMESPACE_SEP}${item}`
}

export function splitNamespacedName(name: string): { server: string; item: string } | null {
  const idx = name.indexOf(NAMESPACE_SEP)
  if (idx <= 0 || idx + NAMESPACE_SEP.length >= name.length) return null
  return { server: name.slice(0, idx), item: name.slice(idx + NAMESPACE_SEP.length) }
}
