import { useState, useSyncExternalStore } from 'react'
import Dialog from '../components/Dialog'
import { extensionSecretSet } from '../lib/ipc'
import { pendingSecret, settleSecret, subscribeSecret, type PendingSecret } from './secretPrompt'

function SecretForm({ request }: { request: PendingSecret }) {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const cancel = () => settleSecret(request.id, false)
  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      await extensionSecretSet(request.extensionId, request.name, value)
      settleSecret(request.id, true)
    } catch (e) {
      setError(String(e))
      setBusy(false)
    }
  }
  return (
    <Dialog
      title={`${request.extensionName}: ${request.label}`}
      subtitle="Saved in your system keychain"
      className="centered secret-dialog"
      dismissible={!busy}
      onClose={cancel}
      footer={
        <>
          <button onClick={cancel} disabled={busy}>
            Cancel
          </button>
          <button className="primary" disabled={busy || !value.trim()} onClick={() => void save()}>
            Save
          </button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (value.trim() && !busy) void save()
        }}
      >
        {request.description && <p>{request.description}</p>}
        <p className="hint">
          Patchbay sends this only with the extension&apos;s requests to its approved servers. The
          extension never reads it.
        </p>
        <label>
          {request.label}
          <input
            type="password"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-label={request.label}
          />
        </label>
        {error && <p className="error">{error}</p>}
      </form>
    </Dialog>
  )
}

/** Renders the pending extension credential prompt in the main window. */
export default function SecretPromptHost() {
  const request = useSyncExternalStore(subscribeSecret, pendingSecret)
  return request ? <SecretForm key={request.id} request={request} /> : null
}
