# References — working implementations from the predecessor app

These files are **examples, not contracts**. They were copied verbatim from
the proven app these plans re-spec, and exist so implementors don't have to
re-derive fiddly library interop from docs: AI SDK `Chat`/transport
overrides, pydantic-ai's `VercelAIAdapter`/`ConversationStore` ABCs, harness
capability assembly, and Electron sidecar supervision.

Rules:

- **The spec is the contract.** `plans/` + `specs/` define what app #2 must
  do; references show one working way it was done. Where they disagree,
  the spec wins — deliberate app #2 differences (Monaco, provider cuts,
  true multi-buffer editing) are not implemented by these examples.
- **Not runnable.** Imports point at modules that don't exist in the new
  repo (`lib/api`, sibling stores, `app.agent.models`, …). Read, don't copy.
- **Read alongside the spec that cites them** — each file answers "how did
  this actually look when it worked," not "what should I build."

Known deviations from the app #2 target: persistence examples use separate
`plans.db`/`steps.db` files instead of consolidated `app.db`; failed-run
comments in `messages.ts` are stale (failed/interrupted turns are persisted,
and retry branches/replaces that tail); the run-meta example emits only the
initial settings envelope, while app #2 adds usage, cost, and `run_id`.

| File | Demonstrates | Cited by |
|---|---|---|
| `transport.ts` | `DefaultChatTransport` subclass — `prepareSendMessagesRequest` slicing, `reconnectToStream` method override vs `prepareReconnectToStreamRequest`, bearer, one-shot resume arming | `specs/vercel-ai-sdk.md`, P1-chat-core |
| `messages.ts` | `newTurnMessages` tail-slice + edit/retry/regenerate trigger semantics (the quadratic-growth bug comment is worth reading) | P1-chat-core |
| `chats-store.ts` | Non-reactive `Map<chatId, Chat>` registry, hydration-once, `resumeStream`, stop/resume wiring | P1-chat-core |
| `data-parts.ts` | Boundary validation of `data-*` parts; unknown/malformed → ignore never throw; latest-plan-snapshot rule | P1-chat-core |
| `sidecar.ts` | uvicorn spawn on ephemeral port, bearer via env, `/health` poll, restart backoff, env scrub, cross-platform process-group kill (`taskkill`) | P1-foundation |
| `chat-api.py` | `AppVercelAIAdapter.dispatch_request` wiring — `conversation_store`/`scope`, `deferred_tool_results`, `CancellationToken`, server-side history cut/branch on resubmit, failed-run save; persisted-response replay and 404 semantics | P1-chat-core, P1-persistence |
| `resume-api.py` | Interrupted-run status/continuation via `SqliteStepStore` snapshots + `agent.run_stream_events`; approval/active-run blockers and unknown-effect warnings | P1-chat-core, P1-agent-backend |
| `events-bridge.py` | `agent.on_event` → `CustomEvent` → `data-plan`/`data-shell`/`data-run-meta`; stream-only (never persisted) | P1-agent-backend, `specs/pydantic-ai-harness.md` |
| `agent-factory.py` | Per-run capability list, `ProfileFilter` via `get_wrapper_toolset`/`FilteredToolset`, profile→`Permissions` mapping, `visit_and_replace` allow/deny injection, judge resolution | P1-agent-backend |
| `conversation-store.py` | `ConversationStore` ABC impl over per-`ModelMessage` rows — `load`/`save`/`branch`/`fork`, content-comparison branching, scope isolation | P1-persistence |
| `profiles.py` | Effective-profile resolution chain (chat → workspace → global → default), `ensure_system_skills` bundled-skill seeding, tool/skill catalog endpoints | P1-agent-backend, P1-settings-registry |
| `MessagePart.tsx` | Streamdown rehype-chain customization: `file` added to sanitize protocols + `FileAwareLink` click interception — the `file:` link gotcha, worked | P1-chat-core |
| `electron.vite.config.ts` | electron-vite 3-target config, `externalizeDepsPlugin` + shared-workspace-pkg bundling gotcha | P1-foundation |
| `electron-builder.yml` | Packaging config — `extraResources` backend bundling, `--dir`-only v1, naming gotchas | P1-foundation |
| `vitest.config.mts`, `test-setup.ts` | Node+dom project config; jsdom gaps + `window.api` preload stub | P1-foundation |
| `research/` | Two verified research notes: `conversation-durability.md` (the SDK↔adapter wire contract, verified against installed versions) and `tool-profiles-and-skills.md` (profile → toolset/skill mapping with source citations) | P1-chat-core, P1-agent-backend |

Refresh note: these are snapshots of app #1 at blueprint time. They don't
track later app-#1 changes — and don't need to; they're illustrations.
