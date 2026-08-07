// Cross-window bridge between the main editor window and the detached AI agent
// window.
//
// Design: the MAIN editor window owns the single source of truth (the timeline
// + undo history in useEditor). The AGENT window holds no editor state — it is
// a thin remote that sends messages back to the main window:
//   - { kind: 'command', command }  → main runs it through editor.run (undoable,
//                                      exactly the same path as the toolbar).
//   - { kind: 'reload' }            → main reloads after the agent applied a
//                                      backend change (e.g. an AI cut plan).
// Because only the main window mutates state, the two windows behave as one
// workspace with nothing to reconcile.
//
// Transport differs by host:
//   - Desktop (pywebview): separate native windows do NOT share a JS context or
//     a BroadcastChannel, so we relay through Python. The agent window calls
//     `window.pywebview.api.dispatch_to_editor(json)`; Python calls
//     `window.__agentDispatch(json)` in the main window.
//   - Plain browser: a real popup window shares the origin, so a BroadcastChannel
//     carries messages directly between the two windows.

import type { EditorCommand } from './commands'

export type AgentMessage =
  | { kind: 'command'; command: EditorCommand }
  | { kind: 'reload' }

const CHANNEL = 'shelfedit-agent'

function bridgeApi() {
  return window.pywebview?.api ?? null
}

// --- Window identity --------------------------------------------------------

export function isAgentView(): boolean {
  return new URLSearchParams(window.location.search).get('view') === 'agent'
}

export function agentProjectId(): string | null {
  return new URLSearchParams(window.location.search).get('project')
}

// --- Main editor window: open / close the agent window ----------------------

// Handle to the browser popup (only used in a plain browser, not on desktop).
let popup: Window | null = null

// Returns true if a separate window was opened; false if a browser popup was
// blocked (caller should fall back to an in-app floating panel).
export function openAgentWindow(projectId: string): boolean {
  const api = bridgeApi()
  if (api?.open_agent_window) {
    void api.open_agent_window(projectId)
    return true
  }
  const url = `${location.pathname}?view=agent&project=${encodeURIComponent(projectId)}`
  popup = window.open(url, 'shelfedit-agent', 'width=460,height=820')
  if (popup) {
    try {
      popup.focus()
    } catch {
      /* cross-origin focus can throw; ignore */
    }
    return true
  }
  return false
}

export function closeAgentWindow(): void {
  const api = bridgeApi()
  if (api?.close_agent_window) {
    void api.close_agent_window()
    return
  }
  popup?.close()
  popup = null
}

// Main window registers this to receive messages from the agent window.
export function onAgentMessage(handler: (msg: AgentMessage) => void): () => void {
  // Desktop relay: Python calls this global in the main window.
  window.__agentDispatch = (json: string) => {
    try {
      handler(JSON.parse(json) as AgentMessage)
    } catch {
      /* ignore malformed relay payloads */
    }
  }
  // Browser: messages posted by the popup arrive here.
  let bc: BroadcastChannel | null = null
  if ('BroadcastChannel' in window) {
    bc = new BroadcastChannel(CHANNEL)
    bc.onmessage = (e) => handler(e.data as AgentMessage)
  }
  return () => {
    if (window.__agentDispatch) delete window.__agentDispatch
    bc?.close()
  }
}

// Main window: learn when the agent window is closed (so it can re-attach the
// docked panel). Desktop calls the global; browser polls the popup handle.
export function onAgentWindowClosed(handler: () => void): () => void {
  window.__agentClosed = () => handler()
  const timer = window.setInterval(() => {
    if (popup && popup.closed) {
      popup = null
      handler()
    }
  }, 700)
  return () => {
    if (window.__agentClosed) delete window.__agentClosed
    window.clearInterval(timer)
  }
}

// --- Agent window: send messages back to the main editor --------------------

let agentChannel: BroadcastChannel | null = null

export function sendToEditor(msg: AgentMessage): void {
  const api = bridgeApi()
  if (api?.dispatch_to_editor) {
    void api.dispatch_to_editor(JSON.stringify(msg))
    return
  }
  if ('BroadcastChannel' in window) {
    if (!agentChannel) agentChannel = new BroadcastChannel(CHANNEL)
    agentChannel.postMessage(msg)
  }
}

// Agent window: ask the host to re-attach (close this window).
export function requestAttach(): void {
  const api = bridgeApi()
  if (api?.close_agent_window) {
    void api.close_agent_window()
    return
  }
  window.close()
}
