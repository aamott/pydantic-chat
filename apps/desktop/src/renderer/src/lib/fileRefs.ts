/**
 * `file:` link parsing shared by the Streamdown `<a>` override
 * (features/chat/MessagePart.tsx) and the tool-card file links.
 *
 * Accepted spellings — the backend instruction asks the agent for
 * `file:relative/path` with `file:path:LINE` anchors; `#L`/`file:///`
 * spellings are tolerated per the story:
 *   file:src/x.ts       → { path: 'src/x.ts' }
 *   file:src/x.ts:12    → { path: 'src/x.ts', line: 12 }   (instructed form)
 *   file:src/x.ts#L12   → { path: 'src/x.ts', line: 12 }
 *   file:src/x.ts#12    → same
 *   file:///abs/p.py    → { path: '/abs/p.py' }
 *
 * Percent-encoding is decoded. Relative paths resolve against the active
 * workspace's root server-side (`GET /api/files` joins + contains-checks);
 * absolute paths pass through the same containment check.
 */
export interface FileRef {
  path: string
  /** 1-based line anchor, when the ref carried one. */
  line?: number
}

export function parseFileHref(href: string): FileRef | null {
  if (!href.startsWith('file:')) return null
  let ref = href.slice('file:'.length)

  // `#L<n>` / `#<n>` fragment wins over the colon-suffix form.
  let line: number | undefined
  const fragment = /#L?(\d+)$/i.exec(ref)
  if (fragment) {
    line = Number(fragment[1])
    ref = ref.slice(0, fragment.index)
  }

  // `file:///abs` (and a stray `file://…`) collapses to a leading `/`.
  if (ref.startsWith('//')) ref = ref.replace(/^\/\/+/, '/')

  try {
    ref = decodeURIComponent(ref)
  } catch {
    /* malformed % escape — keep the raw ref */
  }

  // `file:path:line` (the instructed form) — only when no fragment was seen.
  if (line === undefined) {
    const suffix = /^(.*?):(\d+)$/.exec(ref)
    if (suffix) {
      ref = suffix[1]
      line = Number(suffix[2])
    }
  }

  return ref ? { path: ref, line } : null
}
