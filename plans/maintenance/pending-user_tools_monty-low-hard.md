# Monty sandbox + agent-authored tools (v2)

## Goal

Follow-up to `user_tools_backend`: run tool code in Pydantic Monty instead
of in-process, AND/OR let the LLM author tools itself. Monty is the right
primitive for LLM-authored code specifically — in-process exec is fine for
user-authored tools (the user wrote it), but the moment the *model* writes
tools, they need a sandbox.

Research: `docs/research/user-tools-monty.md` — v1.6.0, subprocess pool,
`AsyncMonty`/`feed_run`, memory/time limits, bundled stdlib only, NO
network/fs/third-party imports without host functions.

## Why deferred

- User-authored tools need real imports (`httpx`, `pandas`) — Monty's
  stdlib-only subset breaks them. Host functions can bridge network but
  that's curated plumbing per tool.
- `pydantic-monty` isn't installed — `uv add pydantic-monty` or enable the
  `pydantic-ai-harness[code-mode]` extra.
- Harness `code_mode/` (`CodeMode` capability, `CodeModeToolset`,
  `_monty_exec.py` `MontyRunState`) is a working template when we're ready.

## Sketch

- Per-tool `execution_mode: 'in_process' | 'monty'` on `UserToolSpec`,
  default `in_process`; Monty tools get schema via host-side `ast` parse
  (sandbox signatures aren't introspectable) — the v1 catalog already
  ast-parses, so reuse.
- Agent authoring: the harness `capability_creation` package ships
  `CapabilityCreation` (`author_capability` tool) + `CapabilityStore`
  (`<name>.py` + `manifest.json`, validated exec) — wire it gated by an
  operator-authority check (`_capability.py:124-143`) and route generated
  code through Monty, not exec.
- `data-resume`/approval integration stays identical — tool call is a tool
  call regardless of executor.

## Open questions

- Host-function surface for Monty tools: `http_get`-style curated helpers,
  workspace-mounts (`MountDir`), or none?
- Does agent-authored code need `type_check=True` (embedded `ty`) before
  save? Probably yes — better error feedback than a runtime surprise.
