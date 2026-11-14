/**
 * Cross-area class constants — small shared UI strings reachable from every
 * feature folder (sidebar, settings, editor, chat). Feature-scoped kits
 * (`chat/partKit.tsx`, `settings/components.tsx`) re-use these too; anything
 * only one feature needs stays in that feature's kit file.
 */

/** Hover affordance for ghost icon buttons. */
export type IconButtonTone = 'neutral' | 'danger'

/**
 * Fill the button sits on: 'surface' for panels/cards/popovers on
 * `bg-surface` (a `bg-raised` hover step shows up), 'subtle' for chrome on
 * `bg-subtle` like the sidebar (needs the deeper `bg-overlay` step).
 */
export type IconButtonSurface = 'surface' | 'subtle'

export interface IconButtonOptions {
  /** 'neutral' (default) or 'danger' hover affordance. */
  readonly tone?: IconButtonTone
  /** Surface under the button — picks the visible hover step. */
  readonly surface?: IconButtonSurface
  /** Stronger resting glyph (`text-muted`) where `text-faint` reads too light. */
  readonly muted?: boolean
}

/**
 * Color/base classes for a ghost icon button — no chrome, so sites with
 * nonstandard sizing (rounded-md, p-2, p-0.5, positioning) compose it with
 * their own classes. Use `iconButtonClass` for the standard `rounded p-1`
 * button.
 *
 * The subtle-danger hover deliberately uses the `-soft-hover` step: a plain
 * `hover-bg-danger-soft` is invisible inside `bg-danger-soft` confirm
 * banners (the original pre-theme classes were `hover:bg-red-100`).
 */
export function iconButtonColors({
  tone = 'neutral',
  surface = 'surface',
  muted = false,
}: IconButtonOptions = {}): string {
  const base = muted ? 'text-muted' : 'text-faint'
  if (tone === 'danger') {
    return surface === 'subtle'
      ? `${base} hover-bg-danger-soft-hover hover-text-danger`
      : `${base} hover-bg-raised hover-text-danger`
  }
  return surface === 'subtle'
    ? `${base} hover-bg-overlay hover-text-default`
    : `${base} hover-bg-raised hover-text-default`
}

/** Standard `rounded p-1` ghost icon button. */
export function iconButtonClass(opts: IconButtonOptions = {}): string {
  return `rounded p-1 ${iconButtonColors(opts)}`
}

/** Small red "Retry" button inside error banners (chat + settings). */
export const retryButtonClass =
  'shrink-0 rounded bg-red-600 px-2 py-0.5 text-white hover:bg-red-700'

/**
 * Inline destructive-confirm banner for sidebar rows (workspace + chat
 * deletes). `paddingX` preserves each row's gutter: 'px-2' inside chat rows,
 * 'px-1.5' on workspace headers.
 */
export function confirmBannerClass(
  paddingX: 'px-1.5' | 'px-2' = 'px-2',
): string {
  return `flex items-center gap-1 rounded-md bg-danger-soft ${paddingX} py-1 text-xs text-danger`
}
