/**
 * jsdom environment setup for renderer component tests (`*.test.tsx`).
 *
 * Runs only in the `dom` vitest project (see vitest.config.mts) — pure-
 * helper tests keep the plain node environment.
 *
 * jsdom gaps patched here:
 * - `Element.prototype.scrollIntoView` is a no-op in jsdom but components
 *   (ModelPicker, MentionList) call it when moving the highlight.
 * - `window.matchMedia` is unimplemented; stubbed for any component that
 *   reaches theme/media-query code.
 * - `window.api` is the preload bridge (`global.d.ts`); stubbed so any
 *   incidental `apiFetch` path fails against an unreachable loopback URL
 *   rather than crashing on an undefined property — tests should still
 *   mock `lib/api` or seed stores instead of hitting it.
 */
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'
import type { Api } from '../../../preload/index'

/* Unmount rendered trees between tests — globals are off, so RTL's
 * auto-cleanup (which looks for a global `afterEach`) doesn't fire. */
afterEach(cleanup)

if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {}
}

if (typeof window !== 'undefined' && window.matchMedia === undefined) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia
}

const apiStub: Api = {
  backendUrl: 'http://127.0.0.1:1',
  token: 'test-token',
  getBackendInfo: async () => null,
  pickWorkspace: async () => null,
  openSettings: async () => {},
  onOpenWorkspace: () => () => {},
  onBackendStatus: () => () => {},
  notifyTheme: () => {},
  onTheme: () => () => {},
}

if (typeof window !== 'undefined') {
  window.api = apiStub
}
