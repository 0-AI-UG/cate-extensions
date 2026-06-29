// =============================================================================
// ServiceConnection — shared gating UI for extensions that wrap an external
// service (mcphub provisions one; sourcebot/deepwiki connect to a user-run
// instance). It owns one honest state machine and renders a coherent
// connection card over a content area the consumer fills once ready:
//
//   idle ─▶ provisioning ─▶ ready            (run-for-me: mcphub)
//                └─▶ error ◀─ retry
//   needs-connection ─▶ connecting ─▶ ready  (connect-to-existing: sourcebot/deepwiki)
//                          └─▶ error ─▶ (edit / retry)
//
// The consumer drives transitions by calling setState(...); the widget fires
// callbacks for user actions (onSubmit, onDisconnect, onRetry) and calls
// onReady(mount) exactly once when first ready so the consumer can attach its
// iframe or native UI. Vanilla + CSP-safe (textContent only, no innerHTML).
// =============================================================================

export type ConnState =
  | { kind: 'idle' }
  | { kind: 'provisioning'; message?: string; log?: string }
  | { kind: 'connecting'; message?: string }
  | { kind: 'needs-connection'; baseUrl?: string; apiKey?: string; message?: string }
  | { kind: 'ready' }
  | { kind: 'error'; message: string; detail?: string; canRetry?: boolean }

export interface ConnectConfig {
  urlLabel?: string
  urlPlaceholder?: string
  apiKey?: boolean
  apiKeyLabel?: string
  help?: string
  onSubmit: (values: { url: string; apiKey?: string }) => void | Promise<void>
  onDisconnect?: () => void | Promise<void>
}

export interface ServiceConnectionOptions {
  serviceName: string
  /** Raw SVG markup for the panel glyph, shown above the name (e.g. the
   *  manifest panel icon). Parsed safely — no scripts run. */
  icon?: string
  /** Shown only inside the collapsed "How to run it?" expander, never inline. */
  description?: string
  /** Present for URL-based "connect to existing" services. */
  connect?: ConnectConfig
  /** Present for provisioned services that can be (re)started. */
  onRetry?: () => void | Promise<void>
  /** Called once, the first time the widget enters `ready`. */
  onReady?: (mount: HTMLElement) => void
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text != null) node.textContent = text
  return node
}

/** Parse trusted SVG markup into a node without innerHTML (CSP-safe). Returns
 *  null if the markup doesn't parse to an <svg>. */
function iconNode(svg: string): SVGElement | null {
  try {
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
    const root = doc.documentElement
    if (!root || root.nodeName.toLowerCase() !== 'svg') return null
    return document.importNode(root, true) as unknown as SVGElement
  } catch {
    return null
  }
}

export class ServiceConnection {
  /** Mount point for the consumer's iframe / native UI. */
  readonly content: HTMLElement

  private readonly opts: ServiceConnectionOptions
  private readonly overlay: HTMLElement
  private readonly card: HTMLElement
  private readyFired = false

  constructor(root: HTMLElement, opts: ServiceConnectionOptions) {
    this.opts = opts

    const wrap = el('div', 'cate-conn')
    this.content = el('div', 'cate-conn__content')
    this.overlay = el('div', 'cate-conn__overlay')
    this.card = el('div', 'cate-conn__card')
    this.overlay.appendChild(this.card)
    wrap.appendChild(this.content)
    wrap.appendChild(this.overlay)
    root.appendChild(wrap)

    this.setState({ kind: 'idle' })
  }

  setState(state: ConnState): void {
    if (state.kind === 'ready') {
      this.overlay.hidden = true
      if (!this.readyFired) {
        this.readyFired = true
        this.opts.onReady?.(this.content)
      }
      return
    }
    this.overlay.hidden = false
    this.card.replaceChildren()
    switch (state.kind) {
      case 'idle':
      case 'provisioning':
        this.renderBusy(
          state.kind === 'provisioning' && state.message
            ? state.message
            : `Starting ${this.opts.serviceName}…`,
          state.kind === 'provisioning' ? state.log : undefined,
        )
        break
      case 'connecting':
        this.renderBusy(state.message || `Connecting to ${this.opts.serviceName}…`)
        break
      case 'needs-connection':
        this.renderConnectForm(state)
        break
      case 'error':
        this.renderError(state)
        break
    }
  }

  // --- renderers -----------------------------------------------------------

  private renderHead(): void {
    if (this.opts.icon) {
      const node = iconNode(this.opts.icon)
      if (node) {
        const glyph = el('div', 'cate-conn__icon')
        glyph.appendChild(node)
        this.card.appendChild(glyph)
      }
    }
    this.card.appendChild(el('div', 'cate-conn__title', this.opts.serviceName))
  }

  /** A collapsed "How to run it?" expander carrying the description + help, so
   *  the default view stays minimal but the prose is one click away. */
  private renderHelp(extra?: string): void {
    const parts = [this.opts.description, extra].filter(
      (p): p is string => !!p && !!p.trim(),
    )
    if (!parts.length) return
    const details = el('details', 'cate-conn__help')
    details.appendChild(el('summary', undefined, 'How to run it?'))
    for (const p of parts) details.appendChild(el('p', 'cate-conn__desc', p))
    this.card.appendChild(details)
  }

  private renderBusy(message: string, log?: string): void {
    this.renderHead()
    const row = el('div', 'cate-conn__row')
    row.appendChild(el('div', 'cate-spinner'))
    row.appendChild(el('p', 'cate-conn__msg', message))
    this.card.appendChild(row)
    if (log && log.trim()) {
      this.card.appendChild(el('pre', 'cate-pre cate-conn__log', log))
    }
  }

  private renderError(state: Extract<ConnState, { kind: 'error' }>): void {
    this.renderHead()
    this.card.appendChild(el('p', 'cate-conn__msg cate-conn__msg--error', state.message))
    if (state.detail && state.detail.trim()) {
      this.card.appendChild(el('pre', 'cate-pre cate-conn__log', state.detail))
    }
    const actions = el('div', 'cate-conn__actions')
    if (state.canRetry !== false && (this.opts.onRetry || this.opts.connect)) {
      const retry = el('button', 'cate-btn cate-btn--primary', 'Retry')
      retry.addEventListener('click', () => {
        if (this.opts.onRetry) void this.opts.onRetry()
        else this.setState({ kind: 'needs-connection' })
      })
      actions.appendChild(retry)
    }
    if (this.opts.connect) {
      const edit = el('button', 'cate-btn', 'Edit connection')
      edit.addEventListener('click', () => this.setState({ kind: 'needs-connection' }))
      actions.appendChild(edit)
    }
    if (actions.childElementCount) this.card.appendChild(actions)
  }

  private renderConnectForm(state: Extract<ConnState, { kind: 'needs-connection' }>): void {
    const cfg = this.opts.connect
    this.renderHead()
    if (!cfg) {
      // No connect config but somehow here: degrade to a busy card.
      this.renderBusy(`Waiting for ${this.opts.serviceName}…`)
      return
    }
    if (state.message) {
      this.card.appendChild(el('p', 'cate-conn__msg cate-conn__msg--error', state.message))
    }

    // The form is the whole interface: an inline [url] [connect] row, plus an
    // optional key row. Submitting on Enter works via the native form submit.
    const form = el('form', 'cate-conn__form')
    const inline = el('div', 'cate-conn__inline')
    const urlInput = el('input', 'cate-input') as HTMLInputElement
    urlInput.type = 'url'
    urlInput.placeholder = cfg.urlPlaceholder || 'https://localhost:3000'
    urlInput.setAttribute('aria-label', cfg.urlLabel || 'Instance URL')
    urlInput.value = state.baseUrl || ''
    inline.appendChild(urlInput)
    const submit = el('button', 'cate-btn cate-btn--primary', 'connect') as HTMLButtonElement
    submit.type = 'submit'
    inline.appendChild(submit)
    form.appendChild(inline)

    let keyInput: HTMLInputElement | null = null
    if (cfg.apiKey) {
      keyInput = el('input', 'cate-input cate-conn__keyrow') as HTMLInputElement
      keyInput.type = 'password'
      keyInput.placeholder = cfg.apiKeyLabel || 'API key (optional)'
      keyInput.setAttribute('aria-label', cfg.apiKeyLabel || 'API key (optional)')
      keyInput.value = state.apiKey || ''
      form.appendChild(keyInput)
    }

    if (cfg.onDisconnect && state.baseUrl) {
      const disconnect = el('button', 'cate-btn cate-btn--ghost cate-conn__disconnect', 'Disconnect')
      disconnect.type = 'button'
      disconnect.addEventListener('click', () => void cfg.onDisconnect?.())
      form.appendChild(disconnect)
    }

    form.addEventListener('submit', (e) => {
      e.preventDefault()
      const url = urlInput.value.trim()
      if (!url) {
        urlInput.focus()
        return
      }
      void cfg.onSubmit({ url, apiKey: keyInput?.value.trim() || undefined })
    })
    this.card.appendChild(form)

    this.renderHelp(cfg.help)
  }
}
