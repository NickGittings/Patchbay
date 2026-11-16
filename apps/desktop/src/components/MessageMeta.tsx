import CopyButton from './CopyButton'

export default function MessageMeta({ atMs, text }: { atMs: number; text: string }) {
  const date = new Date(atMs)
  return (
    <div className="message-meta">
      <time dateTime={date.toISOString()} title={date.toLocaleString()}>
        {date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
      </time>
      <CopyButton text={text} label="Copy message" />
    </div>
  )
}
