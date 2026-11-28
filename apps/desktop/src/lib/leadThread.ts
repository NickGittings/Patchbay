import { timelineOrder, type TimelineItem } from './simple'

/**
 * Chat's timeline when only the lead talks: the user's messages and the lead's replies from the
 * project folder's conversation, plus what the focused worktree's stages produced (narration,
 * plans, review and merge results), each tagged with the worktree it comes from. Other agents'
 * own replies stay in their terminals and the Agents view; the lead relays them.
 *
 * `leads` are the conversation's lead sessions: every agent that has led it, including the chat
 * agent the user picked before a team existed. With no focus elsewhere, `focus` is the conversation's own items.
 */
export function leadThread({
  conversation,
  focus,
  leads,
  earlierLeads = new Set(),
  focused,
  conversationLabel,
  focusLabel,
}: {
  conversation: readonly TimelineItem[]
  focus: readonly TimelineItem[]
  leads: ReadonlySet<string>
  /**
   * The focused worktree's own lead from before one lead per project: its conversation with the
   * user stays readable, tagged with the worktree, while that worktree is in focus.
   */
  earlierLeads?: ReadonlySet<string>
  /** The focus is another worktree than the conversation's. */
  focused: boolean
  conversationLabel: string
  focusLabel: string
}) {
  const chips = new Map<string, string>()
  const items: TimelineItem[] = []
  for (const item of conversation) {
    if (item.kind === 'agent') {
      // The user's own messages always stay, whoever received them.
      if (leads.has(item.sessionId) || item.entries.some((e) => e.kind === 'prompt'))
        items.push(item)
      continue
    }
    // Without a focus elsewhere these are the focus's too, added once below.
    if (focused && item.kind === 'line') {
      items.push(item)
      chips.set(item.id, conversationLabel)
    }
  }
  for (const item of focus) {
    if (item.kind === 'agent' && !(focused && earlierLeads.has(item.sessionId))) continue
    // The focused worktree's ids can repeat the conversation's (`plan`, `review`).
    const tagged = focused ? { ...item, id: `focus:${item.id}` } : item
    items.push(tagged)
    chips.set(tagged.id, focusLabel)
  }
  items.sort(timelineOrder)
  return { items, chips }
}
