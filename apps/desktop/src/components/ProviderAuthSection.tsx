import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import {
  onProviderLoginEvent,
  providerLoginStart,
  providerLoginCancel,
  providerLoginWrite,
  providerLoginResize,
} from '../lib/ipc'
import {
  checkProviderAuth,
  invalidateProviderAuth,
  type AuthRequest,
  type AuthStatus,
} from '../lib/providerAuth'
import { terminalTheme } from '../lib/terminals'

const labels = {
  signedIn: 'Signed in',
  signedOut: 'Signed out',
  cliMissing: 'CLI missing',
  unknown: 'Authentication unknown',
}
export default function ProviderAuthSection({
  request,
  initial,
  onReady,
  onContinue,
}: {
  request: AuthRequest
  initial?: AuthStatus
  onReady?: () => void
  onContinue?: () => void
}) {
  const [result, setResult] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [login, setLogin] = useState(false)
  const serial = useRef(0)
  const readyRef = useRef(onReady)
  readyRef.current = onReady
  const requestKey = JSON.stringify(request)
  useEffect(() => {
    let disposed = false
    const check = async () => {
      const token = ++serial.current
      setBusy(true)
      const value = await checkProviderAuth(request, true)
      if (disposed || token !== serial.current) return
      setResult(value)
      setBusy(false)
      if (value.state === 'signedIn') readyRef.current?.()
    }
    const invalidate = () => {
      serial.current++
    }
    void check()
    window.addEventListener('focus', check)
    return () => {
      disposed = true
      invalidate()
      window.removeEventListener('focus', check)
    }
    // The serialized request identifies a launch context across parent renders.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey])
  const check = async () => {
    const token = ++serial.current
    setBusy(true)
    const value = await checkProviderAuth(request, true)
    if (token !== serial.current) return
    setResult(value)
    setBusy(false)
    if (value.state === 'signedIn') readyRef.current?.()
  }
  return (
    <section aria-label="Provider authentication">
      <p role="status">
        <strong>Authentication: {result ? labels[result.state] : 'Checking…'}</strong>
      </p>
      {result && <p>{result.message}</p>}
      <p>
        The provider CLI handles sign-in and stores credentials. External terminals using the same
        configuration share this login.
      </p>
      {result?.state === 'cliMissing' && (
        <p>
          Install {request.provider === 'claude' ? 'Claude Code' : 'Codex'} from{' '}
          <a
            href={
              request.provider === 'claude'
                ? 'https://code.claude.com/docs/en/setup'
                : 'https://developers.openai.com/codex/cli/'
            }
            target="_blank"
            rel="noreferrer"
          >
            the provider’s installation guide
          </a>
          , then check status.
        </p>
      )}
      <div className="row">
        <button
          disabled={
            login ||
            busy ||
            result?.loginSupported === false ||
            result?.state === 'signedIn' ||
            result?.state === 'cliMissing'
          }
          onClick={() => setLogin(true)}
        >
          Sign in
        </button>
        <button disabled={busy || login} onClick={() => void check()}>
          {busy ? 'Checking…' : 'Check status'}
        </button>
        {result?.state === 'unknown' && onContinue && (
          <>
            <button disabled={busy || login} onClick={() => void check()}>
              Retry
            </button>
            <button disabled={busy || login} onClick={onContinue}>
              Continue anyway
            </button>
          </>
        )}
      </div>
      {login && (
        <LoginTerminal
          request={request}
          onExit={() => {
            setLogin(false)
            invalidateProviderAuth()
            void check()
          }}
        />
      )}
    </section>
  )
}

/** Dedicated xterm: no shared registry, hydration, input log or persisted output. */
function LoginTerminal({ request, onExit }: { request: AuthRequest; onExit: () => void }) {
  const host = useRef<HTMLDivElement>(null)
  const done = useRef(onExit)
  done.current = onExit
  const [error, setError] = useState('')
  useEffect(() => {
    const id = crypto.randomUUID()
    let disposed = false
    let finished = false
    let unlisten: (() => void) | undefined
    const term = new Terminal({ theme: terminalTheme(), cursorBlink: true, scrollback: 1000 })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host.current!)
    const resize = () => {
      fit.fit()
      void providerLoginResize(id, term.cols, term.rows).catch(() => {})
    }
    const observer = new ResizeObserver(resize)
    observer.observe(host.current!)
    const input = term.onData((data) => {
      void providerLoginWrite(id, data).catch(() => {})
    })
    void (async () => {
      unlisten = await onProviderLoginEvent((event) => {
        if (disposed || !event.sessionId.endsWith(`/${id}`)) return
        if (event.type === 'output') term.write(new Uint8Array(event.data))
        if (event.type === 'exited') {
          finished = true
          done.current()
        }
      })
      if (disposed) {
        unlisten()
        return
      }
      await providerLoginStart(request, id)
      if (disposed) {
        await providerLoginCancel(id)
        return
      }
      resize()
      term.focus()
    })().catch(() => {
      if (!disposed)
        setError(
          'The sign-in terminal could not start. Close setup and retry after checking the CLI.',
        )
    })
    return () => {
      disposed = true
      observer.disconnect()
      input.dispose()
      unlisten?.()
      term.dispose()
      if (!finished) invalidateProviderAuth()
      void providerLoginCancel(id).catch(() => {})
    }
    // This terminal owns the context it was started for.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <>
      <p>
        Complete sign-in below and in your browser. Closing setup cancels this login process; it
        does not sign you out.
      </p>
      <div ref={host} className="provider-login-terminal" style={{ height: 300, width: '100%' }} />
      {error && <p role="alert">{error}</p>}
    </>
  )
}
