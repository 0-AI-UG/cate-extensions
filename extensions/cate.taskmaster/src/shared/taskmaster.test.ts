import { describe, it, expect } from 'vitest'
import {
  parseBoard,
  parseBoardText,
  normalizeStatus,
  columnForStatus,
  groupByColumn,
  tasksForTag,
  extractFileRefs,
  fileRefsForTask,
  applyTaskPatch,
  addTask,
  nextTaskId,
  coerceStatusInput,
  validateTaskPatch,
  validateNewTask,
  COLUMNS,
  type Task,
} from './taskmaster'

// A legacy flat tasks.json (pre-0.16).
const flat = {
  tasks: [
    {
      id: 1,
      title: 'Set up auth',
      description: 'OAuth login',
      status: 'in-progress',
      dependencies: [],
      priority: 'high',
      details: 'Edit src/auth/oauth.ts:42 and add a provider.',
      testStrategy: 'Unit test src/auth/oauth.test.ts',
      subtasks: [
        { id: 1, title: 'Configure OAuth', status: 'done', dependencies: [] },
        { id: 2, title: 'Add callback', status: 'pending', dependencies: [1] },
      ],
    },
    { id: 2, title: 'Write docs', description: '', status: 'pending', dependencies: [1] },
    { id: 3, title: 'Ship it', description: '', status: 'done', dependencies: [1, 2] },
  ],
  metadata: { created: '2025-01-01' },
}

// A tagged (>=0.16) tasks.json.
const tagged = {
  master: { tasks: [{ id: 1, title: 'Master task', status: 'pending' }] },
  'feature-x': {
    tasks: [
      { id: 1, title: 'Feature task A', status: 'review' },
      { id: 2, title: 'Feature task B', status: 'done' },
    ],
  },
}

describe('parseBoard', () => {
  it('parses the legacy flat shape under a synthetic "master" tag', () => {
    const board = parseBoard(flat)
    expect(board).not.toBeNull()
    expect(board!.defaultTag).toBe('master')
    expect(board!.tags).toHaveLength(1)
    expect(board!.tags[0].tasks).toHaveLength(3)
    const t = board!.tags[0].tasks[0]
    expect(t.title).toBe('Set up auth')
    expect(t.status).toBe('in-progress')
    expect(t.priority).toBe('high')
    expect(t.subtasks).toHaveLength(2)
  })

  it('parses the tagged shape with multiple contexts and prefers master', () => {
    const board = parseBoard(tagged)
    expect(board).not.toBeNull()
    expect(board!.defaultTag).toBe('master')
    expect(board!.tags.map((t) => t.tag).sort()).toEqual(['feature-x', 'master'])
    expect(tasksForTag(board!, 'feature-x')).toHaveLength(2)
  })

  it('falls back to the first tag when there is no master', () => {
    const board = parseBoard({ dev: { tasks: [{ id: 1, title: 'x' }] } })
    expect(board!.defaultTag).toBe('dev')
  })

  it('returns null for non-task JSON, and for empty/garbage input', () => {
    expect(parseBoard({})).toBeNull()
    expect(parseBoard({ random: 1 })).toBeNull()
    expect(parseBoard(null)).toBeNull()
    expect(parseBoard(42)).toBeNull()
    expect(parseBoard([])).toBeNull()
  })

  it('tolerates an empty tasks array (initialized but no tasks)', () => {
    const board = parseBoard({ tasks: [] })
    expect(board).not.toBeNull()
    expect(board!.tags[0].tasks).toHaveLength(0)
  })

  it('skips junk entries inside the tasks array without throwing', () => {
    const board = parseBoard({ tasks: [null, 5, { id: 1, title: 'ok' }, 'nope'] })
    expect(board!.tags[0].tasks).toHaveLength(1)
    expect(board!.tags[0].tasks[0].title).toBe('ok')
  })
})

describe('parseBoardText', () => {
  it('parses valid JSON text', () => {
    expect(parseBoardText(JSON.stringify(flat))).not.toBeNull()
  })
  it('returns null on corrupt JSON', () => {
    expect(parseBoardText('{ not json')).toBeNull()
    expect(parseBoardText('')).toBeNull()
  })
})

describe('normalizeStatus', () => {
  it('passes known statuses through', () => {
    for (const s of ['pending', 'in-progress', 'done', 'review', 'deferred', 'cancelled', 'blocked']) {
      expect(normalizeStatus(s)).toBe(s)
    }
  })
  it('maps aliases and unknown values', () => {
    expect(normalizeStatus('completed')).toBe('done')
    expect(normalizeStatus('in_progress')).toBe('in-progress')
    expect(normalizeStatus('In Progress')).toBe('in-progress')
    expect(normalizeStatus('canceled')).toBe('cancelled')
    expect(normalizeStatus('weird')).toBe('pending')
    expect(normalizeStatus(undefined)).toBe('pending')
    expect(normalizeStatus(123)).toBe('pending')
  })
})

describe('columns', () => {
  it('maps statuses to the right column', () => {
    expect(columnForStatus('pending')).toBe('pending')
    expect(columnForStatus('deferred')).toBe('pending')
    expect(columnForStatus('in-progress')).toBe('in-progress')
    expect(columnForStatus('review')).toBe('in-progress')
    expect(columnForStatus('blocked')).toBe('in-progress')
    expect(columnForStatus('done')).toBe('done')
    expect(columnForStatus('cancelled')).toBe('done')
  })

  it('groups tasks into columns', () => {
    const board = parseBoard(flat)!
    const grouped = groupByColumn(board.tags[0].tasks)
    expect(grouped['pending'].map((t) => t.id)).toEqual([2])
    expect(grouped['in-progress'].map((t) => t.id)).toEqual([1])
    expect(grouped['done'].map((t) => t.id)).toEqual([3])
    // every column key exists even when empty
    for (const col of COLUMNS) expect(grouped[col.id]).toBeDefined()
  })
})

describe('file reference extraction', () => {
  it('pulls path-like tokens with optional :line', () => {
    const refs = extractFileRefs('Edit src/auth/oauth.ts:42 then check lib/util.js')
    expect(refs).toEqual([
      { path: 'src/auth/oauth.ts', line: 42 },
      { path: 'lib/util.js' },
    ])
  })

  it('ignores bare filenames without a directory and unknown extensions', () => {
    expect(extractFileRefs('see README and run thing.exe and foo.unknown')).toEqual([])
  })

  it('dedupes repeated references', () => {
    const refs = extractFileRefs('src/a.ts and again src/a.ts')
    expect(refs).toHaveLength(1)
  })

  it('collects refs across a task’s details/testStrategy/description', () => {
    const task = parseBoard(flat)!.tags[0].tasks[0]
    const refs = fileRefsForTask(task)
    const paths = refs.map((r) => r.path)
    expect(paths).toContain('src/auth/oauth.ts')
    expect(paths).toContain('src/auth/oauth.test.ts')
  })

  it('returns [] for tasks with no text', () => {
    const empty: Task = {
      id: 9,
      title: 't',
      description: '',
      status: 'pending',
      dependencies: [],
      subtasks: [],
    }
    expect(fileRefsForTask(empty)).toEqual([])
  })
})

describe('applyTaskPatch', () => {
  it('changes a task status in the tagged shape, preserving other fields', () => {
    const text = JSON.stringify(tagged)
    const out = applyTaskPatch(text, 'master', 1, { status: 'done' })
    expect(out).not.toBeNull()
    const reparsed = JSON.parse(out!)
    expect(reparsed.master.tasks[0].status).toBe('done')
    expect(reparsed.master.tasks[0].title).toBe('Master task')
    // Sibling tag untouched.
    expect(reparsed['feature-x'].tasks).toHaveLength(2)
  })

  it('changes a status in the legacy flat shape and preserves metadata', () => {
    const text = JSON.stringify(flat)
    const out = applyTaskPatch(text, 'master', 2, { status: 'in-progress' })
    const reparsed = JSON.parse(out!)
    expect(reparsed.tasks[1].status).toBe('in-progress')
    expect(reparsed.metadata.created).toBe('2025-01-01')
  })

  it('patches multiple fields at once', () => {
    const out = applyTaskPatch(JSON.stringify(tagged), 'master', 1, {
      title: 'Renamed',
      priority: 'high',
      description: 'new desc',
    })
    const t = JSON.parse(out!).master.tasks[0]
    expect(t.title).toBe('Renamed')
    expect(t.priority).toBe('high')
    expect(t.description).toBe('new desc')
  })

  it('returns null for an unknown tag or task id', () => {
    expect(applyTaskPatch(JSON.stringify(tagged), 'nope', 1, { status: 'done' })).toBeNull()
    expect(applyTaskPatch(JSON.stringify(tagged), 'master', 999, { status: 'done' })).toBeNull()
  })

  it('returns null on corrupt JSON rather than clobbering', () => {
    expect(applyTaskPatch('{not json', 'master', 1, { status: 'done' })).toBeNull()
  })

  it('ends the file with a trailing newline (matching Task Master)', () => {
    const out = applyTaskPatch(JSON.stringify(tagged), 'master', 1, { status: 'done' })
    expect(out!.endsWith('\n')).toBe(true)
  })
})

describe('addTask', () => {
  it('appends a task with the next id and defaults', () => {
    const res = addTask(JSON.stringify(tagged), 'master', { title: 'Fresh task' })
    expect(res).not.toBeNull()
    expect(res!.id).toBe(2)
    const tasks = JSON.parse(res!.text).master.tasks
    expect(tasks).toHaveLength(2)
    expect(tasks[1]).toMatchObject({ id: 2, title: 'Fresh task', status: 'pending', priority: 'medium' })
    expect(tasks[1].subtasks).toEqual([])
  })

  it('creates the tag bucket and the whole file when empty (first task)', () => {
    const res = addTask('', 'master', { title: 'First ever', status: 'pending' })
    expect(res).not.toBeNull()
    expect(res!.id).toBe(1)
    const parsed = JSON.parse(res!.text)
    expect(parsed.master.tasks[0].title).toBe('First ever')
  })

  it('appends into the legacy flat shape', () => {
    const res = addTask(JSON.stringify(flat), 'master', { title: 'Another' })
    expect(res!.id).toBe(4)
    expect(JSON.parse(res!.text).tasks).toHaveLength(4)
  })
})

describe('nextTaskId', () => {
  it('returns max id + 1, or 1 for an empty array', () => {
    expect(nextTaskId([])).toBe(1)
    expect(nextTaskId([{ id: 3 }, { id: 7 }, { id: 2 }])).toBe(8)
  })
})

describe('unknown-field preservation (round-trip)', () => {
  // Fields the extension does not model: on tasks, subtasks, tag buckets, and
  // at the top level. Writes must never drop them.
  const flatExtras = {
    tasks: [
      {
        id: 1,
        title: 'A',
        status: 'pending',
        dependencies: [],
        assignee: 'sam',
        labels: ['backend', 'urgent'],
        subtasks: [{ id: 1, title: 's', status: 'pending', dependencies: [], estimate: '2h' }],
      },
    ],
    metadata: { created: '2025-01-01', custom: { nested: true } },
    somethingElse: 42,
  }
  const taggedExtras = {
    $schema: 'https://example.com/tasks.schema.json',
    master: {
      tasks: [{ id: 1, title: 'A', status: 'pending', vendorField: { a: 1 } }],
      metadata: { description: 'main context' },
    },
    'feature-x': { tasks: [{ id: 1, title: 'B', status: 'done' }] },
  }

  it('applyTaskPatch keeps unknown task/subtask/top-level fields (flat shape)', () => {
    const out = JSON.parse(applyTaskPatch(JSON.stringify(flatExtras), 'master', 1, { status: 'done' })!)
    expect(out.tasks[0].assignee).toBe('sam')
    expect(out.tasks[0].labels).toEqual(['backend', 'urgent'])
    expect(out.tasks[0].subtasks[0].estimate).toBe('2h')
    expect(out.metadata).toEqual({ created: '2025-01-01', custom: { nested: true } })
    expect(out.somethingElse).toBe(42)
    expect(out.tasks[0].status).toBe('done')
  })

  it('applyTaskPatch changes ONLY the patched field (tagged shape, deep equal)', () => {
    const expected = JSON.parse(JSON.stringify(taggedExtras))
    expected.master.tasks[0].title = 'Renamed'
    const out = JSON.parse(applyTaskPatch(JSON.stringify(taggedExtras), 'master', 1, { title: 'Renamed' })!)
    expect(out).toEqual(expected)
  })

  it('addTask appends without touching anything else (flat shape, deep equal)', () => {
    const res = addTask(JSON.stringify(flatExtras), 'master', { title: 'New' })!
    const out = JSON.parse(res.text)
    const expected = JSON.parse(JSON.stringify(flatExtras))
    expected.tasks.push(out.tasks[1]) // the appended task itself
    expect(out).toEqual(expected)
    expect(out.tasks[1].title).toBe('New')
  })

  it('addTask keeps tag metadata and sibling tags (tagged shape)', () => {
    const out = JSON.parse(addTask(JSON.stringify(taggedExtras), 'master', { title: 'New' })!.text)
    expect(out.$schema).toBe('https://example.com/tasks.schema.json')
    expect(out.master.metadata).toEqual({ description: 'main context' })
    expect(out.master.tasks[0].vendorField).toEqual({ a: 1 })
    expect(out['feature-x']).toEqual(taggedExtras['feature-x'])
  })
})

describe('coerceStatusInput', () => {
  it('accepts known statuses and aliases', () => {
    expect(coerceStatusInput('done')).toBe('done')
    expect(coerceStatusInput('completed')).toBe('done')
    expect(coerceStatusInput('In Progress')).toBe('in-progress')
    expect(coerceStatusInput('canceled')).toBe('cancelled')
  })
  it('rejects unknown values instead of defaulting', () => {
    expect(coerceStatusInput('donezo')).toBeNull()
    expect(coerceStatusInput('')).toBeNull()
    expect(coerceStatusInput(42)).toBeNull()
    expect(coerceStatusInput(undefined)).toBeNull()
  })
})

describe('validateTaskPatch', () => {
  it('accepts a clean patch and normalizes status aliases', () => {
    const v = validateTaskPatch({ title: 'T', status: 'completed', dependencies: [1, 2] })
    expect(v).toEqual({ ok: true, patch: { title: 'T', status: 'done', dependencies: [1, 2] } })
  })
  it('rejects non-object patches', () => {
    for (const bad of [null, undefined, 'x', 42, [1]]) {
      expect(validateTaskPatch(bad).ok).toBe(false)
    }
  })
  it('rejects invalid status values', () => {
    expect(validateTaskPatch({ status: 'donezo' })).toMatchObject({ ok: false })
    expect(validateTaskPatch({ status: 7 })).toMatchObject({ ok: false })
  })
  it('rejects wrong-typed string fields', () => {
    expect(validateTaskPatch({ title: 42 })).toMatchObject({ ok: false })
    expect(validateTaskPatch({ details: { rich: true } })).toMatchObject({ ok: false })
  })
  it('rejects an empty title', () => {
    expect(validateTaskPatch({ title: '   ' })).toMatchObject({ ok: false })
  })
  it('rejects malformed dependencies', () => {
    expect(validateTaskPatch({ dependencies: 'nope' })).toMatchObject({ ok: false })
    expect(validateTaskPatch({ dependencies: [1, 'two'] })).toMatchObject({ ok: false })
    expect(validateTaskPatch({ dependencies: [NaN] })).toMatchObject({ ok: false })
  })
  it('drops unknown keys so they are never written', () => {
    const v = validateTaskPatch({ title: 'T', evil: 'payload', subtasks: [] })
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.patch).toEqual({ title: 'T' })
  })
  it('accepts an empty patch (harmless no-op)', () => {
    expect(validateTaskPatch({})).toEqual({ ok: true, patch: {} })
  })
})

describe('validateNewTask', () => {
  it('requires a non-empty title', () => {
    expect(validateNewTask({})).toMatchObject({ ok: false })
    expect(validateNewTask({ title: ' ' })).toMatchObject({ ok: false })
    expect(validateNewTask(undefined)).toMatchObject({ ok: false })
  })
  it('applies the same field rules as a patch', () => {
    expect(validateNewTask({ title: 'T', status: 'nope' })).toMatchObject({ ok: false })
    expect(validateNewTask({ title: 'T', dependencies: ['x'] })).toMatchObject({ ok: false })
  })
  it('accepts minimal valid input', () => {
    const v = validateNewTask({ title: 'Ship it' })
    expect(v).toEqual({ ok: true, task: { title: 'Ship it' } })
  })
})
