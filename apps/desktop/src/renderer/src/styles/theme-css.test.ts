/**
 * Regression tests for the semantic theme classes in `index.css`.
 *
 * The classes must live inside `@layer utilities` (declared after
 * `@import 'tailwindcss'`): unlayered CSS beats every rule in that layer
 * regardless of specificity, which silently kills `hover:`/`focus:`/
 * `disabled:` variant utilities wherever they pair with a semantic class.
 * These tests read the raw source so they run without a Tailwind build.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./index.css', import.meta.url), 'utf8')

/** Strip /* *\/ comments so selectors inside comments can't confuse checks. */
const uncommented = css.replace(/\/\*[\s\S]*?\*\//g, '')

/**
 * Locate every `@layer utilities { … }` block using brace matching (rules
 * inside contain nested `{}` and `>` combinators, so a lazy regex won't
 * do). Returns [blockStart, blockEnd, innerText] tuples.
 */
function utilitiesLayerBlocks(source: string): [number, number, string][] {
  const blocks: [number, number, string][] = []
  const re = /@layer\s+utilities\s*\{/g
  let match: RegExpExecArray | null
  while ((match = re.exec(source)) !== null) {
    const bodyStart = re.lastIndex
    let depth = 1
    let i = bodyStart
    while (i < source.length && depth > 0) {
      if (source[i] === '{') depth += 1
      else if (source[i] === '}') depth -= 1
      i += 1
    }
    blocks.push([match.index, i, source.slice(bodyStart, i - 1)])
    re.lastIndex = i
  }
  return blocks
}

const layerBlocks = utilitiesLayerBlocks(uncommented)
const layerText = layerBlocks.map(([, , body]) => body).join('\n')
/** Source with all `@layer utilities { … }` regions removed. */
const outsideLayers = layerBlocks
  .reduce<[number, number][]>(
    (spans, [start, end]) => [...spans, [start, end]],
    [],
  )
  .sort((a, b) => b[0] - a[0])
  .reduce((src, [start, end]) => src.slice(0, start) + src.slice(end), uncommented)

/**
 * Matches a rule whose selector list begins with the given semantic class
 * (e.g. `.text-strong {`, `.diff-add:hover {`, `.separator-active[data-…] {`).
 */
function classRule(cls: string): RegExp {
  return new RegExp(`(^|[}\\s])\\.${cls}(?![-\\w])[^;{}]*\\{`)
}

const SEMANTIC_CLASSES = [
  'text-strong',
  'bg-surface',
  'border-subtle',
  'hover-bg-raised',
  'focus-bg-raised',
  'disabled-bg-overlay',
  'diff-add',
  'separator-active',
  'placeholder-faint',
]

describe('index.css semantic classes', () => {
  it('declares at least one @layer utilities block', () => {
    expect(layerBlocks.length).toBeGreaterThan(0)
  })

  it.each(SEMANTIC_CLASSES)('defines .%s inside @layer utilities', (cls) => {
    expect(layerText).toMatch(classRule(cls))
  })

  it.each(SEMANTIC_CLASSES)('has no .%s rule outside @layer utilities', (cls) => {
    expect(outsideLayers).not.toMatch(classRule(cls))
  })

  it('defines no class rules at all outside @layer utilities', () => {
    // Outside the layer only element/at-rules should remain (body, :root,
    // [data-theme], @theme/@import/@source/@custom-variant). Any `^ .foo {`
    // rule here is unlayered and would beat all utilities.
    expect(outsideLayers).not.toMatch(/^\s*\.[a-zA-Z][\w-]*\s*[^;{}]*\{/m)
  })

  it('.text-muted resolves to the real ink color, not the --color-muted surface token', () => {
    expect(layerText).toMatch(/\.text-muted\s*\{[^}]*color:\s*var\(--c-ink-muted\)/)
    expect(layerText).not.toMatch(/\.text-muted\s*\{[^}]*var\(--muted\)/)
  })
})

describe('index.css theme tokens', () => {
  it.each(['--c-inverse-hover', '--c-danger-hover', '--c-anchor'])(
    'declares %s in both light (:root) and dark blocks',
    (token) => {
      const light = uncommented.match(/:root\s*\{[\s\S]*?\}/)?.[0] ?? ''
      const dark = uncommented.match(/\[data-theme='dark'\]\s*\{[\s\S]*?\}/)?.[0] ?? ''
      expect(light).toContain(token)
      expect(dark).toContain(token)
    },
  )

  it.each([
    ['hover-bg-inverse-hover', '--c-inverse-hover'],
    ['hover-bg-danger-soft-hover', '--c-danger-soft-hover'],
    ['hover-text-danger-strong', '--c-danger-hover'],
  ])('defines .%s reading var(%s) inside @layer utilities', (cls, token) => {
    expect(layerText).toMatch(classRule(cls))
    expect(layerText).toMatch(new RegExp(`\\.${cls}[^;{}]*\\{[^}]*var\\(${token}\\)`))
  })

  it('keeps var-only --c-anchor free of a class consumer', () => {
    expect(uncommented).not.toMatch(/\.[\w-]*anchor[\w-]*\s*[^;{}]*\{/)
  })
})

describe('index.css dead CSS removal and renames', () => {
  it.each(['border-success', 'divide-subtle', 'c-success-line'])(
    'removed dead token %s',
    (name) => {
      expect(uncommented).not.toContain(name)
    },
  )

  it('renamed .hover-bg-accent-line to .hover-bg-accent-line-soft', () => {
    expect(layerText).toMatch(
      /\.hover-bg-accent-line-soft\s*:hover\s*\{[^}]*var\(--c-accent-line-soft\)/,
    )
    // Old name gone — word-boundary check so "-soft" suffix doesn't hide it.
    expect(uncommented).not.toMatch(/hover-bg-accent-line(?!-[\w])/)
  })
})
