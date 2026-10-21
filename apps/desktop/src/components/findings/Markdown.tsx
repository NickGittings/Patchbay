import { useMemo } from 'react'
import { parseBlocks, parseInline } from '../../lib/markdown'

function Inline({ text }: { text: string }) {
  return parseInline(text).map((run, i) =>
    run.kind === 'code' ? (
      <code key={i}>{run.text}</code>
    ) : run.kind === 'strong' ? (
      <strong key={i}>{run.text}</strong>
    ) : run.kind === 'em' ? (
      <em key={i}>{run.text}</em>
    ) : (
      run.text
    ),
  )
}

/** Agent-written Markdown, rendered as elements (never as HTML); `inline` renders one line. */
export default function Markdown({ text, inline }: { text: string; inline?: boolean }) {
  const blocks = useMemo(() => (inline ? [] : parseBlocks(text)), [text, inline])
  if (inline) return <Inline text={text} />
  return (
    <div className="markdown">
      {blocks.map((b, i) => {
        switch (b.kind) {
          case 'heading':
            return (
              <p key={i} className={`markdown-heading level-${Math.min(b.level, 4)}`}>
                <Inline text={b.text} />
              </p>
            )
          case 'paragraph':
            return (
              <p key={i}>
                <Inline text={b.text} />
              </p>
            )
          case 'quote':
            return (
              <blockquote key={i}>
                <Inline text={b.text} />
              </blockquote>
            )
          case 'code':
            return <pre key={i}>{b.text}</pre>
          case 'list': {
            const List = b.ordered ? 'ol' : 'ul'
            return (
              <List key={i}>
                {b.items.map((item, j) => (
                  <li key={j}>
                    <Inline text={item} />
                  </li>
                ))}
              </List>
            )
          }
        }
      })}
    </div>
  )
}
