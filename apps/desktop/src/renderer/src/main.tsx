import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import { apiJson } from './lib/api'
import { applyTheme } from './lib/theme'
import type { AppSettings } from '@pydantic-chat/shared'
import './styles/index.css'

// Persisted theme applies on boot; afterwards the settings window relays
// theme changes through the main process (`settings:theme` IPC).
void apiJson<AppSettings>('/api/settings')
  .then((settings) => applyTheme(settings.theme))
  .catch(() => {
    /* backend still booting — the default theme stays in effect */
  })
window.api.onTheme(applyTheme)

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
