import React from 'react'
import ReactDOM from 'react-dom/client'
import { SettingsApp } from './features/settings/SettingsApp'
import { initTheme } from './lib/theme'
import './styles/index.css'

// Same boot theme wiring as the main window — without it a dark-theme
// user gets a white flash while SettingsApp's own settings fetch lands.
initTheme()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <SettingsApp />
  </React.StrictMode>,
)
