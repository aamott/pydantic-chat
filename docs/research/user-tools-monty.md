# Pydantic Monty — research for user-defined tools

Sources: pydantic.dev/docs/monty/*, github.com/pydantic/monty, PyPI, and installed
`pydantic_ai_harness==0.68.0` source in `apps/backend/.venv`. Current as of Nov 2026.

## 1. What it is

- Sandboxed Python-subset interpreter written in Rust (Ruff's parser; semantics track
  CPython **3.14**, incl. PEP 649 lazy annotations). Purpose-built for LLM/user-generated code.
- PyPI: `pydantic-monty` is a metapackage → `pydantic-monty-client` (the `pydantic_monty`
  module) + `pydantic-monty-runtime` (the `monty` worker binary, shipped like uv/ruff binaries).
  ~4.5 MB, Python ≥3.10, MIT.
- **Latest: v1.6.0 (2026-11-11); v1.0.0 shipped 2026-09-25** dropping the experimental framing.
  Stable and actively maintained (~3-day release cadence, 8.9k★). Powers Code Mode in Pydantic AI.
  A commercial gRPC server variant exists (`AsyncMontyRemote`).

## 2. Execution model — subprocess pool, NOT in-process

Execution **never** happens in the host process: `Monty()` owns a pool of `monty` worker
subprocesses (adversarial code can crash a worker via memory errors; the pool replaces it and
raises `MontyCrashedError` — host survives).

```python
from pydantic_monty import Monty          # sync pool (blocks thread, GIL released)
from pydantic_monty import AsyncMonty     # asyncio pool — use this in FastAPI
from pydantic_monty import AsyncMontyRemote  # remote gRPC workers

async with AsyncMonty() as pool:                       # Monty(binary_path=...) to pin binary
    async with pool.checkout(limits=...) as session:   # one dedicated worker, REPL session
        result = await session.feed_run(
            'fetch_weather(**kw)',
            inputs={'kw': {'city': 'Paris'}},   # eager globals
            external_lookup={'http_get': fn},   # lazy host functions/values
        )
```

- `feed_run(code, *, inputs, external_lookup, print_callback, mount, cwd, os, skip_type_check)`
  executes a snippet and returns the **trailing expression's value** converted to host objects.
  Sync `feed_run` rejects async host functions — `AsyncMonty` allows `async def` host fns.
- `checkout(script_name, limits, type_check, type_check_stubs, type_check_format,
  os_policy, external_modules)` — per-session config.
- **No `call_function`/`eval`/`run` API in v1**: call a defined function by feeding
  `'name(**kw)'` with `inputs={'kw': args}` (`f(**a, **b)` multi-kwargs is rejected; single is fine).
- REPL state persists across feeds in a session; `session.dump()`/`load_session(bytes)`
  serializes idle state; `feed_start` + `FunctionSnapshot.resume/resume_auto` is the
  snapshot API for handling each host call manually (what harness `_monty_exec.py` uses).
- Errors: `MontySyntaxError`, `MontyTypingError`, `MontyRuntimeError`
  (`.display(format=...)`, `.exception()` → e.g. `TimeoutError`/`MemoryError`, `.traceback()`),
  `MontyCrashedError`, `MontyDisconnectError`.

## 3. Security model

- **No filesystem, no env vars, no network, no clock** unless explicitly handed in via:
  `external_lookup` callables (host functions run with full host authority — validate their args!),
  `os`/`os_policy` handler, `MountDir` mounts (read-only/read-write/overlay), `external_modules`
  (import names → `ExternalModule` dicts + optional .pyi stubs). No `sys.path`/site-packages.
- `checkout(limits={...})`: `max_memory` (bytes, allocator-counted, soft+hard ceiling),
  `max_feed_duration_secs` (execution clock; paused during host calls),
  `max_turn_duration_secs`, `max_recursion_depth` (default 1000),
  `max_suspensions` (default 1000, can't be disabled), `max_total_sleep_secs`, `gc_interval`.
  Trips surface as uncatchable-in-sandbox `MemoryError`/`TimeoutError`/`RuntimeError`
  wrapped in `MontyRuntimeError`. Infinite loop → `max_feed_duration_secs`.
- Caveat for untrusted code: set `request_timeout` on the pool + a feed duration limit;
  a quick-host-call loop resets turn clocks. A memory burst between checkpoints can still
  kill the worker (hard OOM ceiling) — pool replaces it, session lost.
- CodeMode's defaults (good starting point): 30 s feed, 256 MiB, 1000 suspensions,
  100 nested tool calls (`code_mode/_toolset.py:354-386`).

## 4. Typing / schema

- User functions **can** declare annotations (`def fetch_weather(city: str) -> str`).
- `checkout(type_check=True)` runs an embedded **ty**-based static check per snippet →
  `MontyTypingError` with rendered diagnostics (`type_check_format`: full/concise/json/github);
  `type_check_stubs`/`ExternalModule` stubs let the host declare its function signatures so
  user code is checked against them. Static only — no runtime enforcement.
- **Host cannot introspect a sandbox function's signature**: no `inspect` in-sandbox;
  `f.__annotations__` exists but is only reachable by feeding another snippet.
  **Recommended: parse the user's source on the host with stdlib `ast`** (we hold the text)
  to extract params/defaults/annotations/docstring → build the pydantic-ai tool schema
  directly (or generate a host shim `def` with the same signature so pydantic-ai's normal
  `FunctionToolset`/schema machinery works, with the shim body dispatching into Monty).
- Values crossing the boundary both ways: None, bool, int (bigint), float, complex, str,
  bytes, list, tuple, dict, set, frozenset, Decimal, date/datetime/timedelta/timezone,
  named tuples, exception instances. JSON-compatible results come out naturally.

## 5. Practical fit for `def fetch_weather(city: str) -> str`

- Yes: `feed_run(user_source)` to define, `feed_run('fetch_weather(**kw)', inputs={'kw': args})`
  to call, JSON-able result back, `MontyRuntimeError`/`MontySyntaxError` to report failures.
- **But no network**: `fetch_weather` can't actually fetch — `httpx`/`requests`/`urllib` don't
  exist. Real I/O must go through host functions (`external_lookup={'http_get': ...}`),
  an `os` handler, or mounts. Bundled stdlib: `json, re, math, datetime, decimal, statistics,
  random, itertools, functools, collections, dataclasses, csv, base64, binascii, bisect, copy,
  fnmatch, hashlib, os/os.path, pathlib, sys, time, tomllib, typing, unicodedata, annotationlib,
  asyncio` (run/gather/sleep only). No file I/O without mounts (`open()` → `PermissionError`).
- Language subset rejects at parse time: class inheritance/metaclasses, method decorators
  (no `@property`/`@classmethod`), `yield`/generators, `del`, `async for`/`async with`,
  `except*`, PEP 695 `type` aliases, `import *`, multi-`**kwargs`. Simple classes, dataclasses,
  `match`, comprehensions, closures, `async def`/`await` all work.

## 6. Status / local integration

- v1.6.0, stable, production-used by Pydantic AI itself.
- **`pydantic-ai-harness` already ships the whole pattern**: `CodeMode` capability +
  `CodeModeToolset` (`pydantic_ai_harness/code_mode/_toolset.py`) wraps the agent's tools
  behind a single `run_code` tool executed in Monty; `_monty_exec.py` `MontyRunState`
  (lazy `AsyncMonty()` pool, `checkout()`, snapshot-driven external-call dispatch,
  `repl_store` for cross-run REPL persistence) is the template to copy.
- **Not installed**: `uv.lock` has no monty; `pyproject.toml` selects `[coder,skills]` only.
  Fix: `uv add pydantic-monty` or add the `code-mode` extra to the harness dep.
- Docs example importing `pydantic_ai.toolsets.code_mode` does NOT exist in installed
  pydantic-ai-slim 2.68.0 — use `pydantic_ai_harness.CodeMode` / `code_mode.CodeModeToolset`.

## 7. Alternatives

- **In-process `exec`**: zero deps, full CPython + venv packages (httpx works for real).
  Zero isolation — an infinite loop hangs the backend thread forever, no memory cap,
  arbitrary fs/env/network access. Defensible only because user tools are user-authored;
  still strictly worse on failure modes. Monty wins unless users need full third-party imports.
- **Subprocess pool with stock CPython**: full language, but you re-implement the
  timeout/kill/IPC plumbing Monty gives free (~<1 ms session checkout from a running pool).
- **RestrictedPython**: unmaintained, documented escapes, no resource limits. Skip.
- **Container sandboxes** (harness already has `DockerSandbox`/`E2BSandbox`/`ModalSandbox`
  for agent code exec): ~1500 ms cold start vs <1 ms — overkill for user tool functions.

## Recommended design (A)

One `AsyncMonty` pool app-wide; one checked-out session per user-tool library; feed the
user's source once; per call `feed_run('name(**kw)', inputs={'kw': args})`. Build tool
schemas by `ast`-parsing the source host-side. Give network via a curated host function
(`external_lookup`/`external_modules`) rather than letting user code reach the venv.
Checkout per call also works (<1 ms) if sessions shouldn't share state.
Option (B): also fold user tools into `CodeMode` if the model should orchestrate them in
generated code — orthogonal and compatible.
