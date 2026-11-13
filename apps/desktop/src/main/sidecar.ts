/**
 * Backend sidecar supervisor.
 *
 * Owns the Python FastAPI process end-to-end (dev AND prod): probes a free
 * loopback port, spawns `uv run uvicorn`, scrubs ambient Python env, gates
 * window loads on /health, tears down the whole process group on quit, and
 * auto-restarts on unexpected exits with capped exponential backoff.
 *
 * Escape hatch: `AGENT_BACKEND_EXTERNAL=1` skips spawning and attaches to a
 * manually-run uvicorn (e.g. `bun run dev:server`). In that mode the backend's
 * own APP_TOKEN must be supplied via env so the renderer token matches.
 */
import { app } from 'electron'
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { createWriteStream, type WriteStream } from 'node:fs'
import { createServer } from 'node:net'
import { delimiter, dirname, join, resolve } from 'node:path'
import type { BackendInfo, BackendStatus } from '@pydantic-chat/shared'

const HEALTH_POLL_MS = 250
const HEALTH_TIMEOUT_MS = 60_000
/** How long a respawned child gets to answer /health before we kill it. */
const MONITOR_TIMEOUT_MS = 30_000
const KILL_GRACE_MS = 5_000
const MAX_RESTARTS = 3
const RESTART_BASE_DELAY_MS = 500

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/** Probe-bind 127.0.0.1:0 to find a free ephemeral port. */
function probeLoopbackPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address && typeof address === 'object') {
        server.close(() => resolvePort(address.port))
      } else {
        server.close(() => reject(new Error('could not probe a free port')))
      }
    })
  })
}

/**
 * Directory containing the backend `uv` project.
 * Dev: `app.getAppPath()` is apps/desktop under electron-vite.
 * Packaged: expects a backend checkout under resources/ (see
 * electron-builder.yml — a frozen sidecar is a later milestone).
 */
function backendDir(): string {
  if (process.env.AGENT_BACKEND_DIR) return resolve(process.env.AGENT_BACKEND_DIR)
  if (app.isPackaged) return join(process.resourcesPath, 'backend')
  return resolve(app.getAppPath(), '..', 'backend')
}

/** Origin the FastAPI CORSMiddleware should allow for this launch mode. */
function rendererOrigin(): string {
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    try {
      return new URL(devUrl).origin
    } catch {
      /* fall through */
    }
  }
  // Packaged renderer loads via file:// — Chromium sends `Origin: null`.
  return 'null'
}

/**
 * Absolute path of `name` as the ambient PATH resolves it, if any. Used to
 * grandfather the actual `uv` install into `sanitizedPath` and to spawn `uv`
 * directly — nonstandard installs (nix, pipx shims, custom prefixes) keep
 * working without re-admitting every user-writable PATH entry.
 */
function resolveBinFromPath(name: string): string | null {
  const candidates =
    process.platform === 'win32'
      ? [`${name}.exe`, `${name}.cmd`, `${name}.bat`, name]
      : [name]
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    const found = candidates.find((bin) => existsSync(join(dir, bin)))
    if (found !== undefined) return join(dir, found)
  }
  return null
}

/**
 * PATH for spawned children (S4036): fixed, system-owned directories plus
 * the well-known user tool locations the `uv` installers target — never
 * the ambient PATH wholesale, which on dev shells routinely contains
 * user-writable dirs that could shadow `uv` with a hostile binary.
 *
 * The ambient PATH is still consulted once to locate `uv`'s own directory
 * and that single dir is appended last: we are about to execute that exact
 * binary either way, so this preserves exotic install layouts without
 * widening the trust surface beyond the status quo.
 */
function sanitizedPath(): string {
  const home = app.getPath('home')
  let dirs: string[]
  if (process.platform === 'win32') {
    const root = process.env.SystemRoot ?? 'C:\\Windows'
    dirs = [
      join(root, 'System32'),
      root,
      join(root, 'System32', 'Wbem'),
      join(root, 'System32', 'WindowsPowerShell', 'v1.0'),
      join(home, '.local', 'bin'), // official uv installer default
      join(home, '.cargo', 'bin'), // rustup-managed installs
    ]
    const localAppData = process.env.LOCALAPPDATA
    if (localAppData) dirs.push(join(localAppData, 'Programs'))
  } else {
    dirs = [
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
      '/opt/homebrew/bin', // Homebrew on Apple Silicon
      '/home/linuxbrew/.linuxbrew/bin', // Homebrew on Linux
      join(home, '.local', 'bin'), // official uv installer default
      join(home, '.cargo', 'bin'), // rustup-managed installs
    ]
  }
  const uvBin = resolveBinFromPath('uv')
  const uvDir = uvBin === null ? null : dirname(uvBin)
  if (uvDir !== null && !dirs.includes(uvDir)) dirs.push(uvDir)
  return dirs.join(delimiter)
}

/** Absolute path to Windows' taskkill — resolved without consulting PATH. */
function taskkillPath(): string {
  const root = process.env.SystemRoot ?? 'C:\\Windows'
  return join(root, 'System32', 'taskkill.exe')
}

/**
 * Child env: scrubbed of ambient Python config so `uv` picks the project
 * venv, with PATH replaced by the sanitized allowlist (S4036).
 */
function buildChildEnv(token: string): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.PYTHONPATH
  delete env.PYTHONHOME
  delete env.VIRTUAL_ENV
  env.PATH = sanitizedPath()
  env.PYTHONUNBUFFERED = '1'
  env.APP_TOKEN = token
  env.APP_DATA_DIR = app.getPath('userData')
  env.RENDERER_ORIGIN = rendererOrigin()
  return env
}

/**
 * Kill the child's whole process tree. POSIX: the child was spawned
 * `detached` so it's a process-group leader → signal the negative pgid.
 * Windows: `taskkill /T` walks the tree; `/F` only on forced escalation.
 */
function signalTree(child: ChildProcess, signal: 'SIGTERM' | 'SIGKILL'): void {
  if (child.pid === undefined) return
  if (process.platform === 'win32') {
    const args = ['/pid', String(child.pid), '/t']
    if (signal === 'SIGKILL') args.push('/f')
    // Absolute System32 path — taskkill must not be resolved through a
    // possibly-writable PATH entry (S4036).
    execFile(taskkillPath(), args, () => {})
    return
  }
  try {
    process.kill(-child.pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      /* already gone */
    }
  }
}

export class BackendSidecar {
  private child: ChildProcess | null = null
  private info: BackendInfo | null = null
  private port = 0
  private external = false
  private stopping = false
  private failed = false
  private failReason = ''
  private healthy = false
  private restartAttempts = 0
  private logStream: WriteStream | null = null

  /** `onStatus` is invoked on every lifecycle transition (status broadcast). */
  constructor(private readonly onStatus: (status: BackendStatus) => void) {}

  get ready(): boolean {
    return this.healthy
  }

  get backendInfo(): BackendInfo | null {
    return this.info
  }

  /**
   * Generate the per-launch token, probe a port, and spawn uvicorn.
   * Resolves as soon as the process is spawned (or skipped in external
   * mode) — callers must `await waitReady()` before loading the renderer.
   */
  async launch(): Promise<BackendInfo> {
    this.onStatus({ state: 'starting' })
    const token = randomBytes(32).toString('hex')

    if (process.env.AGENT_BACKEND_EXTERNAL === '1') {
      this.external = true
      const url = process.env.AGENT_BACKEND_URL ?? 'http://127.0.0.1:8787'
      // Token must match the externally-run backend's APP_TOKEN.
      this.info = { url, token: process.env.APP_TOKEN ?? token }
      void this.monitor(null)
      return this.info
    }

    this.port = await probeLoopbackPort()
    this.info = { url: `http://127.0.0.1:${this.port}`, token }
    this.spawn()
    return this.info
  }

  /**
   * Resolve once /health answers; reject on timeout (60s) or when the
   * restart cap is exhausted. Polls flags rather than re-fetching — a
   * `monitor()` loop per child does the actual HTTP probing.
   */
  async waitReady(): Promise<void> {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS
    while (!this.healthy) {
      if (this.stopping) throw new Error('sidecar stopped before backend was ready')
      if (this.failed) throw new Error(this.failReason)
      if (Date.now() >= deadline) {
        this.markFailed(
          `backend did not answer /health within ${HEALTH_TIMEOUT_MS / 1000}s`,
        )
        throw new Error(this.failReason)
      }
      await sleep(HEALTH_POLL_MS)
    }
  }

  /** SIGTERM → grace → SIGKILL on the whole process group; end the log stream. */
  async stop(): Promise<void> {
    this.stopping = true
    const child = this.child
    this.child = null
    try {
      if (child && child.exitCode === null && child.pid !== undefined) {
        const exited = new Promise<void>((res) => child.once('exit', () => res()))
        signalTree(child, 'SIGTERM')
        const graceful = await Promise.race([
          exited.then(() => true),
          sleep(KILL_GRACE_MS).then(() => false),
        ])
        if (!graceful) {
          this.log('grace period expired; force-killing process tree')
          signalTree(child, 'SIGKILL')
          await Promise.race([exited, sleep(2_000)])
        }
      }
    } finally {
      this.logStream?.end()
      this.logStream = null
    }
  }

  /* ------------------------------ internals ------------------------------ */

  private markFailed(reason: string): void {
    this.failed = true
    this.failReason = reason
    this.log(`FAILED: ${reason}`)
    this.onStatus({ state: 'failed', error: reason })
  }

  private spawn(): void {
    const dir = backendDir()
    const args = [
      'run',
      'uvicorn',
      'app.main:app',
      '--host',
      '127.0.0.1',
      '--port',
      String(this.port),
    ]
    // --reload gives uvicorn a supervisor + worker pair; the process-group
    // kill in stop() still reaps both.
    if (!app.isPackaged) args.push('--reload')

    this.log(`spawn: uv ${args.join(' ')} (cwd=${dir})`)
    const child = spawn(resolveBinFromPath('uv') ?? 'uv', args, {
      cwd: dir,
      env: buildChildEnv(this.info!.token),
      detached: process.platform !== 'win32', // process-group leader on POSIX
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.child = child
    child.stdout?.pipe(this.ensureLog(), { end: false })
    child.stderr?.pipe(this.ensureLog(), { end: false })

    let ended = false
    const handleEnd = (why: string): void => {
      if (ended) return
      ended = true
      this.onChildEnd(child, why)
    }
    // 'error' covers "uv not found"/spawn failures (may fire without 'exit').
    child.once('error', (err) => handleEnd(`spawn error: ${err.message}`))
    child.once('exit', (code, signal) =>
      handleEnd(`code=${code ?? 'null'} signal=${signal ?? 'none'}`),
    )
    void this.monitor(child)
  }

  /** Poll /health for one specific child; bail when it dies or times out. */
  private async monitor(child: ChildProcess | null): Promise<void> {
    const deadline = Date.now() + MONITOR_TIMEOUT_MS
    const healthUrl = `${this.info!.url}/health`
    while (!this.stopping && !this.failed) {
      // A different child now owns the slot, or this one died — onChildEnd
      // is responsible for what happens next.
      if (child !== null && (this.child !== child || child.exitCode !== null)) {
        return
      }
      if (child !== null && Date.now() >= deadline) {
        // Alive but never healthy — kill it so the restart path proceeds.
        this.log('health monitor timed out; killing unresponsive child')
        signalTree(child, 'SIGKILL')
        return
      }
      try {
        const res = await fetch(healthUrl)
        if (res.ok) {
          this.healthy = true
          this.restartAttempts = 0
          this.onStatus({ state: 'ready' })
          return
        }
      } catch {
        /* not up yet */
      }
      // External mode (child === null) has no deadline — waitReady()'s own
      // timeout flips `failed` which exits this loop.
      await sleep(HEALTH_POLL_MS)
    }
  }

  private onChildEnd(child: ChildProcess, why: string): void {
    this.log(`backend exited: ${why}`)
    if (this.child === child) this.child = null
    this.healthy = false
    if (this.stopping || this.external) return

    if (this.restartAttempts >= MAX_RESTARTS) {
      this.markFailed(`backend exited (${why}); restart limit reached`)
      return
    }
    this.restartAttempts += 1
    const delay = RESTART_BASE_DELAY_MS * 2 ** (this.restartAttempts - 1)
    this.onStatus({ state: 'restarting', attempt: this.restartAttempts })
    this.log(
      `restarting in ${delay}ms (attempt ${this.restartAttempts}/${MAX_RESTARTS})`,
    )
    setTimeout(() => {
      if (this.stopping || this.failed) return
      this.spawn()
    }, delay)
  }

  private ensureLog(): WriteStream {
    if (!this.logStream) {
      const dir = app.getPath('logs')
      mkdirSync(dir, { recursive: true })
      this.logStream = createWriteStream(join(dir, 'backend.log'), {
        flags: 'a',
      })
    }
    return this.logStream
  }

  private log(line: string): void {
    // Never log APP_TOKEN or other secrets — operational lines only.
    this.ensureLog().write(`[${new Date().toISOString()}] ${line}\n`)
  }
}
