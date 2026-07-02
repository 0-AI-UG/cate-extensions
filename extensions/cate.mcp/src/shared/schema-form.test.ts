import { describe, expect, it } from 'vitest'
import { buildArgsFromForm, classifySchema, summarizeSchema } from './schema-form'

describe('classifySchema', () => {
  it('classifies a flat object schema as a form', () => {
    const plan = classifySchema({
      type: 'object',
      properties: {
        query: { type: 'string', description: 'search text' },
        limit: { type: 'integer', default: 10 },
        exact: { type: 'boolean' },
        mode: { enum: ['fast', 'thorough'] },
      },
      required: ['query'],
    })
    expect(plan.kind).toBe('form')
    if (plan.kind === 'form') {
      expect(plan.fields).toHaveLength(4)
      expect(plan.fields[0]).toMatchObject({ name: 'query', type: 'string', required: true })
      expect(plan.fields[1]).toMatchObject({ name: 'limit', type: 'integer', required: false, defaultValue: 10 })
      expect(plan.fields[3]).toMatchObject({ name: 'mode', type: 'enum', enumValues: ['fast', 'thorough'] })
    }
  })

  it('no schema or no properties means no arguments', () => {
    expect(classifySchema(undefined).kind).toBe('none')
    expect(classifySchema({ type: 'object' }).kind).toBe('none')
    expect(classifySchema({ type: 'object', properties: {} }).kind).toBe('none')
  })

  it('nested objects, arrays, combinators and non-objects fall back to JSON', () => {
    expect(classifySchema({ type: 'object', properties: { deep: { type: 'object' } } }).kind).toBe('json')
    expect(classifySchema({ type: 'object', properties: { list: { type: 'array' } } }).kind).toBe('json')
    expect(classifySchema({ type: 'object', properties: { x: { type: 'string' } }, oneOf: [{}] }).kind).toBe('json')
    expect(classifySchema({ type: 'string' }).kind).toBe('json')
    expect(classifySchema('what').kind).toBe('json')
  })
})

describe('buildArgsFromForm', () => {
  const fields = classifySchema({
    type: 'object',
    properties: { q: { type: 'string' }, n: { type: 'number' }, i: { type: 'integer' }, b: { type: 'boolean' } },
    required: ['q'],
  })

  it('coerces types and skips empty optionals', () => {
    if (fields.kind !== 'form') throw new Error('expected form')
    const r = buildArgsFromForm(fields.fields, { q: 'hi', n: '1.5', i: '', b: 'true' })
    expect(r).toEqual({ ok: true, args: { q: 'hi', n: 1.5, b: true } })
  })

  it('rejects missing required, bad numbers, non-integers', () => {
    if (fields.kind !== 'form') throw new Error('expected form')
    expect(buildArgsFromForm(fields.fields, {}).ok).toBe(false)
    expect(buildArgsFromForm(fields.fields, { q: 'x', n: 'abc' }).ok).toBe(false)
    expect(buildArgsFromForm(fields.fields, { q: 'x', i: '1.5' }).ok).toBe(false)
  })
})

describe('summarizeSchema', () => {
  it('summarizes forms, json fallbacks and empty schemas', () => {
    expect(summarizeSchema({ type: 'object', properties: { a: { type: 'string' } }, required: ['a'] })).toBe('a: string')
    expect(summarizeSchema({ type: 'object', properties: { a: { type: 'object' } } })).toBe('structured arguments (JSON)')
    expect(summarizeSchema(undefined)).toBe('no arguments')
  })
})
