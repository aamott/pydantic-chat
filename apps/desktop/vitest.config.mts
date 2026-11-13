/**
 * Vitest config for renderer unit tests.
 *
 * Deliberately separate from `electron.vite.config.ts`: tests run in plain
 * Node against pure helpers (no DOM, no Electron), so no plugins or
 * environment emulation are needed.
 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/renderer/src/**/*.test.{ts,tsx}'],
    environment: 'node',
  },
})
