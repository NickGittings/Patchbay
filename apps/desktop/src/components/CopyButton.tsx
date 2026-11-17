import { useEffect, useRef, useState } from 'react'
import RailIcon from './RailIcon'

/** Copy the saved source rather than text reconstructed from rendered elements. */
export default function CopyButton({
  text,
  label = 'Copy',
  icon = false,
}: {
  text: string
  label?: string
  icon?: boolean
}) {
  const [result, setResult] = useState<'copied' | 'error'>()
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const name = icon && result === 'error' ? 'Retry copy' : label
  return (
    <span className="copy-control">
      <button
        aria-label={name}
        title={icon ? name : undefined}
        className={icon ? 'copy-icon' : undefined}
        onClick={async () => {
          clearTimeout(timer.current)
          try {
            await navigator.clipboard.writeText(text)
            setResult('copied')
            timer.current = setTimeout(() => setResult(undefined), 2000)
          } catch {
            setResult('error')
          }
        }}
      >
        {icon ? (
          <RailIcon name={result === 'copied' ? 'finished' : 'copy'} size={14} />
        ) : result === 'copied' ? (
          'Copied'
        ) : result === 'error' ? (
          'Retry copy'
        ) : (
          label
        )}
      </button>
      {result === 'copied' && (
        <span role="status" className="copy-feedback">
          Copied
        </span>
      )}
      {result === 'error' && (
        <span role="alert">Clipboard unavailable. Retry copy or select and copy the text.</span>
      )}
    </span>
  )
}
