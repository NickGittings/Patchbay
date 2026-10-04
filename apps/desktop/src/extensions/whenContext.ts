import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { listDir } from '../lib/ipc'
import type { Component, CommandContribution } from '../types'
import { evaluateWhen, type WhenContext } from './when'

export function useWhenContext(componentId?: string | null, refreshKey?: unknown): WhenContext {
  const nodes = useStore((s) => s.nodes)
  const view = useStore((s) => s.view)
  const selected = useStore((s) => s.selectedId)
  const project = useStore((s) => s.project)
  const menus = useStore((s) => s.menus)
  const commands = useStore((s) => s.commands)
  const id = componentId === undefined ? selected : componentId
  const node = nodes.find((n) => n.id === id)
  const component: Component | null = node
    ? { id: node.id, ...node.data, position: node.position }
    : null
  const [fileState, setFileState] = useState<{ key: string; files: Set<string> }>({
    key: '',
    files: new Set(),
  })
  const path = component?.path
  const key = `${project?.root ?? ''}/${id ?? ''}/${path ?? ''}`
  useEffect(() => {
    let live = true
    if (!path || !project) return
    const clauses = [
      ...commands.map((c) => c.when),
      ...Object.values(menus)
        .flat()
        .map((m) => m.when),
    ]
      .filter(Boolean)
      .join(' ')
    const requested = [...clauses.matchAll(/component\.hasFile\(['"]([^'"]+)['"]\)/g)].map(
      (m) => m[1],
    )
    const folders = new Set([
      '',
      ...requested.map((f) => (f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '')),
    ])
    void Promise.all(
      [...folders].map(async (folder) => {
        const entries = await listDir(`${path}/${folder}`).catch(() => [])
        return entries.filter((e) => !e.isDir).map((e) => (folder ? `${folder}/${e.name}` : e.name))
      }),
    ).then((sets) => {
      if (live) setFileState({ key, files: new Set(sets.flat()) })
    })
    return () => {
      live = false
    }
  }, [path, key, project, commands, menus, refreshKey])
  return { component, files: fileState.key === key ? fileState.files : new Set(), view }
}
export function commandVisible(command: CommandContribution, context: WhenContext): boolean {
  if (command.run && !context.component) return false
  if (!evaluateWhen(command.when, context)) return false
  const placements = Object.values(useStore.getState().menus)
    .flat()
    .filter((m) => m.command === command.id)
  return !placements.length || placements.some((m) => evaluateWhen(m.when, context))
}
