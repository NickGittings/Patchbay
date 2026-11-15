import { useId, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes } from 'react'
import { createPortal } from 'react-dom'

/** A rail button with an immediate tooltip outside the rail's scrolling/clipping area. */
export default function RailTooltip({
  tooltip,
  shortcut,
  children,
  onClick,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { tooltip: string; shortcut?: string }) {
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const tip = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ left: 56, top: 8 })
  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      if (!trigger.current || !tip.current) return
      const anchor = trigger.current.getBoundingClientRect()
      const box = tip.current.getBoundingClientRect()
      setPosition({
        left: Math.max(8, Math.min(anchor.right + 10, window.innerWidth - box.width - 8)),
        top: Math.max(
          8,
          Math.min(
            anchor.top + (anchor.height - box.height) / 2,
            window.innerHeight - box.height - 8,
          ),
        ),
      })
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
        event.stopPropagation()
      }
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    window.addEventListener('keydown', escape, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('keydown', escape, true)
    }
  }, [open, tooltip, shortcut])
  return (
    <>
      <button
        {...props}
        ref={trigger}
        aria-describedby={open ? id : undefined}
        onPointerEnter={() => setOpen(true)}
        onPointerLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={(event) => {
          setOpen(false)
          onClick?.(event)
        }}
      >
        {children}
      </button>
      {open &&
        createPortal(
          <div id={id} ref={tip} role="tooltip" className="rail-tooltip" style={position}>
            <span>{tooltip}</span>
            {shortcut && <kbd>{shortcut}</kbd>}
          </div>,
          document.body,
        )}
    </>
  )
}
