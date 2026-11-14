/**
 * Tests for lib/theme.ts — `initTheme` boot wiring and `applyTheme`'s
 * `system` resolution through `prefers-color-scheme`.
 *
 * `*.test.ts` files run in the `node` vitest project (see
 * vitest.config.mts): no jsdom and no test/setup.ts, so the DOM surface
 * theme.ts touches at module scope (`window.matchMedia`) and per call
 * (`document.documentElement`, `window.api`) is stubbed on globalThis
 * inside `vi.hoisted` — guaranteed to run before the module imports.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { AppSettings } from '@pydantic-chat/shared'

const dom = vi.hoisted(() => {
  type ChangeListener = () => void
  const mqlListeners = new Set<ChangeListener>()
  const mql = {
    matches: false,
    media: '(prefers-color-scheme: dark)',
    addEventListener: (_type: string, cb: ChangeListener) => {
      mqlListeners.add(cb)
    },
    removeEventListener: (_type: string, cb: ChangeListener) => {
      mqlListeners.delete(cb)
    },
  }
  const documentElement = {
    dataset: {} as Record<string, string>,
    style: {} as Record<string, string>,
  }
  const windowStub: Record<string, unknown> = {
    matchMedia: () => mql,
    api: undefined,
  }
  ;(globalThis as Record<string, unknown>).window = windowStub
  ;(globalThis as Record<string, unknown>).document = { documentElement }
  return { mql, mqlListeners, documentElement, windowStub }
})

vi.mock('./api', () => ({ apiJson: vi.fn() }))

import { apiJson } from './api'
import { applyTheme, initTheme } from './theme'

const apiJsonMock = vi.mocked(apiJson)

type ThemeCallback = (theme: string) => void

/** Manually-resolved promise standing in for the boot settings fetch. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Let queued promise continuations (the fetch .then) run. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  apiJsonMock.mockReset()
  dom.mql.matches = false
  dom.documentElement.dataset = {}
  dom.documentElement.style = {}
  delete dom.windowStub.api
})

describe('initTheme', () => {
  it('applies the persisted theme when no relay arrives', async () => {
    const onTheme = vi.fn((_cb: ThemeCallback) => () => {})
    dom.windowStub.api = { onTheme }
    const fetch = deferred<AppSettings>()
    apiJsonMock.mockReturnValue(fetch.promise)

    initTheme()

    expect(onTheme).toHaveBeenCalledOnce()
    expect(apiJsonMock).toHaveBeenCalledWith('/api/settings')

    fetch.resolve({ theme: 'dark' } as AppSettings)
    await flush()

    expect(dom.documentElement.dataset.theme).toBe('dark')
    expect(dom.documentElement.style.colorScheme).toBe('dark')
  })

  it('lets a live relay win when it lands while the boot fetch is in flight', async () => {
    let relay!: ThemeCallback
    dom.windowStub.api = {
      onTheme: (cb: ThemeCallback) => {
        relay = cb
        return () => {}
      },
    }
    const fetch = deferred<AppSettings>()
    apiJsonMock.mockReturnValue(fetch.promise)

    initTheme()
    relay('dark') // user flipped the theme in the settings window
    // …then the stale persisted value arrives — it must NOT clobber.
    fetch.resolve({ theme: 'light' } as AppSettings)
    await flush()

    expect(dom.documentElement.dataset.theme).toBe('dark')
  })

  it('keeps applying live relays after the fetch resolves', async () => {
    let relay!: ThemeCallback
    dom.windowStub.api = {
      onTheme: (cb: ThemeCallback) => {
        relay = cb
        return () => {}
      },
    }
    const fetch = deferred<AppSettings>()
    apiJsonMock.mockReturnValue(fetch.promise)

    initTheme()
    fetch.resolve({ theme: 'light' } as AppSettings)
    await flush()
    expect(dom.documentElement.dataset.theme).toBe('light')

    // A later relay still applies immediately — the guard only covers
    // the window between initTheme() and the fetch resolving.
    relay('dark')
    expect(dom.documentElement.dataset.theme).toBe('dark')
  })

  it('leaves the current theme in place when the boot fetch fails', async () => {
    dom.windowStub.api = { onTheme: (_cb: ThemeCallback) => () => {} }
    const fetch = deferred<AppSettings>()
    apiJsonMock.mockReturnValue(fetch.promise)

    initTheme()
    fetch.reject(new Error('backend still booting'))
    await flush()

    expect(dom.documentElement.dataset.theme).toBeUndefined()
  })

  it('is safe when window.api.onTheme is missing', async () => {
    dom.windowStub.api = {} // preload bridge without the theme relay
    const fetch = deferred<AppSettings>()
    apiJsonMock.mockReturnValue(fetch.promise)

    expect(() => initTheme()).not.toThrow()

    fetch.resolve({ theme: 'dark' } as AppSettings)
    await flush()
    expect(dom.documentElement.dataset.theme).toBe('dark')
  })

  it('is safe when window.api itself is absent', async () => {
    const fetch = deferred<AppSettings>()
    apiJsonMock.mockReturnValue(fetch.promise)

    expect(() => initTheme()).not.toThrow()

    fetch.resolve({ theme: 'light' } as AppSettings)
    await flush()
    expect(dom.documentElement.dataset.theme).toBe('light')
  })
})

describe('applyTheme', () => {
  it("resolves 'system' through prefers-color-scheme", () => {
    dom.mql.matches = true
    applyTheme('system')
    expect(dom.documentElement.dataset.theme).toBe('dark')

    dom.mql.matches = false
    applyTheme('system')
    expect(dom.documentElement.dataset.theme).toBe('light')
  })

  it('applies explicit light/dark values regardless of the OS setting', () => {
    dom.mql.matches = true
    applyTheme('light')
    expect(dom.documentElement.dataset.theme).toBe('light')
    applyTheme('dark')
    expect(dom.documentElement.dataset.theme).toBe('dark')
  })
})
