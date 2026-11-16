/** Keyboard actions for a component popup; composition and modifier handling stay at the input. */
export function mentionKey(key: string, index: number, count: number) {
  if (!count) return
  if (key === 'Escape') return { index, dismissed: true }
  if (key === 'ArrowDown') return { index: (index + 1) % count, dismissed: false }
  if (key === 'ArrowUp') return { index: (index + count - 1) % count, dismissed: false }
}
