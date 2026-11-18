/** Shared feedback for an asynchronous panel request. */
export default function PanelStatus({
  kind,
  message,
  details,
  onRetry,
  compact = false,
}: {
  kind: 'loading' | 'error'
  message: string
  details?: string
  onRetry?: () => void
  /** Inside a list or popover: no panel padding. */
  compact?: boolean
}) {
  return (
    <div className={compact ? 'panel-status compact' : 'panel-status'} data-kind={kind}>
      <p role={kind === 'error' ? 'alert' : 'status'}>{message}</p>
      {onRetry && <button onClick={onRetry}>Retry</button>}
      {details && (
        <details>
          <summary>Technical details</summary>
          <pre>{details}</pre>
        </details>
      )}
    </div>
  )
}
