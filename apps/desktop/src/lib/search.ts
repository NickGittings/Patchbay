/** The part of a search result the default selection reads. */
interface Result {
  title: string
  group: string
}

/**
 * The result Enter runs before the user picks one: a component named exactly what was typed
 * (ignoring case and surrounding spaces), else the first of the `priority` group, else the first
 * component. Never another group's, so Files mode doesn't fall back to a command; -1 for none.
 */
export function defaultSelection(items: Result[], priority: string, query: string): number {
  const typed = query.trim().toLowerCase()
  const exact = typed
    ? items.findIndex((i) => i.group === 'Components' && i.title.trim().toLowerCase() === typed)
    : -1
  if (exact >= 0) return exact
  const first = items.findIndex((i) => i.group === priority)
  return first >= 0 ? first : items.findIndex((i) => i.group === 'Components')
}
