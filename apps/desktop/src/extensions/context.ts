import type { ContextSection, Project } from '../types'
let collector: ((project: Project, ids: string[]) => Promise<ContextSection[]>) | undefined
export function setContextCollector(fn: typeof collector) {
  collector = fn
}
export const extraContext = (project: Project, ids: string[]) =>
  collector?.(project, ids) ?? Promise.resolve([])
