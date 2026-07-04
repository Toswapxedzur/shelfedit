import { useEffect, useState } from 'react'
import '../styles/app.css'
import { api } from '../api/client'
import { AiChat } from './AiChat'
import { agentProjectId, requestAttach, sendToEditor } from '../editor/agentBridge'

/**
 * The detached AI agent, rendered as its own OS window (native pywebview window
 * on desktop, or a browser popup). It holds no editor state: every edit it
 * produces is relayed to the main editor window, which is the single source of
 * truth. That is what lets the two windows behave as one workspace.
 */
export function AgentWindow() {
  const projectId = agentProjectId()
  const [hasTranscript, setHasTranscript] = useState(false)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (!projectId) {
      setReady(true)
      return
    }
    api
      .getTranscript(projectId)
      .then(() => setHasTranscript(true))
      .catch(() => setHasTranscript(false))
      .finally(() => setReady(true))
    document.title = 'AI Assistant — Shelf Edit'
  }, [projectId])

  if (!projectId) {
    return <div className="agent-window empty-hint">No project selected.</div>
  }

  return (
    <div className="agent-window">
      {ready ? (
        <AiChat
          projectId={projectId}
          hasTranscript={hasTranscript}
          detached
          onAttach={requestAttach}
          // Cut plans are applied to the backend by AiChat; tell the main
          // editor to reload the new timeline version.
          onApplied={() => sendToEditor({ kind: 'reload' })}
          // Structured edits run through the shared action layer in the main
          // editor (undoable), exactly like the toolbar buttons.
          onCommands={(cmds) =>
            cmds.forEach((command) => sendToEditor({ kind: 'command', command }))
          }
        />
      ) : (
        <div className="editor-loading">Loading…</div>
      )}
    </div>
  )
}
