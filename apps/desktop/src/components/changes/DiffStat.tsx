/** `+12 −3`, omitting a zero side unless both are zero. */
export default function DiffStat({
  added,
  removed,
  bar = false,
}: {
  added: number | undefined
  removed: number | undefined
  /** Also draw five GitHub-style blocks split by the ratio. */
  bar?: boolean
}) {
  if (added === undefined && removed === undefined) return null
  const a = added ?? 0
  const r = removed ?? 0
  const total = a + r
  const green = total ? Math.round((5 * a) / total) : 0
  const red = total ? Math.min(5 - green, Math.max(r ? 1 : 0, Math.round((5 * r) / total))) : 0
  return (
    <span className="diff-stat">
      {(a > 0 || !r) && <span className="stat-add">+{a}</span>}
      {r > 0 && <span className="stat-del">−{r}</span>}
      {bar && (
        <span className="stat-bar" aria-hidden>
          {Array.from({ length: 5 }, (_, i) => (
            <span key={i} className={i < green ? 'add' : i < green + red ? 'del' : ''} />
          ))}
        </span>
      )}
    </span>
  )
}
