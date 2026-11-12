import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import { apiJson } from './lib/api'
import { applyTheme } from './lib/theme'
import type { AppSettings } from '@pydantic-chat/shared'
import './styles/index.css'

// Persisted theme applies on boot; live cross-window updates are a later
// polish item (the settings window already previews via the same helper).
void apiJson<AppSettings>('/api/settings')
  .then((settings) => applyTheme(settings.theme))
  .catch(() => {
    /* backend still booting — the default theme stays in effect */
  })

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
