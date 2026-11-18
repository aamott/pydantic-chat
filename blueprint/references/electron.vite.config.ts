import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  // @pydantic-chat/shared ships TS source (main: src/index.ts), so it must be
  // bundled into main/preload rather than externalized into a runtime require.
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ['@pydantic-chat/shared'] })],
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ['@pydantic-chat/shared'] })],
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          settings: resolve(__dirname, 'src/renderer/settings.html'),
        },
      },
    },
  },
})
