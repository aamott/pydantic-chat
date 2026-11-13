/**
 * Pure rules behind the "Working… Ns" dead-air indicator.
 *
 * Free-tier / thinking models can sit silent for minutes after the stream
 * emits `start` — the transcript shows a bare "…" and reads as hung.
 * While a run is live (`submitted`/`streaming`) and its tail assistant
 * message has produced nothing that renders, MessageList shows a ticking
 * elapsed line instead.
 *
 * Design choice (see plans/maintenance story): the indicator is REPLACED
 * by normal content on the first rendered part — it does not keep a timer
 * alive alongside tool calls. Tool-call phases already render ToolCards
 * with live state badges ("calling…"), and reasoning renders a "Thinking…"
 * collapsible, so a second timer there would duplicate an existing
 * liveness signal. `step-start` (renders only an <hr>) and hidden stream
 * parts (`data-run-meta`, `data-shell` — see `transcriptParts`) don't
 * count as output.
 */
import type { ChatStatus, UIMessage } from 'ai'
import { transcriptParts } from './dataParts'

/**
 * Elapsed time for the indicator: `"12s"` under a minute, `"m:ss"` after.
 * Sub-second remainders floor; negative input (clock skew) clamps to 0.
 */
export function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000))
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

/**
 * Has the current run's tail assistant message produced anything the
 * transcript renders as content?
 *
 * Only the LAST message is examined: a previous turn's completed reply
 * must not suppress the indicator while a new run is still silent.
 */
export function runHasVisibleOutput(messages: UIMessage[]): boolean {
  const last = messages[messages.length - 1]
  if (!last || last.role !== 'assistant') return false
  return transcriptParts(last.parts).some((part) => {
    // A step boundary renders only an <hr> — no liveness signal.
    if (part.type === 'step-start') return false
    // An empty text placeholder renders nothing yet.
    if (part.type === 'text') return part.text.length > 0
    // Everything else (reasoning "Thinking…", tool cards, plan card,
    // files, chips) is rendered content — the run isn't dead air.
    return true
  })
}

/**
 * Show the indicator while a run is live but has produced no visible
 * output. `ready`/`error`/stop always hide it, so it also resets cleanly
 * between runs (the component unmounts and its clock restarts).
 */
export function showWorkingIndicator(
  status: ChatStatus,
  messages: UIMessage[],
): boolean {
  const busy = status === 'submitted' || status === 'streaming'
  return busy && !runHasVisibleOutput(messages)
}
