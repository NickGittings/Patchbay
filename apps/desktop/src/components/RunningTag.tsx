/** Running session counts use the same status dot as terminal rows. */
export default function RunningTag({ count }: { count: number }) {
  if (count <= 0) return null
  return (
    <span className="worktree-tag running health-running" title="Running sessions">
      <span className="status-dot" aria-hidden="true" />
      {count} running
    </span>
  )
}
