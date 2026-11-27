import { useLayoutEffect, useRef, useState } from 'react'
import { followScroll, initialFollow, receiveReplies, type ReplyMarker } from './chatNavigation'

export function useChatFollow(
  scope: string,
  boundary: string,
  replies: ReplyMarker[],
  contentKey: string,
) {
  const threadRef = useRef<HTMLDivElement>(null)
  const [state, setState] = useState(() => initialFollow(replies))
  const anchor = useRef<{ id: string; offset: number }>(undefined)
  const current = useRef(state)
  const repliesKey = JSON.stringify(replies)
  const previous = useRef<{
    scope: string
    boundary: string
    repliesKey: string
    contentKey: string
  }>(undefined)
  // True from a Jump to latest until the smooth scroll lands or the reader takes over, so the
  // scroll events on the way down don't count as the reader leaving the bottom.
  const jumping = useRef(false)
  const update = (next: typeof state) => {
    current.current = next
    setState(next)
  }
  const jump = () => {
    anchor.current = undefined
    update(followScroll(current.current, true))
    const el = threadRef.current
    if (!el) return
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    jumping.current = !reduced
    el.scrollTo({ top: el.scrollHeight, behavior: reduced ? 'auto' : 'smooth' })
  }
  useLayoutEffect(() => {
    const el = threadRef.current
    if (!el) return
    const takeOver = () => {
      jumping.current = false
    }
    el.addEventListener('wheel', takeOver, { passive: true })
    el.addEventListener('pointerdown', takeOver)
    el.addEventListener('keydown', takeOver)
    return () => {
      el.removeEventListener('wheel', takeOver)
      el.removeEventListener('pointerdown', takeOver)
      el.removeEventListener('keydown', takeOver)
    }
  }, [])
  // Layout effects keep the bottom in place before the browser paints a new reply or scope.
  useLayoutEffect(() => {
    const last = previous.current
    // Callers may rebuild the marker array on every render; only changed content needs layout.
    if (
      last?.scope === scope &&
      last.boundary === boundary &&
      last.repliesKey === repliesKey &&
      last.contentKey === contentKey
    )
      return
    const changed = last?.scope !== scope || last.boundary !== boundary
    previous.current = { scope, boundary, repliesKey, contentKey }
    update(changed ? initialFollow(replies) : receiveReplies(current.current, replies))
    const el = threadRef.current
    if (current.current.following) {
      anchor.current = undefined
      el?.scrollTo({ top: el.scrollHeight })
    } else if (el && anchor.current) {
      const saved = anchor.current
      const entry = [...el.querySelectorAll<HTMLElement>('[data-chat-entry]')].find(
        (item) => item.dataset.chatEntry === saved.id,
      )
      if (entry) {
        // A new workflow stage may have folded the section the reader was viewing.
        const section = entry.closest<HTMLDetailsElement>('details.simple-section')
        if (section) section.open = true
        el.scrollTop +=
          entry.getBoundingClientRect().top - el.getBoundingClientRect().top - saved.offset
      }
    }
  })
  useLayoutEffect(() => {
    const el = threadRef.current
    if (!el) return
    let frame = 0
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (current.current.following) el.scrollTop = el.scrollHeight
      })
    })
    // Observe content changes (disclosures and drawer resizing) as well as panel resizing.
    observer.observe(el)
    for (const child of el.children) observer.observe(child)
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [contentKey])
  return {
    threadRef,
    following: state.following,
    unread: state.unread,
    jump,
    onScroll: () => {
      const el = threadRef.current
      if (!el) return
      const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 70
      if (jumping.current) {
        if (!bottom) return
        jumping.current = false
      }
      if (bottom) anchor.current = undefined
      else {
        const top = el.getBoundingClientRect().top
        const entry = [...el.querySelectorAll<HTMLElement>('[data-chat-entry]')].find(
          (item) => item.getBoundingClientRect().bottom > top,
        )
        if (entry)
          anchor.current = {
            id: entry.dataset.chatEntry!,
            offset: entry.getBoundingClientRect().top - top,
          }
      }
      update(followScroll(current.current, bottom))
    },
  }
}
