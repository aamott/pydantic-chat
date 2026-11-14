import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import { initTheme } from './lib/theme'
import './styles/index.css'

// Persisted theme applies on boot; afterwards the settings window relays
// theme changes through the main process (`settings:theme` IPC).
initTheme()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
