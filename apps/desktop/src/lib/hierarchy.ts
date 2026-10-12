import type { FlowNode } from '../store'

export function matchesComponent(node: Pick<FlowNode, 'data'>, query: string): boolean {
  const needle = query.trim().toLowerCase()
  return [node.data.name, node.data.path, node.data.kind].some((value) =>
    value.toLowerCase().includes(needle),
  )
}
