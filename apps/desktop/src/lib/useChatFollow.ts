import { useLayoutEffect, useRef, useState } from 'react'
import { followScroll, initialFollow, receiveReplies, type ReplyMarker } from './chatNavigation'

export function useChatFollow(
  scope: string,
  boundary: string,
  repliesKey: string,
  contentKey: string,
) {
  const threadRef = useRef<HTMLDivElement>(null)
  const [state, setState] = useState(() => initialFollow(JSON.parse(repliesKey) as ReplyMarker[]))
  const anchor = useRef<{ id: string; offset: number }>(undefined)
  const current = useRef(state)
  const previousScope = useRef({ scope, boundary })
  const update = (next: typeof state) => {
    current.current = next
    setState(next)
  }
  const jump = () => {
    anchor.current = undefined
    update(followScroll(current.current, true))
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight })
  }
  // Layout effects keep the bottom in place before the browser paints a new reply or scope.
  useLayoutEffect(() => {
    const changed =
      previousScope.current.scope !== scope || previousScope.current.boundary !== boundary
    previousScope.current = { scope, boundary }
    const replies = JSON.parse(repliesKey) as ReplyMarker[]
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
  }, [scope, boundary, contentKey, repliesKey])
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
