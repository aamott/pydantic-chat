/**
 * Vitest config for renderer tests, split into two projects:
 *
 * - `node` — pure helpers (`*.test.ts`), no DOM, no Electron.
 * - `dom`  — component tests (`*.test.tsx`) under jsdom + React Testing
 *   Library, with `src/test/setup.ts` providing the jsdom gaps
 *   (`scrollIntoView`, `matchMedia`) and the `window.api` preload stub.
 *
 * Deliberately separate from `electron.vite.config.ts`: tests run in plain
 * Node workers and don't need the Electron/React plugins — esbuild's
 * automatic JSX transform covers the components.
 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          include: [
            'src/renderer/src/**/*.test.ts',
            // Main-process pure helpers (Electron-free): the shell:open-path
            // confinement resolver and friends.
            'src/main/**/*.test.ts',
          ],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'dom',
          include: ['src/renderer/src/**/*.test.tsx'],
          environment: 'jsdom',
          setupFiles: ['src/renderer/src/test/setup.ts'],
        },
      },
    ],
  },
})
