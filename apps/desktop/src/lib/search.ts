/** The part of a search result the default selection reads. */
interface Result {
  title: string
  group: string
  /** An agent of the open project that the query names. */
  preferred?: boolean
}

/**
 * The result Enter runs before the user picks one: a component named exactly what was typed
 * (ignoring case and surrounding spaces), else in Files mode an agent the query names, else the
 * first of the `priority` group, else, once that group is known to be empty (`pending` false), the
 * first agent; -1 for none. Components and agents are known at once, so file results arriving late
 * can't change what Enter does. Files mode never falls back to a command or a component.
 */
export function defaultSelection(
  items: Result[],
  priority: string,
  query: string,
  pending = false,
): number {
  const typed = query.trim().toLowerCase()
  const exact = typed
    ? items.findIndex((i) => i.group === 'Components' && i.title.trim().toLowerCase() === typed)
    : -1
  if (exact >= 0) return exact
  const agent =
    priority === 'Files' ? items.findIndex((i) => i.group === 'Agents' && i.preferred) : -1
  if (agent >= 0) return agent
  const first = items.findIndex((i) => i.group === priority)
  return first >= 0 || pending ? first : items.findIndex((i) => i.group === 'Agents')
}
