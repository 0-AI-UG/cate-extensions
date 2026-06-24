// =============================================================================
// Task Master data model + parser.
//
// Pure, dependency-free, and isomorphic (no Node or DOM globals) so the same
// code parses tasks on the server and is unit-tested under vitest. It takes the
// untrusted contents of `.taskmaster/tasks/tasks.json` and turns it into a
// normalized board model without ever throwing.
//
// Task Master stores tasks in one of two on-disk shapes (we support both):
//
//   1. Legacy flat:   { "tasks": [ ... ], "metadata": { ... } }
//   2. Tagged (>=0.16): { "master": { "tasks": [ ... ] }, "feature-x": { ... } }
//      — each top-level key is a named tag/context with its own task array and
//        independent id sequence. Legacy files are auto-migrated to a "master"
//        tag by Task Master itself.
//
// Status values per upstream docs/task-structure.md:
//   pending | in-progress | done | review | deferred | cancelled
// (we also tolerate "blocked" and "completed", seen in the wild / older docs).
// =============================================================================

export type TaskStatus =
  | 'pending'
  | 'in-progress'
  | 'done'
  | 'review'
  | 'deferred'
  | 'cancelled'
  | 'blocked'

/** Canonical path of the tasks file under a project root. */
export const TASKS_RELATIVE_PATH = '.taskmaster/tasks/tasks.json'

/** Fallback legacy path some older Task Master versions used. */
export const LEGACY_TASKS_RELATIVE_PATH = 'tasks/tasks.json'

export interface Subtask {
  id: number
  title: string
  description: string
  status: TaskStatus
  /** Subtask deps reference sibling subtask ids (numbers) or "parent.sub" refs. */
  dependencies: Array<number | string>
  details?: string
}

export interface Task {
  id: number
  title: string
  description: string
  status: TaskStatus
  dependencies: number[]
  priority?: string
  details?: string
  testStrategy?: string
  subtasks: Subtask[]
}

export interface TagBoard {
  /** Tag name, e.g. "master" or a feature-branch context. */
  tag: string
  tasks: Task[]
}

export interface Board {
  /** All tags found in the file (always at least one when tasks exist). */
  tags: TagBoard[]
  /** The tag we surface by default ("master" when present, else the first). */
  defaultTag: string
}

// -----------------------------------------------------------------------------
// Status normalization
// -----------------------------------------------------------------------------

const KNOWN_STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'in-progress',
  'done',
  'review',
  'deferred',
  'cancelled',
  'blocked',
])

/** Coerce an untrusted status string to a known TaskStatus; default pending. */
export function normalizeStatus(raw: unknown): TaskStatus {
  if (typeof raw !== 'string') return 'pending'
  const s = raw.trim().toLowerCase()
  if (s === 'completed') return 'done'
  if (s === 'in_progress' || s === 'inprogress' || s === 'in progress') return 'in-progress'
  if (s === 'canceled') return 'cancelled'
  if (KNOWN_STATUSES.has(s)) return s as TaskStatus
  return 'pending'
}

/** The kanban columns we render, in display order, with their member statuses. */
export interface Column {
  id: string
  label: string
  statuses: TaskStatus[]
}

export const COLUMNS: Column[] = [
  { id: 'pending', label: 'Pending', statuses: ['pending', 'deferred'] },
  { id: 'in-progress', label: 'In Progress', statuses: ['in-progress', 'review', 'blocked'] },
  { id: 'done', label: 'Done', statuses: ['done', 'cancelled'] },
]

/** Which column a status belongs to (falls back to the first column). */
export function columnForStatus(status: TaskStatus): string {
  for (const col of COLUMNS) {
    if (col.statuses.includes(status)) return col.id
  }
  return COLUMNS[0].id
}

// -----------------------------------------------------------------------------
// Parsing
// -----------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

/** Coerce an id to a number; non-numeric ids (rare) hash to a stable-ish 0. */
function asId(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return 0
}

function asNumberDeps(v: unknown): number[] {
  if (!Array.isArray(v)) return []
  const out: number[] = []
  for (const d of v) {
    if (typeof d === 'number' && Number.isFinite(d)) out.push(d)
    else if (typeof d === 'string') {
      const n = Number(d)
      if (Number.isFinite(n)) out.push(n)
    }
  }
  return out
}

function asMixedDeps(v: unknown): Array<number | string> {
  if (!Array.isArray(v)) return []
  const out: Array<number | string> = []
  for (const d of v) {
    if (typeof d === 'number' && Number.isFinite(d)) out.push(d)
    else if (typeof d === 'string' && d.length > 0) {
      const n = Number(d)
      out.push(Number.isFinite(n) && !d.includes('.') ? n : d)
    }
  }
  return out
}

function normalizeSubtask(raw: unknown): Subtask | null {
  if (!isObject(raw)) return null
  const sub: Subtask = {
    id: asId(raw.id),
    title: asString(raw.title, 'Untitled subtask'),
    description: asString(raw.description),
    status: normalizeStatus(raw.status),
    dependencies: asMixedDeps(raw.dependencies),
  }
  if (typeof raw.details === 'string') sub.details = raw.details
  return sub
}

function normalizeTask(raw: unknown): Task | null {
  if (!isObject(raw)) return null
  // A task must at least look like one (have an id or title); skip junk entries.
  if (raw.id === undefined && typeof raw.title !== 'string') return null

  const subtasks: Subtask[] = []
  if (Array.isArray(raw.subtasks)) {
    for (const s of raw.subtasks) {
      const sub = normalizeSubtask(s)
      if (sub) subtasks.push(sub)
    }
  }

  const task: Task = {
    id: asId(raw.id),
    title: asString(raw.title, 'Untitled task'),
    description: asString(raw.description),
    status: normalizeStatus(raw.status),
    dependencies: asNumberDeps(raw.dependencies),
    subtasks,
  }
  if (typeof raw.priority === 'string') task.priority = raw.priority
  if (typeof raw.details === 'string') task.details = raw.details
  if (typeof raw.testStrategy === 'string') task.testStrategy = raw.testStrategy
  return task
}

function normalizeTaskArray(raw: unknown): Task[] {
  if (!Array.isArray(raw)) return []
  const out: Task[] = []
  for (const t of raw) {
    const task = normalizeTask(t)
    if (task) out.push(task)
  }
  return out
}

/** True when an object value looks like a tag entry ({ tasks: [...] }). */
function looksLikeTag(v: unknown): v is { tasks: unknown[] } {
  return isObject(v) && Array.isArray(v.tasks)
}

/**
 * Parse the raw parsed JSON of a tasks.json file into a normalized Board.
 * Returns null when there is no recognizable task data at all (so callers can
 * show the empty / "not initialized" state). Never throws.
 */
export function parseBoard(parsed: unknown): Board | null {
  if (!isObject(parsed)) return null

  // Shape 1: legacy flat { tasks: [...] }.
  if (Array.isArray(parsed.tasks)) {
    const tasks = normalizeTaskArray(parsed.tasks)
    return { tags: [{ tag: 'master', tasks }], defaultTag: 'master' }
  }

  // Shape 2: tagged { master: { tasks: [...] }, feature: { tasks: [...] } }.
  const tags: TagBoard[] = []
  for (const [key, value] of Object.entries(parsed)) {
    if (looksLikeTag(value)) {
      tags.push({ tag: key, tasks: normalizeTaskArray(value.tasks) })
    }
  }
  if (tags.length === 0) return null

  const defaultTag = tags.some((t) => t.tag === 'master') ? 'master' : tags[0].tag
  return { tags, defaultTag }
}

/** Parse raw file text; null on any failure (missing/corrupt/non-task JSON). */
export function parseBoardText(text: string): Board | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  return parseBoard(parsed)
}

/** Look up a tag's tasks by name, falling back to the default tag. */
export function tasksForTag(board: Board, tag?: string): Task[] {
  const wanted = tag ?? board.defaultTag
  const found = board.tags.find((t) => t.tag === wanted)
  return (found ?? board.tags[0])?.tasks ?? []
}

/** Group a tag's tasks into the kanban columns. */
export function groupByColumn(tasks: Task[]): Record<string, Task[]> {
  const grouped: Record<string, Task[]> = {}
  for (const col of COLUMNS) grouped[col.id] = []
  for (const task of tasks) {
    const colId = columnForStatus(task.status)
    ;(grouped[colId] ??= []).push(task)
  }
  return grouped
}

// -----------------------------------------------------------------------------
// Mutation — write tasks back to disk.
//
// These operate on the RAW parsed JSON (not the normalized Board) and mutate in
// place, so unknown fields, metadata, and tag structure Task Master wrote are
// preserved byte-for-byte except for the field we change. Pure + isomorphic +
// tested; the server does the actual file I/O. Each returns the new file text
// (2-space indented, trailing newline — what Task Master itself writes) or null
// when the target can't be found, so the caller can 404 rather than clobber.
// -----------------------------------------------------------------------------

export interface TaskPatch {
  title?: string
  description?: string
  status?: TaskStatus
  priority?: string
  details?: string
  testStrategy?: string
  dependencies?: number[]
}

export interface NewTaskInput {
  title: string
  description?: string
  status?: TaskStatus
  priority?: string
  details?: string
  testStrategy?: string
  dependencies?: number[]
}

function serialize(parsed: unknown): string {
  return JSON.stringify(parsed, null, 2) + '\n'
}

/** The mutable raw task array for a tag, across both on-disk shapes. The legacy
 *  flat shape has a single implicit bucket Task Master calls "master". */
function rawTagTasks(parsed: Record<string, unknown>, tag: string): unknown[] | null {
  if (Array.isArray(parsed.tasks)) return parsed.tasks as unknown[]
  const bucket = parsed[tag]
  if (isObject(bucket) && Array.isArray(bucket.tasks)) return bucket.tasks as unknown[]
  return null
}

/** Next free integer id within a task array (max + 1, min 1). */
export function nextTaskId(tasks: unknown[]): number {
  let max = 0
  for (const t of tasks) {
    if (isObject(t)) {
      const n = asId(t.id)
      if (n > max) max = n
    }
  }
  return max + 1
}

/** Apply a partial update to one task. Returns new file text, or null when the
 *  tag/task can't be located (caller should treat as not-found). */
export function applyTaskPatch(
  text: string,
  tag: string,
  id: number,
  patch: TaskPatch,
): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!isObject(parsed)) return null
  const tasks = rawTagTasks(parsed, tag)
  if (!tasks) return null
  const target = tasks.find((t) => isObject(t) && asId(t.id) === id)
  if (!isObject(target)) return null
  if (patch.title !== undefined) target.title = patch.title
  if (patch.description !== undefined) target.description = patch.description
  if (patch.status !== undefined) target.status = patch.status
  if (patch.priority !== undefined) target.priority = patch.priority
  if (patch.details !== undefined) target.details = patch.details
  if (patch.testStrategy !== undefined) target.testStrategy = patch.testStrategy
  if (patch.dependencies !== undefined) target.dependencies = patch.dependencies
  return serialize(parsed)
}

/** Append a new task to a tag, creating the tag bucket (and the whole file) when
 *  absent so "create your first task" works on a fresh project. Returns the new
 *  file text plus the assigned id. */
export function addTask(
  text: string,
  tag: string,
  input: NewTaskInput,
): { text: string; id: number } | null {
  let parsed: unknown
  try {
    parsed = text.trim() ? JSON.parse(text) : {}
  } catch {
    return null
  }
  if (!isObject(parsed)) return null

  let tasks = rawTagTasks(parsed, tag)
  if (!tasks) {
    // No bucket for this tag yet: create a tagged bucket (modern Task Master
    // shape). We never invent a legacy flat file.
    const bucket: Record<string, unknown> = { tasks: [] }
    parsed[tag] = bucket
    tasks = bucket.tasks as unknown[]
  }

  const id = nextTaskId(tasks)
  const task: Record<string, unknown> = {
    id,
    title: input.title,
    description: input.description ?? '',
    status: input.status ?? 'pending',
    dependencies: input.dependencies ?? [],
    priority: input.priority ?? 'medium',
  }
  if (input.details !== undefined) task.details = input.details
  if (input.testStrategy !== undefined) task.testStrategy = input.testStrategy
  task.subtasks = []
  tasks.push(task)
  return { text: serialize(parsed), id }
}

// -----------------------------------------------------------------------------
// File-reference extraction — lets the panel "open" a file the task mentions.
// Task Master has no formal file field, so we heuristically pull path-like
// tokens out of the details/testStrategy/description text. A reference is a
// token that contains a slash and a known-ish file extension, optionally with a
// :line suffix (e.g. src/foo/bar.ts:42).
// -----------------------------------------------------------------------------

export interface FileRef {
  path: string
  line?: number
}

const FILE_REF_RE =
  /(?<![\w/.])((?:[\w.-]+\/)+[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|css|scss|html|py|go|rs|rb|java|kt|c|h|cpp|hpp|sh|yml|yaml|toml|sql|vue|svelte))(?::(\d+))?/g

/** Extract unique file references (with optional :line) from free text. */
export function extractFileRefs(text: string | undefined): FileRef[] {
  if (!text) return []
  const seen = new Set<string>()
  const refs: FileRef[] = []
  for (const m of text.matchAll(FILE_REF_RE)) {
    const path = m[1]
    const line = m[2] ? Number(m[2]) : undefined
    const key = `${path}:${line ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    refs.push(line !== undefined ? { path, line } : { path })
  }
  return refs
}

/** All file refs mentioned anywhere in a task (details, testStrategy, desc). */
export function fileRefsForTask(task: Task): FileRef[] {
  const seen = new Set<string>()
  const out: FileRef[] = []
  for (const text of [task.details, task.testStrategy, task.description]) {
    for (const ref of extractFileRefs(text)) {
      const key = `${ref.path}:${ref.line ?? ''}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(ref)
    }
  }
  return out
}
