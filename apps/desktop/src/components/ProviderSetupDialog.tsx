import { continueProviderSetup, useProviderSetup } from '../lib/providerAuth'
import Dialog from './Dialog'
import ProviderAuthSection from './ProviderAuthSection'

export default function ProviderSetupDialog() {
  const pending = useProviderSetup((s) => s.pending)
  if (!pending) return null
  const close = () => useProviderSetup.setState({ pending: null })
  return (
    <Dialog
      className="provider-setup-overlay"
      title={`Set up ${pending.request.provider === 'claude' ? 'Claude Code' : 'Codex'}`}
      onClose={close}
    >
      <p>Your draft and selections are kept. After setup, click Start or Send again to continue.</p>
      <ProviderAuthSection
        key={JSON.stringify(pending.request)}
        request={pending.request}
        initial={pending.result}
        onReady={close}
        onContinue={() => continueProviderSetup(pending.request)}
      />
      <div className="row">
        <button onClick={close}>Back to my work</button>
      </div>
    </Dialog>
  )
}
