import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@xyflow/react/dist/style.css'
import '@xterm/xterm/css/xterm.css'
import './index.css'
import App from './App'
import ComponentWindow from './components/ComponentWindow'

const component = new URLSearchParams(window.location.search).get('component')

// Hooks for `npm run smoke`; the dead branch keeps them out of production bundles.
if (import.meta.env.DEV) void import('./lib/smoke').then((m) => m.installSmokeHooks())

createRoot(document.getElementById('root')!).render(
  <StrictMode>{component !== null ? <ComponentWindow id={component} /> : <App />}</StrictMode>,
)
