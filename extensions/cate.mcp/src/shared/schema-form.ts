// =============================================================================
// Playground schema-to-form classifier. A tool whose input schema is a FLAT
// object (only string/number/integer/boolean/enum properties) gets a generated
// form; anything else (nested objects, arrays, unions, no schema) falls back
// to a raw JSON args editor. Pure functions so both sides can share them and
// tests stay trivial.
// =============================================================================

export interface FormField {
  name: string
  type: 'string' | 'number' | 'integer' | 'boolean' | 'enum'
  required: boolean
  description?: string
  enumValues?: string[]
  defaultValue?: string | number | boolean
}

export type SchemaFormPlan =
  | { kind: 'none' } // no arguments at all
  | { kind: 'form'; fields: FormField[] }
  | { kind: 'json' } // too complex; raw JSON editor

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function classifyProperty(name: string, prop: unknown, required: boolean): FormField | null {
  if (!isObject(prop)) return null
  const description = typeof prop.description === 'string' ? prop.description : undefined
  if (Array.isArray(prop.enum)) {
    if (prop.enum.length === 0 || prop.enum.some((v) => typeof v !== 'string')) return null
    return { name, type: 'enum', required, description, enumValues: prop.enum as string[] }
  }
  const type = prop.type
  if (type === 'string' || type === 'number' || type === 'integer' || type === 'boolean') {
    const field: FormField = { name, type, required, description }
    const d = prop.default
    if (typeof d === 'string' || typeof d === 'number' || typeof d === 'boolean') field.defaultValue = d
    return field
  }
  return null
}

export function classifySchema(schema: unknown): SchemaFormPlan {
  if (schema === undefined || schema === null) return { kind: 'none' }
  if (!isObject(schema)) return { kind: 'json' }
  if (schema.type !== undefined && schema.type !== 'object') return { kind: 'json' }
  // Combinators mean the flat reading would lie about what's accepted.
  if (schema.oneOf || schema.anyOf || schema.allOf || schema.$ref) return { kind: 'json' }
  const props = schema.properties
  if (props === undefined) return { kind: 'none' }
  if (!isObject(props)) return { kind: 'json' }
  const names = Object.keys(props)
  if (names.length === 0) return { kind: 'none' }
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((r) => typeof r === 'string') : [])
  const fields: FormField[] = []
  for (const name of names) {
    const field = classifyProperty(name, props[name], required.has(name))
    if (!field) return { kind: 'json' }
    fields.push(field)
  }
  return { kind: 'form', fields }
}

/** Coerce raw form input strings into typed args, skipping empty optionals. */
export function buildArgsFromForm(
  fields: FormField[],
  values: Record<string, string>,
): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  const args: Record<string, unknown> = {}
  for (const field of fields) {
    const raw = values[field.name] ?? ''
    if (raw === '') {
      if (field.required && field.type !== 'boolean') return { ok: false, error: `"${field.name}" is required` }
      if (field.type === 'boolean' && field.required) args[field.name] = false
      continue
    }
    switch (field.type) {
      case 'string':
      case 'enum':
        args[field.name] = raw
        break
      case 'boolean':
        if (raw !== 'true' && raw !== 'false') return { ok: false, error: `"${field.name}" must be true or false` }
        args[field.name] = raw === 'true'
        break
      case 'number':
      case 'integer': {
        const n = Number(raw)
        if (!Number.isFinite(n)) return { ok: false, error: `"${field.name}" must be a number` }
        if (field.type === 'integer' && !Number.isInteger(n)) return { ok: false, error: `"${field.name}" must be an integer` }
        args[field.name] = n
        break
      }
    }
  }
  return { ok: true, args }
}

/** One-line summary of an input schema for tool list rows ("query: string, limit?: number"). */
export function summarizeSchema(schema: unknown): string {
  const plan = classifySchema(schema)
  if (plan.kind === 'none') return 'no arguments'
  if (plan.kind === 'json') return 'structured arguments (JSON)'
  return plan.fields
    .map((f) => `${f.name}${f.required ? '' : '?'}: ${f.type === 'enum' ? (f.enumValues ?? []).join('|') : f.type}`)
    .join(', ')
}
