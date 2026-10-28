/**
 * A worktree title for the toolbar, which truncates it to fit: its first sentence, with `…` when
 * anything was left out. `Fix trends graphs. When navigating…` → `Fix trends graphs…`. A sentence
 * ends at `.`, `!` or `?` before whitespace and a capital letter (or the end), so `e.g. caching`
 * and `U.S. tariffs` stay whole.
 */
export function shortTitle(title: string) {
  const [line, ...lines] = title.trim().split('\n')
  // Initialisms such as U.S. remain whole even before a capitalized word. Leading
  // punctuation isn't a sentence on its own.
  const end = [...line.matchAll(/[.!?]+\s+(?=\p{Lu})/gu)].find((match) => {
    const prefix = line.slice(0, match.index)
    return /[\p{L}\p{N}]/u.test(prefix) && !/(?:\b\p{L}\.)+\p{L}$/u.test(prefix)
  })
  const sentence = (end ? line.slice(0, end.index) : line.replace(/[.!?]+\s*$/, ''))
    .trim()
    .split(/\s+/)
    .join(' ')
  const first = sentence || line.trim()
  // Collapsed whitespace and closing punctuation leave nothing out; more sentences or lines do.
  return end || lines.some((l) => l.trim()) ? `${first}…` : first
}
