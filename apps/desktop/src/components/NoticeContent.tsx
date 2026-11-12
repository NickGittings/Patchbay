import type { ReactNode } from 'react'
import { noticeHeadings, type NoticeKind } from '../lib/notificationHistory'
import RailIcon from './RailIcon'

export default function NoticeContent({
  kind,
  heading,
  children,
}: {
  kind: NoticeKind
  heading?: string
  children: ReactNode
}) {
  return (
    <div className="notice-content" data-kind={kind}>
      <span className="notice-icon">
        <RailIcon name={kind} />
      </span>
      <div className="notice-copy">
        <strong className="notice-heading">{heading ?? noticeHeadings[kind]}</strong>
        {children}
      </div>
    </div>
  )
}
