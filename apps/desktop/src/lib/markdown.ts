/** A block of the small Markdown subset agents write findings in. */
export type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'code'; text: string }
  | { kind: 'quote'; text: string }

/** An inline run: plain text, `code`, **strong** or *emphasis*. */
export type Inline = { kind: 'text' | 'code' | 'strong' | 'em'; text: string }

const LIST_ITEM = /^(\s*)(?:([-+*])|(\d+)[.)])\s+(.*)$/
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const FENCE = /^\s*(```|~~~)/

/**
 * Parse Markdown into blocks: headings, paragraphs, flat lists (continuation and nested lines
 * join their item), fenced code, quotes; tables and anything else stay preformatted as code so
 * columns keep their alignment.
 */
export function parseBlocks(text: string): Block[] {
  const blocks: Block[] = []
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim() || /^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      i++
      continue
    }
    const fence = FENCE.exec(line)
    if (fence) {
      const body: string[] = []
      i++
      while (i < lines.length && !lines[i].trimStart().startsWith(fence[1])) body.push(lines[i++])
      i++
      blocks.push({ kind: 'code', text: body.join('\n') })
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2] })
      i++
      continue
    }
    if (line.trimStart().startsWith('|')) {
      const rows: string[] = []
      while (i < lines.length && lines[i].trimStart().startsWith('|')) rows.push(lines[i++].trim())
      blocks.push({ kind: 'code', text: rows.join('\n') })
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
      const ordered = !!item[3]
      const items: string[] = []
      while (i < lines.length) {
        const next = LIST_ITEM.exec(lines[i])
        if (next && next[1].length <= item[1].length && !!next[3] === ordered) {
          items.push(next[4])
        } else if (lines[i].trim() && /^\s/.test(lines[i]) && items.length) {
          items[items.length - 1] += ` ${lines[i].trim().replace(LIST_ITEM, '$4')}`
        } else break
        i++
      }
      blocks.push({ kind: 'list', ordered, items })
      continue
    }
    const paragraph: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() &&
      !FENCE.test(lines[i]) &&
      !HEADING.test(lines[i]) &&
      !LIST_ITEM.test(lines[i]) &&
      !/^\s*[|>]/.test(lines[i])
    )
      paragraph.push(lines[i++].trim())
    blocks.push({ kind: 'paragraph', text: paragraph.join(' ') })
  }
  return blocks
}

/** Split a line into code spans, strong and emphasis (`*` only, so snake_case stays intact). */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = []
  const pattern = /(`+)(.+?)\1|\*\*(.+?)\*\*|__(.+?)__|\*([^*\s][^*]*?)\*|\[([^\]]+)\]\(([^)]+)\)/g
  let last = 0
  for (const m of text.matchAll(pattern)) {
    if (m.index > last) out.push({ kind: 'text', text: text.slice(last, m.index) })
    if (m[2] !== undefined) out.push({ kind: 'code', text: m[2].trim() })
    else if (m[3] !== undefined || m[4] !== undefined)
      out.push({ kind: 'strong', text: m[3] ?? m[4] })
    else if (m[5] !== undefined) out.push({ kind: 'em', text: m[5] })
    // Links show their text; the webview never navigates away.
    else out.push({ kind: 'text', text: m[6] })
    last = m.index + m[0].length
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) })
  return out
}
