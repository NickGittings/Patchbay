export interface ReplyMarker {
  id: string
  atMs: number
}
export function chatReplyId(reply: { sessionId: string; generation: number; sequence: number }) {
  return JSON.stringify([reply.sessionId, reply.generation, reply.sequence])
}
export interface ChatFollow {
  following: boolean
  unread: number
  sinceMs: number
  seen: Set<string>
}
export function initialFollow(replies: ReplyMarker[], now = Date.now()): ChatFollow {
  return { following: true, unread: 0, sinceMs: now, seen: new Set(replies.map((r) => r.id)) }
}
export function receiveReplies(state: ChatFollow, replies: ReplyMarker[]): ChatFollow {
  const fresh = replies.filter((r) => !state.seen.has(r.id) && r.atMs >= state.sinceMs)
  return {
    ...state,
    unread: state.following ? 0 : state.unread + fresh.length,
    seen: new Set([...state.seen, ...replies.map((r) => r.id)]),
  }
}
export function followScroll(state: ChatFollow, atBottom: boolean): ChatFollow {
  return { ...state, following: atBottom, unread: atBottom ? 0 : state.unread }
}
