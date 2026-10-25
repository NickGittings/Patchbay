/** The part of a search result the default selection reads. */
interface Result {
  title: string
  group: string
}

/**
 * The result Enter runs before the user picks one: a component named exactly what was typed
 * (ignoring case and surrounding spaces), else the first of the `priority` group; -1 for none.
 * Never another group's, so Files mode falls back to neither a command nor a component, and file
 * results arriving late can't change what Enter does (components are known at once).
 */
export function defaultSelection(items: Result[], priority: string, query: string): number {
  const typed = query.trim().toLowerCase()
  const exact = typed
    ? items.findIndex((i) => i.group === 'Components' && i.title.trim().toLowerCase() === typed)
    : -1
  return exact >= 0 ? exact : items.findIndex((i) => i.group === priority)
}
