// Endpoint view: the aggregated MCP endpoint as two definition rows (URL and
// Authorization header, each copyable) and exactly one muted hint line.

import { useState } from 'react'
import type { EndpointInfo } from '../../shared/types'
import { CopyIconButton, EyeIcon, EyeOffIcon } from './util'

export function EndpointView({ endpoint }: { endpoint: EndpointInfo }) {
  const [revealed, setRevealed] = useState(false)
  const masked = endpoint.authHeader.replace(/Bearer .*/, 'Bearer ••••••••')
  return (
    <div className="mcp-view">
      <div className="mcp-def">
        <span className="mcp-def__key">URL</span>
        <span className="mcp-def__value mcp-mono">{endpoint.url}</span>
        <CopyIconButton text={endpoint.url} title="Copy URL" />
      </div>
      <div className="mcp-def">
        <span className="mcp-def__key">Authorization</span>
        <span className="mcp-def__value mcp-mono">{revealed ? endpoint.authHeader : masked}</span>
        <button
          className="cate-iconbtn"
          type="button"
          title={revealed ? 'Hide' : 'Reveal'}
          onClick={() => setRevealed((r) => !r)}
        >
          {revealed ? <EyeOffIcon /> : <EyeIcon />}
        </button>
        <CopyIconButton text={endpoint.authHeader} title="Copy header" />
      </div>
      <div className="mcp-muted" title="Streamable HTTP; every running server's tools, resources and prompts, namespaced <server>__<name>">
        Any MCP client can connect here.
      </div>
    </div>
  )
}
