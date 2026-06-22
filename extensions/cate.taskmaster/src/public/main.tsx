// =============================================================================
// Task Master kanban board — Cate extension panel.
//
// Renders the project's Task Master tasks as a kanban board (Pending / In
// Progress / Done), with a task detail drawer (description, dependencies,
// subtasks, file references). Cate-native glue:
//   - cate.theme.get()        : match Cate's light/dark theme.
//   - cate.editor.openFile()  : click a file reference in a task to open it.
//   - cate.agent.run()        : hand a task to Cate's bundled agent.
//   - cate.storage.panel      : persist UI state (selected tag) per panel.
//   - cate.ui.notify()        : surface agent results / errors.
//
// The board data itself comes from our extension server's /api/board (the
// cateHost API has no file read), polled for live refresh.
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
import { fetchBoard } from './board-api'
import './styles.css'

const cate = (globalThis as { cate?: CateHost }).cate
const SELECTED_TAG_KEY = 'selectedTag'
const POLL_MS = 4000

type ThemeType = 'dark' | 'light'

// --- host helpers ------------------------------------------------------------

async function readThemeType(): Promise<ThemeType> {
  try {
    const theme = await cate?.theme.get()
    return theme?.type === 'light' ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}

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

// --- presentation ------------------------------------------------------------

const STATUS_LABEL: Record<TaskStatus, string> = {
  pending: 'Pending',
  'in-progress': 'In Progress',
  done: 'Done',
  review: 'Review',
  deferred: 'Deferred',
  cancelled: 'Cancelled',
  blocked: 'Blocked',
}

function StatusDot({ status }: { status: TaskStatus }) {
  return <span className={`tm-dot tm-dot--${status}`} title={STATUS_LABEL[status]} />
}

function subtaskProgress(task: Task): { done: number; total: number } {
  const total = task.subtasks.length
  const done = task.subtasks.filter((s) => s.status === 'done' || s.status === 'cancelled').length
  return { done, total }
}

function TaskCard({ task, onClick }: { task: Task; onClick: () => void }) {
  const { done, total } = subtaskProgress(task)
  return (
    <button className="tm-card" onClick={onClick} type="button">
      <div className="tm-card__head">
        <StatusDot status={task.status} />
        <span className="tm-card__id">#{task.id}</span>
        {task.priority && <span className={`tm-prio tm-prio--${task.priority}`}>{task.priority}</span>}
      </div>
      <div className="tm-card__title">{task.title}</div>
      <div className="tm-card__meta">
        {total > 0 && (
          <span className="tm-chip" title="subtasks done / total">
            {done}/{total} subtasks
          </span>
        )}
        {task.dependencies.length > 0 && (
          <span className="tm-chip" title="depends on">
            deps: {task.dependencies.map((d) => `#${d}`).join(', ')}
          </span>
        )}
      </div>
    </button>
  )
}

function TaskDetail({ task, onClose }: { task: Task; onClose: () => void }) {
  const [agentBusy, setAgentBusy] = useState(false)
  const refs = useMemo(() => fileRefsForTask(task), [task])

  const openFile = useCallback((path: string, line?: number) => {
    void cate?.editor.openFile(path, line !== undefined ? { line } : undefined)
  }, [])

  const sendToAgent = useCallback(async () => {
    if (!cate?.agent || agentBusy) return
    setAgentBusy(true)
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
        notify(`Agent: ${result.error}`, 'error')
      } else {
        notify('Agent finished working on this task', 'info')
      }
    } catch (err) {
      notify(`Agent failed: ${err instanceof Error ? err.message : String(err)}`, 'error')
    } finally {
      setAgentBusy(false)
    }
  }, [task, agentBusy])

  return (
    <div className="tm-drawer" role="dialog" aria-label={`Task ${task.id}`}>
      <div className="tm-drawer__head">
        <div className="tm-drawer__title">
          <StatusDot status={task.status} />
          <span className="tm-card__id">#{task.id}</span>
          <span>{task.title}</span>
        </div>
        <button className="tm-iconbtn" onClick={onClose} type="button" aria-label="Close">
          ×
        </button>
      </div>

      <div className="tm-drawer__body">
        <span className={`tm-statuspill tm-dot--${task.status}`}>{STATUS_LABEL[task.status]}</span>
        {task.priority && <span className="tm-chip">priority: {task.priority}</span>}

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
            <pre className="tm-pre">{task.details}</pre>
          </section>
        )}

        {task.testStrategy && (
          <section>
            <h4>Test Strategy</h4>
            <pre className="tm-pre">{task.testStrategy}</pre>
          </section>
        )}

        {task.subtasks.length > 0 && (
          <section>
            <h4>Subtasks ({task.subtasks.length})</h4>
            <ul className="tm-subs">
              {task.subtasks.map((s) => (
                <li key={s.id}>
                  <StatusDot status={s.status} />
                  <span className="tm-sub__id">{task.id}.{s.id}</span>
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

      <div className="tm-drawer__foot">
        {cate?.agent && (
          <button className="tm-btn tm-btn--primary" onClick={sendToAgent} disabled={agentBusy} type="button">
            {agentBusy ? 'Agent running…' : 'Send to agent'}
          </button>
        )}
      </div>
    </div>
  )
}

// --- empty / loading states --------------------------------------------------

function EmptyState({ path }: { path: string | null }) {
  return (
    <div className="tm-empty">
      <h3>No Task Master tasks here yet</h3>
      <p>
        This project doesn’t have a Task Master task file. Initialize Task Master in the project root and
        generate tasks, e.g.:
      </p>
      <pre className="tm-pre">{`task-master init\ntask-master parse-prd .taskmaster/docs/prd.txt`}</pre>
      {path && (
        <p className="tm-muted">
          Looking for: <code>{path}</code>
        </p>
      )}
    </div>
  )
}

// --- root --------------------------------------------------------------------

function App() {
  const [theme, setTheme] = useState<ThemeType>('dark')
  const [board, setBoard] = useState<Board | null>(null)
  const [tag, setTag] = useState<string | undefined>(undefined)
  const [path, setPath] = useState<string | null>(null)
  const [initialized, setInitialized] = useState<boolean | null>(null)
  const [error, setError] = useState<string | undefined>(undefined)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const lastMtime = useRef<number | null>(null)

  // Boot: theme + persisted tag selection.
  useEffect(() => {
    let alive = true
    void (async () => {
      const [t, savedTag] = await Promise.all([readThemeType(), readSelectedTag()])
      if (!alive) return
      setTheme(t)
      if (savedTag) setTag(savedTag)
    })()
    return () => {
      alive = false
    }
  }, [])

  const load = useCallback(async () => {
    try {
      const res = await fetchBoard()
      // Skip a redundant re-render when nothing on disk changed.
      if (res.mtime !== null && res.mtime === lastMtime.current && board) return
      lastMtime.current = res.mtime
      setInitialized(res.initialized)
      setPath(res.path)
      setError(res.error)
      setBoard(res.board)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Initial load + polling for live refresh.
  useEffect(() => {
    void load()
    const id = setInterval(() => void load(), POLL_MS)
    return () => clearInterval(id)
  }, [load])

  const activeTag = tag ?? board?.defaultTag
  const tasks = useMemo(() => (board ? tasksForTag(board, activeTag) : []), [board, activeTag])
  const grouped = useMemo(() => groupByColumn(tasks), [tasks])
  const selected = useMemo(
    () => (selectedId !== null ? tasks.find((t) => t.id === selectedId) ?? null : null),
    [tasks, selectedId],
  )

  const onSelectTag = useCallback((next: string) => {
    setTag(next)
    persistSelectedTag(next)
    setSelectedId(null)
  }, [])

  if (initialized === null && !board) {
    return <div className={`tm-app tm-${theme} tm-center`}>Loading…</div>
  }
  if (initialized === false || (board === null && !error)) {
    return (
      <div className={`tm-app tm-${theme}`}>
        <EmptyState path={path} />
      </div>
    )
  }

  return (
    <div className={`tm-app tm-${theme}`}>
      <header className="tm-topbar">
        <span className="tm-topbar__title">Task Master</span>
        {board && board.tags.length > 1 && (
          <select
            className="tm-tagselect"
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
        <span className="tm-topbar__count">{tasks.length} tasks</span>
      </header>

      {error && <div className="tm-banner tm-banner--error">Couldn’t read tasks: {error}</div>}
      {board && tasks.length === 0 && !error && (
        <div className="tm-banner">This tag has no tasks.</div>
      )}

      <div className="tm-board">
        {COLUMNS.map((col) => (
          <div className="tm-col" key={col.id}>
            <div className="tm-col__head">
              {col.label}
              <span className="tm-col__count">{grouped[col.id]?.length ?? 0}</span>
            </div>
            <div className="tm-col__body">
              {(grouped[col.id] ?? []).map((task) => (
                <TaskCard key={task.id} task={task} onClick={() => setSelectedId(task.id)} />
              ))}
            </div>
          </div>
        ))}
      </div>

      {selected && <TaskDetail task={selected} onClose={() => setSelectedId(null)} />}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
