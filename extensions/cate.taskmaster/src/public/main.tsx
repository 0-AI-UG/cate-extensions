// =============================================================================
// Task Master board — Cate extension panel.
//
// A native, interactive kanban board over a project's Task Master tasks. Not a
// viewer: you drag cards between columns to change status, create and edit tasks
// inline, and generate tasks from a spec via Cate's agent — all written back to
// `.taskmaster/tasks/tasks.json` in a format the Task Master CLI still reads.
//
// Cate-native glue:
//   - kit theme (initTheme)     : match Cate's light/dark theme via --cate-* tokens.
//   - cate.editor.openFile()    : click a file reference in a task to open it.
//   - cate.agent.run()          : generate tasks from a spec / work on a task.
//   - cate.storage.panel        : persist UI state (selected tag) per panel.
//   - cate.ui.notify()          : surface results / errors.
//
// Deterministic edits go through our server's write API (board-api); generative
// work is handed to the agent, which edits the tasks file directly. Either way
// the board polls /api/board for the on-disk truth.
// =============================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  COLUMNS,
  groupByColumn,
  tasksForTag,
  fileRefsForTask,
  type Board,
  type Task,
  type TaskStatus,
} from '../shared/taskmaster'
import { fetchBoard, patchTask, createTask } from './board-api'
import '../_kit/cate-kit.css'
import './styles.css'
import { initTheme } from '../_kit/theme'

const SELECTED_TAG_KEY = 'selectedTag'
const POLL_MS = 4000

// Column -> the canonical status to assign when a card is dropped into it.
const COLUMN_DROP_STATUS: Record<string, TaskStatus> = {
  pending: 'pending',
  'in-progress': 'in-progress',
  done: 'done',
}

const STATUS_LABEL: Record<TaskStatus, string> = {
  pending: 'Pending',
  'in-progress': 'In Progress',
  done: 'Done',
  review: 'Review',
  deferred: 'Deferred',
  cancelled: 'Cancelled',
  blocked: 'Blocked',
}

const STATUS_OPTIONS: TaskStatus[] = [
  'pending',
  'in-progress',
  'review',
  'blocked',
  'done',
  'deferred',
  'cancelled',
]

const PRIORITY_OPTIONS = ['high', 'medium', 'low']

// --- host helpers ------------------------------------------------------------

async function readSelectedTag(): Promise<string | undefined> {
  try {
    const raw = await cate?.storage.panel.get(SELECTED_TAG_KEY)
    return typeof raw === 'string' && raw ? raw : undefined
  } catch {
    return undefined
  }
}

function persistSelectedTag(tag: string): void {
  try {
    void cate?.storage.panel.set(SELECTED_TAG_KEY, tag)
  } catch {
    /* a failed UI-state save is not worth surfacing */
  }
}

function notify(message: string, level: 'info' | 'warn' | 'error' = 'info'): void {
  try {
    void cate?.ui.notify(message, level)
  } catch {
    /* best effort */
  }
}

/** Return a new Board with one task's status changed (optimistic update). */
function withStatus(board: Board, tag: string, id: number, status: TaskStatus): Board {
  return {
    ...board,
    tags: board.tags.map((t) =>
      t.tag !== tag ? t : { ...t, tasks: t.tasks.map((task) => (task.id === id ? { ...task, status } : task)) },
    ),
  }
}

// --- presentation ------------------------------------------------------------

function StatusDot({ status }: { status: TaskStatus }) {
  return <span className={`cate-dot tm-dot--${status}`} title={STATUS_LABEL[status]} />
}

function subtaskProgress(task: Task): { done: number; total: number } {
  const total = task.subtasks.length
  const done = task.subtasks.filter((s) => s.status === 'done' || s.status === 'cancelled').length
  return { done, total }
}

function TaskCard({
  task,
  onClick,
  onDragStart,
  onDragEnd,
}: {
  task: Task
  onClick: () => void
  onDragStart: () => void
  onDragEnd: () => void
}) {
  const { done, total } = subtaskProgress(task)
  return (
    <div
      className="tm-card"
      role="button"
      tabIndex={0}
      draggable
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onClick()
        }
      }}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', String(task.id))
        e.dataTransfer.effectAllowed = 'move'
        onDragStart()
      }}
      onDragEnd={onDragEnd}
    >
      <div className="tm-card__head">
        <StatusDot status={task.status} />
        <span className="tm-card__id">#{task.id}</span>
        {task.priority && <span className={`tm-prio tm-prio--${task.priority}`}>{task.priority}</span>}
      </div>
      <div className="tm-card__title">{task.title}</div>
      <div className="tm-card__meta">
        {total > 0 && (
          <span className="cate-chip" title="subtasks done / total">
            {done}/{total} subtasks
          </span>
        )}
        {task.dependencies.length > 0 && (
          <span className="cate-chip" title="depends on">
            deps: {task.dependencies.map((d) => `#${d}`).join(', ')}
          </span>
        )}
      </div>
    </div>
  )
}

function TaskDetail({
  task,
  onClose,
  onEdit,
}: {
  task: Task
  onClose: () => void
  onEdit: () => void
}) {
  const [agentBusy, setAgentBusy] = useState(false)
  // Inline, because cate.ui.notify is itself scope-gated and may be a no-op —
  // an agent failure must be visible in the panel, not just as a maybe-toast.
  const [agentError, setAgentError] = useState<string | null>(null)
  const refs = useMemo(() => fileRefsForTask(task), [task])

  const openFile = useCallback((path: string, line?: number) => {
    void cate?.editor.openFile(path, line !== undefined ? { line } : undefined)
  }, [])

  const sendToAgent = useCallback(async () => {
    if (!cate?.agent || agentBusy) return
    setAgentBusy(true)
    setAgentError(null)
    const prompt =
      `Work on Task Master task #${task.id}: "${task.title}".\n\n` +
      `Description: ${task.description || '(none)'}\n` +
      (task.details ? `\nImplementation details:\n${task.details}\n` : '') +
      (task.testStrategy ? `\nTest strategy:\n${task.testStrategy}\n` : '') +
      (task.subtasks.length
        ? `\nSubtasks:\n${task.subtasks.map((s) => `- [${s.status}] ${s.title}`).join('\n')}\n`
        : '')
    try {
      const result = await cate.agent.run(prompt)
      if (result && 'error' in result) {
        setAgentError(result.error)
        notify(`Agent: ${result.error}`, 'error')
      } else {
        notify('Agent finished working on this task', 'info')
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setAgentError(msg)
      notify(`Agent failed: ${msg}`, 'error')
    } finally {
      setAgentBusy(false)
    }
  }, [task, agentBusy])

  return (
    <div className="cate-drawer" role="dialog" aria-label={`Task ${task.id}`}>
      <div className="cate-drawer__head">
        <div className="tm-drawer__title">
          <StatusDot status={task.status} />
          <span className="tm-card__id">#{task.id}</span>
          <span>{task.title}</span>
        </div>
        <button className="cate-iconbtn" onClick={onClose} type="button" aria-label="Close">
          ×
        </button>
      </div>

      <div className="cate-drawer__body tm-detail">
        <div className="tm-detail__tags">
          <span className="tm-statuspill">
            <StatusDot status={task.status} />
            {STATUS_LABEL[task.status]}
          </span>
          {task.priority && <span className="cate-chip">priority: {task.priority}</span>}
        </div>

        {task.description && (
          <section>
            <h4>Description</h4>
            <p>{task.description}</p>
          </section>
        )}

        {task.dependencies.length > 0 && (
          <section>
            <h4>Dependencies</h4>
            <p>{task.dependencies.map((d) => `#${d}`).join(', ')}</p>
          </section>
        )}

        {task.details && (
          <section>
            <h4>Details</h4>
            <pre className="cate-pre">{task.details}</pre>
          </section>
        )}

        {task.testStrategy && (
          <section>
            <h4>Test Strategy</h4>
            <pre className="cate-pre">{task.testStrategy}</pre>
          </section>
        )}

        {task.subtasks.length > 0 && (
          <section>
            <h4>Subtasks ({task.subtasks.length})</h4>
            <ul className="tm-subs">
              {task.subtasks.map((s) => (
                <li key={s.id}>
                  <StatusDot status={s.status} />
                  <span className="tm-sub__id">
                    {task.id}.{s.id}
                  </span>
                  <span>{s.title}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {refs.length > 0 && (
          <section>
            <h4>File references</h4>
            <ul className="tm-files">
              {refs.map((r) => (
                <li key={`${r.path}:${r.line ?? ''}`}>
                  <button className="tm-filelink" type="button" onClick={() => openFile(r.path, r.line)}>
                    {r.path}
                    {r.line !== undefined ? `:${r.line}` : ''}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>

      {agentError && (
        <div className="cate-banner cate-banner--error tm-drawer__error">Agent failed: {agentError}</div>
      )}
      <div className="cate-drawer__foot">
        <button className="cate-btn" onClick={onEdit} type="button">
          Edit
        </button>
        {cate?.agent && (
          <button className="cate-btn cate-btn--primary" onClick={sendToAgent} disabled={agentBusy} type="button">
            {agentBusy ? 'Agent running…' : 'Send to agent'}
          </button>
        )}
      </div>
    </div>
  )
}

interface EditorValues {
  title: string
  description: string
  status: TaskStatus
  priority: string
  details: string
  testStrategy: string
}

function emptyEditor(): EditorValues {
  return { title: '', description: '', status: 'pending', priority: 'medium', details: '', testStrategy: '' }
}

function editorFromTask(task: Task): EditorValues {
  return {
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority || 'medium',
    details: task.details || '',
    testStrategy: task.testStrategy || '',
  }
}

function TaskEditor({
  mode,
  initial,
  onCancel,
  onSave,
}: {
  mode: 'create' | 'edit'
  initial: EditorValues
  onCancel: () => void
  /** Resolves with an error message to show inline, or null on success. */
  onSave: (values: EditorValues) => Promise<string | null>
}) {
  const [values, setValues] = useState<EditorValues>(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const set = <K extends keyof EditorValues>(key: K, v: EditorValues[K]) =>
    setValues((prev) => ({ ...prev, [key]: v }))

  const save = async () => {
    if (!values.title.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      setError(await onSave(values))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="cate-drawer" role="dialog" aria-label={mode === 'create' ? 'New task' : 'Edit task'}>
      <div className="cate-drawer__head">
        <div className="tm-drawer__title">{mode === 'create' ? 'New task' : 'Edit task'}</div>
        <button className="cate-iconbtn" onClick={onCancel} type="button" aria-label="Close">
          ×
        </button>
      </div>
      <div className="cate-drawer__body">
        <div className="cate-field">
          <label className="cate-label">Title</label>
          <input
            className="cate-input"
            value={values.title}
            autoFocus
            onChange={(e) => set('title', e.target.value)}
            placeholder="What needs doing?"
          />
        </div>
        <div className="cate-field">
          <label className="cate-label">Description</label>
          <textarea
            className="cate-input tm-textarea"
            value={values.description}
            onChange={(e) => set('description', e.target.value)}
            rows={3}
          />
        </div>
        <div className="tm-editor__row">
          <div className="cate-field">
            <label className="cate-label">Status</label>
            <select
              className="cate-select"
              value={values.status}
              onChange={(e) => set('status', e.target.value as TaskStatus)}
            >
              {STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </div>
          <div className="cate-field">
            <label className="cate-label">Priority</label>
            <select
              className="cate-select"
              value={values.priority}
              onChange={(e) => set('priority', e.target.value)}
            >
              {PRIORITY_OPTIONS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="cate-field">
          <label className="cate-label">Details</label>
          <textarea
            className="cate-input tm-textarea"
            value={values.details}
            onChange={(e) => set('details', e.target.value)}
            rows={4}
          />
        </div>
        <div className="cate-field">
          <label className="cate-label">Test strategy</label>
          <textarea
            className="cate-input tm-textarea"
            value={values.testStrategy}
            onChange={(e) => set('testStrategy', e.target.value)}
            rows={2}
          />
        </div>
      </div>
      {error && <div className="cate-banner cate-banner--error tm-drawer__error">Save failed: {error}</div>}
      <div className="cate-drawer__foot">
        <button className="cate-btn" onClick={onCancel} type="button">
          Cancel
        </button>
        <button
          className="cate-btn cate-btn--primary"
          onClick={() => void save()}
          disabled={busy || !values.title.trim()}
          type="button"
        >
          {busy ? 'Saving…' : mode === 'create' ? 'Create task' : 'Save changes'}
        </button>
      </div>
    </div>
  )
}

function GenerateDrawer({
  tag,
  onClose,
  onDone,
}: {
  tag: string
  onClose: () => void
  onDone: () => void
}) {
  const [spec, setSpec] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const generate = async () => {
    if (!spec.trim() || busy || !cate?.agent) return
    setBusy(true)
    setError(null)
    const prompt =
      `You are working in a project that uses Task Master. The tasks file is ` +
      `\`.taskmaster/tasks/tasks.json\`. Read it if it exists.\n\n` +
      `Break the request below into well-scoped tasks and WRITE them into that ` +
      `file using Task Master's tagged JSON format:\n` +
      `{ "${tag}": { "tasks": [ { "id": <int>, "title", "description", ` +
      `"status": "pending", "dependencies": [<int>], "priority": "high|medium|low", ` +
      `"details", "testStrategy", "subtasks": [] } ] } }\n` +
      `Use the tag "${tag}". Preserve existing tasks and append new ones with fresh ` +
      `sequential ids. Status must be one of pending|in-progress|done|review|deferred|cancelled.\n\n` +
      `Request:\n${spec.trim()}`
    try {
      const result = await cate.agent.run(prompt)
      if (result && 'error' in result) {
        setError(result.error)
        notify(`Agent: ${result.error}`, 'error')
      } else {
        notify('Tasks generated', 'info')
        onDone()
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
      notify(`Agent failed: ${msg}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="cate-drawer" role="dialog" aria-label="Generate tasks">
      <div className="cate-drawer__head">
        <div className="tm-drawer__title">Generate tasks</div>
        <button className="cate-iconbtn" onClick={onClose} type="button" aria-label="Close">
          ×
        </button>
      </div>
      <div className="cate-drawer__body">
        <p className="tm-muted">
          Describe what you want to build, or point at a PRD/spec file in the project. Cate's agent will
          break it into tasks and write them to <code>.taskmaster/tasks/tasks.json</code>.
        </p>
        <textarea
          className="cate-input tm-textarea"
          value={spec}
          autoFocus
          rows={10}
          placeholder={'e.g. Build a REST API for a todo app with auth, CRUD, and tests.\nOr: Generate tasks from .taskmaster/docs/prd.txt'}
          onChange={(e) => setSpec(e.target.value)}
        />
      </div>
      {error && <div className="cate-banner cate-banner--error tm-drawer__error">Agent failed: {error}</div>}
      <div className="cate-drawer__foot">
        <button className="cate-btn" onClick={onClose} type="button">
          Cancel
        </button>
        <button
          className="cate-btn cate-btn--primary"
          onClick={() => void generate()}
          disabled={busy || !spec.trim()}
          type="button"
        >
          {busy ? 'Generating…' : 'Generate'}
        </button>
      </div>
    </div>
  )
}

const EMPTY_ICON =
  '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><rect x="1.5" y="2.5" width="3.5" height="11" rx="1" fill="none" stroke="currentColor"/><rect x="6.25" y="2.5" width="3.5" height="7" rx="1" fill="none" stroke="currentColor"/><rect x="11" y="2.5" width="3.5" height="9" rx="1" fill="none" stroke="currentColor"/></svg>'

function EmptyState({
  mode,
  path,
  canAgent,
  onCreate,
  onGenerate,
}: {
  /** uninitialized: no tasks file on disk yet; empty: file exists, no tasks. */
  mode: 'uninitialized' | 'empty'
  path: string | null
  canAgent: boolean
  onCreate: () => void
  onGenerate: () => void
}) {
  return (
    <div className="cate-empty">
      <div
        className="cate-empty__icon"
        aria-hidden="true"
        dangerouslySetInnerHTML={{ __html: EMPTY_ICON }}
      />
      <h3>{mode === 'uninitialized' ? 'Task Master isn’t set up here' : 'No tasks yet'}</h3>
      {mode === 'uninitialized' ? (
        <p>
          Run <code>task-master init</code> in the project root to initialize it — or just create a
          task below and the board will create the file for you.
        </p>
      ) : (
        <p>Create your first task, or let Cate's agent generate a plan from a spec.</p>
      )}
      <div className="cate-conn__actions">
        <button className="cate-btn cate-btn--primary" onClick={onCreate} type="button">
          Create your first task
        </button>
        {canAgent && (
          <button className="cate-btn" onClick={onGenerate} type="button">
            Generate from a spec…
          </button>
        )}
      </div>
      {path && (
        <p className="tm-muted">
          Stored at <code>{path}</code> — compatible with the Task Master CLI.
        </p>
      )}
    </div>
  )
}

/** Full-panel state for a tasks.json we can't parse: show the error and keep
 *  the poll running — the board recovers by itself once the file is fixed. */
function ErrorState({ error, path }: { error: string; path: string | null }) {
  return (
    <div className="tm-errorstate">
      <div className="cate-banner cate-banner--error">Couldn’t read tasks: {error}</div>
      <p className="tm-muted">
        Watching <code>{path ?? 'tasks.json'}</code> — the board will recover as soon as the file
        parses again.
      </p>
    </div>
  )
}

// --- root --------------------------------------------------------------------

type Drawer = { kind: 'detail'; id: number } | { kind: 'edit'; id: number } | { kind: 'create' } | { kind: 'generate' } | null

function App() {
  const [board, setBoard] = useState<Board | null>(null)
  const [tag, setTag] = useState<string | undefined>(undefined)
  const [path, setPath] = useState<string | null>(null)
  const [initialized, setInitialized] = useState<boolean | null>(null)
  const [error, setError] = useState<string | undefined>(undefined)
  const [drawer, setDrawer] = useState<Drawer>(null)
  const [draggingId, setDraggingId] = useState<number | null>(null)
  const [dragOver, setDragOver] = useState<string | null>(null)
  const lastMtime = useRef<number | null>(null)
  const hasBoard = useRef(false) // ref, not state: `load` is a stable callback
  const writing = useRef(false)

  // Boot: theme + persisted tag.
  useEffect(() => {
    let alive = true
    void (async () => {
      const [, savedTag] = await Promise.all([initTheme(), readSelectedTag()])
      if (alive && savedTag) setTag(savedTag)
    })()
    return () => {
      alive = false
    }
  }, [])

  const load = useCallback(async (force = false) => {
    if (writing.current && !force) return
    try {
      const res = await fetchBoard()
      if (!force && res.mtime !== null && res.mtime === lastMtime.current && hasBoard.current) return
      lastMtime.current = res.mtime
      setInitialized(res.initialized)
      setPath(res.path)
      setError(res.error)
      // On a read/parse error keep showing the last good board (with the error
      // banner) instead of blanking it; polling recovers when the file is fixed.
      if (res.board !== null || !res.error) {
        setBoard(res.board)
        hasBoard.current = res.board !== null
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    void load()
    const id = setInterval(() => void load(), POLL_MS)
    return () => clearInterval(id)
  }, [load])

  const activeTag = tag ?? board?.defaultTag ?? 'master'
  const tasks = useMemo(() => (board ? tasksForTag(board, activeTag) : []), [board, activeTag])
  const grouped = useMemo(() => groupByColumn(tasks), [tasks])
  const selectedTask = useMemo(() => {
    const id = drawer && (drawer.kind === 'detail' || drawer.kind === 'edit') ? drawer.id : null
    return id !== null ? tasks.find((t) => t.id === id) ?? null : null
  }, [tasks, drawer])

  const onSelectTag = useCallback((next: string) => {
    setTag(next)
    persistSelectedTag(next)
    setDrawer(null)
  }, [])

  // Drop a card into a column -> change its status.
  const onDropTask = useCallback(
    async (taskId: number, columnId: string) => {
      setDragOver(null)
      setDraggingId(null)
      const status = COLUMN_DROP_STATUS[columnId]
      if (!board || !status) return
      const current = tasks.find((t) => t.id === taskId)
      if (!current || current.status === status) return
      setBoard(withStatus(board, activeTag, taskId, status)) // optimistic
      writing.current = true
      const res = await patchTask(activeTag, taskId, { status })
      writing.current = false
      if (!res.ok) {
        notify(`Couldn't move task: ${res.error}`, 'error')
        void load(true) // revert to disk truth
      } else {
        void load(true)
      }
    },
    [board, tasks, activeTag, load],
  )

  const saveEditor = useCallback(
    async (mode: 'create' | 'edit', values: EditorValues, id?: number): Promise<string | null> => {
      writing.current = true
      const patch = {
        title: values.title.trim(),
        description: values.description,
        status: values.status,
        priority: values.priority,
        details: values.details,
        testStrategy: values.testStrategy,
      }
      const res =
        mode === 'create'
          ? await createTask(activeTag, patch)
          : await patchTask(activeTag, id!, patch)
      writing.current = false
      if (!res.ok) {
        const msg = res.error ?? 'unknown error'
        notify(`Save failed: ${msg}`, 'error')
        void load(true) // e.g. a 409: pick up whatever changed on disk
        return msg
      }
      setDrawer(null)
      await load(true)
      return null
    },
    [activeTag, load],
  )

  const canAgent = Boolean(cate?.agent)

  if (initialized === null && !board) {
    return <div className="cate-app tm-center">Loading…</div>
  }
  // Corrupt/unreadable tasks.json with no last-good board to fall back on.
  if (error && !board) {
    return (
      <div className="cate-app">
        <ErrorState error={error} path={path} />
      </div>
    )
  }
  if (initialized === false || board === null || tasks.length === 0) {
    return (
      <div className="cate-app">
        <Topbar
          board={board}
          activeTag={activeTag}
          count={0}
          canAgent={canAgent}
          onSelectTag={onSelectTag}
          onNew={() => setDrawer({ kind: 'create' })}
          onGenerate={() => setDrawer({ kind: 'generate' })}
        />
        <EmptyState
          mode={initialized === false ? 'uninitialized' : 'empty'}
          path={path}
          canAgent={canAgent}
          onCreate={() => setDrawer({ kind: 'create' })}
          onGenerate={() => setDrawer({ kind: 'generate' })}
        />
        {drawer?.kind === 'create' && (
          <TaskEditor
            mode="create"
            initial={emptyEditor()}
            onCancel={() => setDrawer(null)}
            onSave={(v) => saveEditor('create', v)}
          />
        )}
        {drawer?.kind === 'generate' && (
          <GenerateDrawer tag={activeTag} onClose={() => setDrawer(null)} onDone={() => void load(true)} />
        )}
      </div>
    )
  }

  return (
    <div className="cate-app">
      <Topbar
        board={board}
        activeTag={activeTag}
        count={tasks.length}
        canAgent={canAgent}
        onSelectTag={onSelectTag}
        onNew={() => setDrawer({ kind: 'create' })}
        onGenerate={() => setDrawer({ kind: 'generate' })}
      />

      {error && <div className="cate-banner cate-banner--error">Couldn’t read tasks: {error}</div>}

      <div className="tm-board">
        {COLUMNS.map((col) => (
          <div
            className={`tm-col${dragOver === col.id ? ' tm-col--over' : ''}`}
            key={col.id}
            onDragOver={(e) => {
              if (draggingId === null) return
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              if (dragOver !== col.id) setDragOver(col.id)
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver((c) => (c === col.id ? null : c))
            }}
            onDrop={(e) => {
              e.preventDefault()
              const id = Number(e.dataTransfer.getData('text/plain'))
              if (Number.isFinite(id)) void onDropTask(id, col.id)
            }}
          >
            <div className="tm-col__head">
              {col.label}
              <span className="tm-col__count">{grouped[col.id]?.length ?? 0}</span>
            </div>
            <div className="tm-col__body">
              {(grouped[col.id] ?? []).map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  onClick={() => setDrawer({ kind: 'detail', id: task.id })}
                  onDragStart={() => setDraggingId(task.id)}
                  onDragEnd={() => {
                    setDraggingId(null)
                    setDragOver(null)
                  }}
                />
              ))}
              {(grouped[col.id]?.length ?? 0) === 0 && <div className="tm-col__empty">Drop here</div>}
            </div>
          </div>
        ))}
      </div>

      {drawer?.kind === 'detail' && selectedTask && (
        <TaskDetail
          task={selectedTask}
          onClose={() => setDrawer(null)}
          onEdit={() => setDrawer({ kind: 'edit', id: selectedTask.id })}
        />
      )}
      {drawer?.kind === 'edit' && selectedTask && (
        <TaskEditor
          mode="edit"
          initial={editorFromTask(selectedTask)}
          onCancel={() => setDrawer({ kind: 'detail', id: selectedTask.id })}
          onSave={(v) => saveEditor('edit', v, selectedTask.id)}
        />
      )}
      {drawer?.kind === 'create' && (
        <TaskEditor
          mode="create"
          initial={emptyEditor()}
          onCancel={() => setDrawer(null)}
          onSave={(v) => saveEditor('create', v)}
        />
      )}
      {drawer?.kind === 'generate' && (
        <GenerateDrawer tag={activeTag} onClose={() => setDrawer(null)} onDone={() => void load(true)} />
      )}
    </div>
  )
}

function Topbar({
  board,
  activeTag,
  count,
  canAgent,
  onSelectTag,
  onNew,
  onGenerate,
}: {
  board: Board | null
  activeTag: string
  count: number
  canAgent: boolean
  onSelectTag: (tag: string) => void
  onNew: () => void
  onGenerate: () => void
}) {
  return (
    <header className="cate-topbar">
      <span className="cate-topbar__title">Task Master</span>
      {board && board.tags.length > 1 && (
        <select
          className="cate-select tm-tagselect"
          value={activeTag}
          onChange={(e) => onSelectTag(e.target.value)}
          aria-label="Tag context"
        >
          {board.tags.map((t) => (
            <option key={t.tag} value={t.tag}>
              {t.tag} ({t.tasks.length})
            </option>
          ))}
        </select>
      )}
      <span className="cate-topbar__spacer" />
      <span className="tm-muted">{count} tasks</span>
      {canAgent && (
        <button className="cate-btn" onClick={onGenerate} type="button">
          Generate…
        </button>
      )}
      <button className="cate-btn cate-btn--primary" onClick={onNew} type="button">
        New task
      </button>
    </header>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
