import { useMemo, useState } from 'react'
import { openUrl } from '@tauri-apps/plugin-opener'
import CopyButton from '../CopyButton'
import { webLink, parseBlocks, parseInline } from '../../lib/markdown'
import './markdown.css'

function WebLink({ href, text }: { href: string; text: string }) {
  const [error, setError] = useState(false)
  return (
    <>
      <a
        href={href}
        onClick={(event) => {
          event.preventDefault()
          if (webLink(href))
            void openUrl(href).then(
              () => setError(false),
              () => setError(true),
            )
        }}
      >
        {text}
      </a>
      {error && <span role="alert">Couldn’t open link. Try again or copy the URL.</span>}
    </>
  )
}

function Inline({ text }: { text: string }) {
  return parseInline(text).map((run, i) =>
    run.kind === 'link' ? (
      <WebLink key={i} href={run.href} text={run.text} />
    ) : run.kind === 'code' ? (
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
          case 'plain':
            return (
              <p key={i} className="markdown-plain">
                {b.text}
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
            return (
              <div className="markdown-code" key={i}>
                <CopyButton text={b.text} label="Copy code" />
                <pre>
                  <code>{b.text}</code>
                </pre>
              </div>
            )
          case 'table':
            return (
              <div
                className="markdown-table"
                key={i}
                tabIndex={0}
                role="region"
                aria-label="Markdown table"
              >
                <table>
                  <thead>
                    <tr>
                      {b.header.map((cell, j) => (
                        <th scope="col" key={j}>
                          <Inline text={cell} />
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((row, j) => (
                      <tr key={j}>
                        {row.map((cell, k) => (
                          <td key={k}>
                            <Inline text={cell} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
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
