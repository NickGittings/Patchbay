import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@xyflow/react/dist/style.css'
import '@xterm/xterm/css/xterm.css'
import './index.css'
import App from './App'
import ComponentWindow from './components/ComponentWindow'
import ProviderSetupDialog from './components/ProviderSetupDialog'
import ConfirmHost from './components/ConfirmHost'
import { trackActiveWindow } from './lib/windows'

// The main window takes file drops in the page (`dragDropEnabled: false`) so Chat's composer
// receives dropped images. A file dropped anywhere else must not replace the app with that file.
for (const type of ['dragover', 'drop'])
  window.addEventListener(type, (e) => {
    if ((e as DragEvent).dataTransfer?.types.includes('Files')) e.preventDefault()
  })

const component = new URLSearchParams(window.location.search).get('component')

trackActiveWindow()

// Hooks for `npm run smoke`; the dead branch keeps them out of production bundles.
if (import.meta.env.DEV) void import('./lib/smoke').then((m) => m.installSmokeHooks())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {component !== null ? <ComponentWindow id={component} /> : <App />}
    <ProviderSetupDialog />
    <ConfirmHost />
  </StrictMode>,
)
