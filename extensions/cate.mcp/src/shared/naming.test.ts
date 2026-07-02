import { describe, expect, it } from 'vitest'
import { namespaceName, splitNamespacedName } from './naming'

describe('namespacing', () => {
  it('round-trips server and item names', () => {
    const namespaced = namespaceName('files', 'read_file')
    expect(namespaced).toBe('files__read_file')
    expect(splitNamespacedName(namespaced)).toEqual({ server: 'files', item: 'read_file' })
  })

  it('splits on the FIRST separator so item names may contain __', () => {
    expect(splitNamespacedName('srv__tool__variant')).toEqual({ server: 'srv', item: 'tool__variant' })
  })

  it('single underscores in the server name are fine', () => {
    expect(splitNamespacedName(namespaceName('my_server', 'do'))).toEqual({ server: 'my_server', item: 'do' })
  })

  it('rejects names without a separator or with empty halves', () => {
    expect(splitNamespacedName('plain')).toBeNull()
    expect(splitNamespacedName('__leading')).toBeNull()
    expect(splitNamespacedName('trailing__')).toBeNull()
  })
})
