/**
 * Live theme application: mirrors the `theme` app setting onto
 * `document.documentElement` so `dark:` utilities (wired to the
 * `data-theme` attribute via `@custom-variant` in styles/index.css) and
 * native form controls (`color-scheme`) react immediately.
 *
 * `system` resolves through `prefers-color-scheme` and stays subscribed to
 * OS changes for as long as it is the active setting. The `--c-*` tokens and
 * semantic classes in styles/index.css flip on this attribute.
 */
import type { AppSettings } from '@pydantic-chat/shared'
import { apiJson } from './api'

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

/**
 * Boot theme wiring, shared by every renderer entry point (main window,
 * settings window): apply the persisted theme once, then follow live
 * `settings:theme` relays from the other windows.
 *
 * Ordering matters: the relay subscription is installed BEFORE the
 * `GET /api/settings` fetch is fired, and the persisted value is applied
 * only if no live theme arrived while the fetch was in flight — otherwise
 * a theme the user just picked in the settings window would be clobbered
 * by the stale persisted one.
 *
 * `onTheme` is optional-chained: preload-less contexts (tests, plain
 * browser dev) may expose `window.api` without the relay.
 */
export function initTheme(): void {
  let liveThemeSeen = false
  window.api?.onTheme?.((theme) => {
    liveThemeSeen = true
    applyTheme(theme)
  })
  void apiJson<AppSettings>('/api/settings')
    .then((settings) => {
      if (!liveThemeSeen) applyTheme(settings.theme)
    })
    .catch(() => {
      /* backend still booting — the default theme stays in effect */
    })
}
