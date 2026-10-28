/** Running session counts use a static status dot. */
export default function RunningTag({ count }: { count: number }) {
  if (count <= 0) return null
  return (
    <span className="worktree-tag running" title="Running sessions">
      <span className="status-dot" aria-hidden="true" />
      {count} running
    </span>
  )
}
