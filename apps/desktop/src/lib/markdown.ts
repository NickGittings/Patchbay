/** A deliberately small Markdown subset, rendered without raw HTML. */
export type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'plain'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'code'; text: string }
  | { kind: 'quote'; text: string }
  | { kind: 'table'; header: string[]; rows: string[][] }

export type Inline =
  | { kind: 'text' | 'code' | 'strong' | 'em'; text: string }
  | { kind: 'link'; text: string; href: string }

const LIST_ITEM = /^(\s*)(?:([-+*])|(\d+)[.)])\s+(.*)$/
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const FENCE = /^ {0,3}(`{3,}|~{3,})[^`]*$/

/** Only explicit, valid web URLs may reach the desktop opener. */
export function webLink(value: string): string | undefined {
  if (
    !/^https?:\/\//i.test(value) ||
    /[\s<>]/.test(value) ||
    [...value].some((char) => char.charCodeAt(0) < 32)
  )
    return
  try {
    const url = new URL(value)
    if (url.hostname && !url.username && !url.password) return value
  } catch {
    // Malformed links remain ordinary text.
  }
}

function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|$/, '')
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, '|'))
}
function tableAt(lines: string[], i: number): boolean {
  if (!lines[i]?.includes('|') || !lines[i + 1]?.includes('|')) return false
  const header = cells(lines[i]),
    separator = cells(lines[i + 1])
  return (
    header.length > 1 &&
    separator.length === header.length &&
    separator.every((cell) => /^:?-{3,}:?$/.test(cell))
  )
}

export function parseBlocks(text: string): Block[] {
  const blocks: Block[] = []
  // Retain code bytes, including CRLF and the final newline before the closing fence.
  const sourceLines = text.match(/[^\n]*\n|[^\n]+$/g) ?? []
  const lines = sourceLines.map((line) => line.replace(/\r?\n$/, ''))
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim() || /^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      i++
      continue
    }
    const fence = FENCE.exec(line)
    if (fence) {
      let end = i + 1
      const close = new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}\\s*$`)
      while (end < lines.length && !close.test(lines[end])) end++
      if (end === lines.length) {
        blocks.push({ kind: 'plain', text: sourceLines.slice(i).join('') })
        break
      }
      blocks.push({ kind: 'code', text: sourceLines.slice(i + 1, end).join('') })
      i = end + 1
      continue
    }
    if (tableAt(lines, i)) {
      const header = cells(line),
        rows: string[][] = []
      let end = i + 2
      while (end < lines.length && lines[end].includes('|') && lines[end].trim()) {
        rows.push(cells(lines[end++]))
      }
      if (rows.every((row) => row.length === header.length))
        blocks.push({ kind: 'table', header, rows })
      else blocks.push({ kind: 'plain', text: lines.slice(i, end).join('\n') })
      i = end
      continue
    }
    if (line.trimStart().startsWith('|')) {
      const rows: string[] = []
      while (i < lines.length && lines[i].trimStart().startsWith('|')) rows.push(lines[i++])
      blocks.push({ kind: 'plain', text: rows.join('\n') })
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2] })
      i++
      continue
    }
    if (line.trimStart().startsWith('>')) {
      const quote: string[] = []
      while (i < lines.length && lines[i].trimStart().startsWith('>'))
        quote.push(lines[i++].trimStart().replace(/^>\s?/, ''))
      blocks.push({ kind: 'quote', text: quote.join(' ') })
      continue
    }
    const item = LIST_ITEM.exec(line)
    if (item) {
      const ordered = !!item[3],
        items: string[] = []
      while (i < lines.length) {
        const next = LIST_ITEM.exec(lines[i])
        if (next && next[1].length <= item[1].length && !!next[3] === ordered) items.push(next[4])
        else if (lines[i].trim() && /^\s/.test(lines[i]) && items.length)
          items[items.length - 1] += ` ${lines[i].trim().replace(LIST_ITEM, '$4')}`
        else break
        i++
      }
      blocks.push({ kind: 'list', ordered, items })
      continue
    }
    const paragraph = [lines[i++].trim()]
    while (
      i < lines.length &&
      lines[i].trim() &&
      !FENCE.test(lines[i]) &&
      !HEADING.test(lines[i]) &&
      !LIST_ITEM.test(lines[i]) &&
      !/^\s*[|>]/.test(lines[i]) &&
      !tableAt(lines, i)
    )
      paragraph.push(lines[i++].trim())
    blocks.push({ kind: 'paragraph', text: paragraph.join(' ') })
  }
  return blocks
}

export function parseInline(text: string): Inline[] {
  const out: Inline[] = []
  const pattern =
    /(`+)(.+?)\1|\*\*(.+?)\*\*|\*([^*\s][^*]*?)\*|\[([^\]]+)\]\(([^\s()]*(?:\([^\s()]*\)[^\s()]*)*)\)/g
  let last = 0
  for (const m of text.matchAll(pattern)) {
    if (m.index > last) out.push({ kind: 'text', text: text.slice(last, m.index) })
    if (m[2] !== undefined) out.push({ kind: 'code', text: m[2].trim() })
    else if (m[3] !== undefined) out.push({ kind: 'strong', text: m[3] })
    else if (m[4] !== undefined) out.push({ kind: 'em', text: m[4] })
    else {
      const href = webLink(m[6])
      out.push(href ? { kind: 'link', text: m[5], href } : { kind: 'text', text: m[0] })
    }
    last = m.index + m[0].length
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) })
  return out
}
