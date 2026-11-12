# Message rendering

## Goal

Chat messages render correctly, including streaming text, tool calls, reasoning, and custom agent events.

## Acceptance criteria

- Streamdown renders text parts (streaming-safe markdown, code highlighting, GFM)
- Part-switch component: `tool-*` → tool card (name, args, status, result), `reasoning` → collapsible trace, `data-*` → registered custom renderers (plan card, shell output)
- Copied shadcn AI Elements patterns (conversation/message/prompt-input/tool) as base components
- Custom `<a>` renderer intercepts `file:` links (wired to panel in P1-right-panel story)
- Empty/error/streaming states handled

## Files
- `apps/desktop/src/renderer/src/features/chat/{MessageList,MessagePart}.tsx`, `components/ui/`

## Depends on
- pending-chat_client-high-med.md

## Implementation notes (2026-11-12)

- `features/chat/MessagePart.tsx` — part-switch over the installed
  `ai@7.0.162` `UIMessagePart` union: `text` → `Streamdown` (`mode="streaming"`,
  `isAnimating` off `part.state`), `reasoning` → collapsible muted trace,
  `isToolUIPart()` (all `tool-*` + `dynamic-tool`) → collapsible tool card
  (name, state badge incl. `approval-requested`/`output-denied`, input,
  output truncated at 50 lines, errorText), `isDataUIPart()` →
  `DATA_RENDERERS` name-keyed registry with generic JSON-card fallback
  (plan/shell cards register here later), `file`/`source-url`/
  `source-document`/`reasoning-file`/`step-start`/`custom` → minimal
  chips/divider, unknown parts → JSON fallback.
- **Approval parts:** `tool-approval-request`/`…-response` are stream
  *chunk* types, not `UIMessagePart`s — the SDK folds them into tool-part
  `approval-requested`/`approval-responded`/`output-denied` states, which
  the generic tool card already badgers. Dedicated approve/deny UI is the
  P1-agent-harness story.
- `features/chat/MessageList.tsx` — user bubbles right / assistant parts
  left; stick-to-bottom auto-scroll that releases on user scroll-up;
  empty + `submitted` ("Waiting for response…") states. Error state lives
  in `ChatPanel`'s `ChatError` banner.
- **shadcn AI Elements — deliberate deviation:** repo has no shadcn
  install and the task forbade new deps; `Collapsible`/`Chip`/`KeyValue`
  are hand-rolled Tailwind components following the same visual patterns.
- **`file:` links:** custom Streamdown `a` renderer intercepts
  `file:path` / `file:path:line` hrefs → `useUiStore.openFile(path, line)`
  (opens right panel File tab). Other links open externally.
- Not visually verified against a live stream — no model key configured;
  tsc strict + `electron-vite build` clean.
