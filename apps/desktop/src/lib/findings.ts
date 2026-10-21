import type { Severity } from '../types'

/** A `path:line` a finding points at, as the reviewer wrote it (relative to its worktree). */
export interface FileRef {
  path: string
  line?: number
  endLine?: number
}

export interface Finding {
  severity: Severity
  title: string
  /** The Markdown under the tagged line, up to the next finding or section. */
  body: string
  refs: FileRef[]
}

/** One reviewer's findings; `reviewer` is null for a single reviewer's file. */
export interface FindingsSection {
  reviewer: string | null
  /** Markdown before the first finding, without the Verdict and Counts lines. */
  intro: string
  items: Finding[]
}

const REVIEWER = /^##\s+Reviewer:\s*(.+?)\s*$/
// List markers, numbers, checkboxes, heading marks and emphasis before a `[severity]` tag. Runs
// of `#` or emphasis each match whole (the lookaheads), so a long rule line can't backtrack.
const TAGGED =
  /^\s*(?:#+(?!#)\s*|[-+*]\s+|\d+[.)]\s*|\[[ xX]\]\s*|[*_`]+(?![*_`]))*\[(critical|high|medium|low)\][*_`]*\s*(?:[:—–-]\s*)?(.*)$/i
const LEGEND =
  /^#+\s*[*_`]*(?:.*\blegend|severities|severity levels|severity definitions)[*_`:]*\s*$/i
const FENCE = /^\s*(`{3,}|~{3,})/

/**
 * The open fence after `line`, given the one open before it (null outside code). A fence closes
 * only on a run of its own character at least as long, so a ``` inside a ~~~ block stays code.
 */
function fenceAfter(line: string, open: string | null): string | null {
  const m = FENCE.exec(line)
  if (!m) return open
  if (!open) return m[1]
  return m[1][0] === open[0] && m[1].length >= open.length && !line.trim().slice(m[1].length).trim()
    ? null
    : open
}
// `src/a.ts:12`, `crates/x/y.rs:3-9`, `Foo.tsx:7:3`; the path needs an extension or a slash.
const REF =
  /(?:^|[\s(`'"[])((?:[\w.@-]+\/)*[\w@-][\w.@-]*\.[A-Za-z][\w]*|(?:[\w.@-]+\/)+[\w.@-]+):(\d+)(?:[-–](\d+))?/g

/** Whether a line only lists severity tags, which describes the scheme rather than a finding. */
function bareTags(rest: string) {
  return rest
    .split(/[\s,|/]+/)
    .every((w) => ['', 'and', 'or'].includes(w.replace(/[*`_]/g, '')) || /^\[\w+\]$/.test(w))
}

/** Unwrap emphasis that wrapped the tag together with the title, as in `**[high] Title**`. */
function cleanTitle(rest: string) {
  let title = rest.trim()
  if ((title.match(/\*\*/g)?.length ?? 0) % 2 === 1)
    title = title.endsWith('**') ? title.slice(0, -2) : title.replace('**', '')
  return title.replace(/^\*\*(.*)\*\*$/, '$1').trim()
}

function metaLine(line: string) {
  const plain = line
    .replace(/[*`_]/g, '')
    .replace(/^\s*#*\s*/, '')
    .toLowerCase()
  return /^(verdict|counts)\s*:/.test(plain)
}

/** Every distinct file reference in `text`, in order of appearance. */
export function fileRefs(text: string): FileRef[] {
  const refs: FileRef[] = []
  for (const m of text.matchAll(REF)) {
    const path = m[1].replace(/^\.\//, '')
    if (/^https?$/.test(path) || /^\d+(\.\d+)*$/.test(path)) continue
    const ref: FileRef = { path, line: Number(m[2]) }
    if (m[3]) ref.endLine = Number(m[3])
    if (!refs.some((r) => r.path === ref.path && r.line === ref.line)) refs.push(ref)
  }
  return refs
}

function trimBlank(lines: string[]) {
  return lines
    .join('\n')
    .replace(/^\s*\n/, '')
    .trimEnd()
}

function parseSection(reviewer: string | null, lines: string[]): FindingsSection {
  const intro: string[] = []
  const items: { severity: Severity; title: string; body: string[] }[] = []
  let fence: string | null = null
  let legend = false
  for (const line of lines) {
    const before = fence
    fence = fenceAfter(line, fence)
    const current = items.at(-1)
    if (!before && !fence) {
      if (/^\s*#/.test(line)) legend = LEGEND.test(line.trim()) && !/\[\w+\]/.test(line)
      const tagged = legend ? null : TAGGED.exec(line)
      if (tagged && !bareTags(tagged[2]) && tagged[2].trim()) {
        items.push({
          severity: tagged[1].toLowerCase() as Severity,
          title: cleanTitle(tagged[2]),
          body: [],
        })
        continue
      }
      if (!current && metaLine(line)) continue
    }
    if (current) current.body.push(line)
    else intro.push(line)
  }
  return {
    reviewer,
    intro: trimBlank(intro),
    items: items.map((f) => {
      const body = trimBlank(f.body)
      return { severity: f.severity, title: f.title, body, refs: fileRefs(`${f.title}\n${body}`) }
    }),
  }
}

/**
 * Split a review's findings text into reviewers and severity-tagged findings. It follows the
 * briefing's shape (Verdict and Counts lines, `[severity]`-tagged findings, a `## Reviewer:`
 * heading per reviewer when several are combined) leniently; counts come from the backend's
 * verdict, so this only needs to be good enough to display. Text without tagged findings yields
 * sections with no items, shown as plain Markdown.
 */
export function parseFindings(text: string): FindingsSection[] {
  const sections: FindingsSection[] = []
  let reviewer: string | null = null
  let lines: string[] = []
  let fence: string | null = null
  const all = text.replace(/^﻿/, '').split(/\r?\n/)
  // The backend combines reviewers by starting each with this heading after a blank line, so in
  // combined text those headings split even where a reviewer left a code fence open.
  const combined = REVIEWER.test(all[0] ?? '')
  for (const [i, line] of all.entries()) {
    const separator = combined && (i === 0 || !all[i - 1].trim()) && REVIEWER.test(line)
    const heading: RegExpExecArray | null = separator || !fence ? REVIEWER.exec(line) : null
    fence = heading ? null : fenceAfter(line, fence)
    if (heading) {
      if (reviewer !== null || lines.some((l) => l.trim()))
        sections.push(parseSection(reviewer, lines))
      reviewer = heading[1]
      lines = []
    } else lines.push(line)
  }
  sections.push(parseSection(reviewer, lines))
  return sections
}

/** How many parsed findings carry each severity. */
export function severityCounts(sections: FindingsSection[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 }
  for (const s of sections) for (const f of s.items) counts[f.severity]++
  return counts
}
