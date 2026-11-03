import { useId, type ReactNode } from 'react'
import Dialog from './Dialog'

export default function SettingsDialog({
  title,
  subtitle,
  behavior,
  onClose,
  children,
  footer,
}: {
  title: string
  subtitle: string
  behavior: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
}) {
  return (
    <Dialog
      title={title}
      subtitle={subtitle}
      onClose={onClose}
      className="settings-dialog"
      footer={footer}
    >
      <p className="settings-description">{behavior}</p>
      {children}
    </Dialog>
  )
}

export function SettingsSection({ title, children }: { title: string; children: ReactNode }) {
  const id = useId()
  return (
    <section className="settings-section" aria-labelledby={id}>
      <h3 id={id}>{title}</h3>
      {children}
    </section>
  )
}

export function SettingsFeedback({
  error = false,
  children,
}: {
  error?: boolean
  children: ReactNode
}) {
  return (
    <p className={`settings-feedback${error ? ' is-error' : ''}`} role={error ? 'alert' : 'status'}>
      {children}
    </p>
  )
}
