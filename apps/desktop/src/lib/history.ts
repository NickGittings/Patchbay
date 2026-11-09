import { componentPaths } from './git'
import { gitHistory } from './ipc'

export interface HistoryCommit {
  hash: string
  parents: string[]
  author: string
  timestamp: number
  message: string
  refs: string
}
export interface HistoryPage {
  commits: HistoryCommit[]
  head: string
  more: boolean
}
export interface HistorySelection {
  repo: string
  path?: string
  commit: HistoryCommit
}

export function historyRequest<T>(
  worktree?: string,
  repo?: string,
  limit?: number,
  commit?: string,
  path?: string,
) {
  return gitHistory<T>(componentPaths(), worktree, repo, limit, commit, path)
}

/** Keep pending parent lanes between rows, including parents beyond the loaded page. */
export function graphRows(commits: HistoryCommit[]) {
  let lanes: string[] = []
  return commits.map((commit) => {
    if (!lanes.includes(commit.hash)) lanes.push(commit.hash)
    const before = [...lanes]
    const lane = lanes.indexOf(commit.hash)
    lanes.splice(lane, 1)
    commit.parents.forEach((parent, i) => {
      if (!lanes.includes(parent)) lanes.splice(Math.min(lane + i, lanes.length), 0, parent)
    })
    return { lane, before, after: [...lanes], parents: commit.parents }
  })
}
