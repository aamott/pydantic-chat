/**
 * Live theme application: mirrors the `theme` app setting onto
 * `document.documentElement` so `dark:` utilities (wired to the
 * `data-theme` attribute via `@custom-variant` in styles/index.css) and
 * native form controls (`color-scheme`) react immediately.
 *
 * `system` resolves through `prefers-color-scheme` and stays subscribed to
 * OS changes for as long as it is the active setting. Full dark-mode color
 * tokens are a later polish pass — today this mostly drives native widgets
 * and any `dark:` classes the settings window opts into.
 */

/** The setting currently in force; re-applied on OS theme changes. */
let activeTheme = 'system'

const darkMedia = (): MediaQueryList =>
  window.matchMedia('(prefers-color-scheme: dark)')

/**
 * Apply a `theme` setting value to the document.
 *
 * Unknown values degrade to `system` — the backend validates the setting,
 * so this only guards against a stale renderer build.
 */
export function applyTheme(theme: string): void {
  activeTheme = theme === 'light' || theme === 'dark' ? theme : 'system'
  const dark = activeTheme === 'dark' || (activeTheme === 'system' && darkMedia().matches)
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
}

// Follow the OS while `system` is selected; one listener for the app.
darkMedia().addEventListener('change', () => {
  if (activeTheme === 'system') applyTheme('system')
})
