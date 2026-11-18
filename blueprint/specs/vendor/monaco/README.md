# Monaco — vendored integration docs

Nothing else in the repo covers Monaco (app #1 is CodeMirror). Only one
upstream doc is vendored, because the rest arrives with `npm install`:

- `integrate-esm.md` — `monaco-editor` upstream ESM integration guide
  (webpack/parcel/vite). **Only the Vite section applies** — it shows the
  `self.MonacoEnvironment.getWorker` + `?worker` pattern. Fetched
  2026-11-18 from github.com/microsoft/monaco-editor; NOT shipped in the
  npm package.
- `@monaco-editor/react`'s full README ships inside the npm package —
  read `node_modules/@monaco-editor/react/README.md` after install
  (props, `onMount`/`beforeMount`, `useMonaco`, `loader.config`,
  multi-model, `DiffEditor`).

## Our stack's recipe (from P2-file-viewer, restated)

```ts
// monaco-setup.ts — lazy module, imported before the first <Editor> mounts
import * as monaco from 'monaco-editor'
import { loader } from '@monaco-editor/react'

import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'
// add css/html workers only if those languages are needed

self.MonacoEnvironment = {
  getWorker(_workerId, label) {
    if (label === 'json') return new JsonWorker()
    if (label === 'typescript' || label === 'javascript') return new TsWorker()
    return new EditorWorker()
  },
}

// MUST run before first <Editor>/<DiffEditor> mounts — otherwise the
// loader silently falls back to the jsDelivr CDN (breaks local-first +
// airplane-mode test).
loader.config({ monaco })
```

- The upstream Vite sample mixes `getWorkerUrl` into `getWorker` — the
  `?worker` *import* form above is the clean Vite-native pattern.
- Gate the ~5MB `monaco-editor` import behind this lazy setup module;
  the eager import belongs nowhere else.
- Verify: airplane-mode test (no CDN), workers load, `DiffEditor` works.
