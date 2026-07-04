import { useEffect, useRef, useState } from 'react'
import {
  api,
  formatDuration,
  type AiChange,
  type AiMessage,
} from '../api/client'
import { describeCommand, type EditorCommand } from '../editor/commands'

interface Props {
  projectId: string
  hasTranscript: boolean
  onApplied: () => void
  // When shown in the detached agent window, the header offers an "Attach"
  // button that docks the panel back into the main editor.
  detached?: boolean
  onAttach?: () => void
  // Called when the AI proposes structured editor commands (the shared action
  // layer). In the detached window these are relayed to the main editor.
  onCommands?: (cmds: EditorCommand[]) => void
}

export function AiChat({
  projectId,
  hasTranscript,
  onApplied,
  detached,
  onAttach,
  onCommands,
}: Props) {
  const [messages, setMessages] = useState<AiMessage[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [applyingId, setApplyingId] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    api
      .getMessages(projectId)
      .then(setMessages)
      .catch(() => {})
  }, [projectId])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages, busy])

  const send = async () => {
    const text = input.trim()
    if (!text || busy) return
    setBusy(true)
    setError(null)
    // Optimistically show the user's message.
    setMessages((m) => [
      ...m,
      {
        id: `tmp-${Date.now()}`,
        role: 'user',
        content: text,
        change: null,
        change_status: null,
        created_at: new Date().toISOString(),
      },
    ])
    setInput('')
    try {
      const created = await api.sendMessage(projectId, text)
      // Replace optimistic list by reloading the authoritative history.
      const full = await api.getMessages(projectId)
      setMessages(full)
      void created
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to send')
      const full = await api.getMessages(projectId).catch(() => messages)
      setMessages(full)
    } finally {
      setBusy(false)
    }
  }

  const apply = async (messageId: string, change: AiChange) => {
    setApplyingId(messageId)
    setError(null)
    try {
      if (change.type === 'commands' && Array.isArray(change.commands)) {
        // Structured edits go straight through the shared action layer (the
        // main editor runs them as normal, undoable commands).
        onCommands?.(change.commands as EditorCommand[])
      } else {
        // Cut plans are versioned by the backend; the editor then reloads.
        await api.applyChange(projectId, messageId)
      }
      setMessages(await api.getMessages(projectId))
      onApplied()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to apply')
    } finally {
      setApplyingId(null)
    }
  }

  return (
    <div className="ai-chat">
      <div className="ai-head">
        <div>
          <h3>AI edit</h3>
          <span className="subtitle-sm">Ask for cuts and edits</span>
        </div>
        {detached && (
          <button className="btn small" title="Dock back into the editor" onClick={onAttach}>
            ⤓ Attach
          </button>
        )}
      </div>

      <div className="ai-messages" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="empty-hint">
            {hasTranscript
              ? 'Try: “Tighten this video and remove filler.”'
              : 'Transcribe the video first, then ask the AI to edit it.'}
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`bubble ${m.role}`}>
            <div className="bubble-text">{m.content}</div>
            {m.change && (
              <ChangeCard
                change={m.change}
                status={m.change_status}
                applying={applyingId === m.id}
                onApply={() => apply(m.id, m.change!)}
              />
            )}
          </div>
        ))}
        {busy && <div className="bubble assistant thinking">Thinking…</div>}
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="ai-input">
        <textarea
          value={input}
          disabled={!hasTranscript || busy}
          placeholder={
            hasTranscript ? 'Message the AI editor…' : 'Transcribe first'
          }
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
        />
        <button
          className="btn primary"
          onClick={send}
          disabled={!hasTranscript || busy || !input.trim()}
        >
          Send
        </button>
      </div>
    </div>
  )
}

function ChangeCard({
  change,
  status,
  applying,
  onApply,
}: {
  change: AiChange
  status: AiMessage['change_status']
  applying: boolean
  onApply: () => void
}) {
  const isCommands = change.type === 'commands' && Array.isArray(change.commands)
  const commands = (change.commands ?? []) as EditorCommand[]
  const keep = change.keep ?? []
  const kept = keep.reduce((sum, k) => sum + (k.end - k.start), 0)
  return (
    <div className="change-card">
      {isCommands ? (
        <>
          <div className="change-head">
            Proposed edit · {commands.length} action
            {commands.length === 1 ? '' : 's'}
          </div>
          <div className="change-list">
            {commands.map((c, i) => (
              <div className="change-row" key={i}>
                <span className="seg-text">{describeCommand(c)}</span>
              </div>
            ))}
          </div>
        </>
      ) : (
        <>
          <div className="change-head">
            Proposed cut plan · keep {keep.length} section
            {keep.length === 1 ? '' : 's'} ({formatDuration(kept)})
          </div>
          <div className="change-list">
            {keep.map((k, i) => (
              <div className="change-row" key={i}>
                <span className="seg-time">
                  {formatDuration(k.start)}–{formatDuration(k.end)}
                </span>
                <span className="seg-text">{k.label || k.reason || 'keep'}</span>
              </div>
            ))}
          </div>
        </>
      )}
      {status === 'applied' ? (
        <div className="change-applied">✓ Applied to timeline</div>
      ) : (
        <button className="btn primary small" onClick={onApply} disabled={applying}>
          {applying ? 'Applying…' : isCommands ? 'Apply edit' : 'Apply cuts'}
        </button>
      )}
    </div>
  )
}
