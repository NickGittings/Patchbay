import { useState } from 'react'
import { useStore } from '../store'
import type { SessionRecord, UserQuestion } from '../types'
import type { ChatInputRequest } from '../lib/chat'
import {
  answerQuestion,
  composeAnswers,
  OTHER,
  pendingQuestion,
  useAgentQuestions,
  type QuestionChoice,
} from '../lib/agentQuestions'
import TerminalPane from './TerminalPane'

/**
 * An agent's input request. A question its hook offered to Chat is answered here and handed
 * back through the hook; anything else is answered in the agent's own terminal. Native input
 * stays in its originating PTY: never synthesize menu/approval keystrokes.
 */
export default function ChatQuestion({
  record,
  request,
}: {
  record: SessionRecord
  request: ChatInputRequest
}) {
  const session = useStore((s) => s.sessions[record.id])
  const pending = useAgentQuestions((s) =>
    pendingQuestion(s.pending, record.id, session?.generation),
  )
  const questions = pending?.questions ?? request.questions ?? []
  const [choices, setChoices] = useState<(QuestionChoice | undefined)[]>([])
  const [sent, setSent] = useState<'chat' | 'terminal' | 'failed'>()
  const [terminalOpen, setTerminalOpen] = useState(false)
  const answers = composeAnswers(questions, choices)
  const answerable = !!pending && !sent && questions.length > 0
  const name = record.metadata.name

  const choose = (index: number, choice: QuestionChoice) =>
    setChoices((all) => {
      const next = [...all]
      next[index] = choice
      return next
    })
  const send = async (value: string[] | null) => {
    if (!pending) return
    const ok = await answerQuestion(pending.id, value)
    setSent(ok ? (value ? 'chat' : 'terminal') : 'failed')
    if (!ok || !value) setTerminalOpen(true)
  }

  return (
    <section className="chat-question" aria-label={`${name} needs your input`}>
      <p className="chat-question-title">
        <strong>{name} needs your input</strong>
        {!questions.length && <>: {session?.status?.agent?.message ?? 'Open to respond'}</>}
      </p>
      {questions.map((question, index) => (
        <QuestionField
          key={index}
          group={`chat-question-${record.id}-${request.generation}-${index}`}
          question={question}
          choice={choices[index]}
          disabled={!answerable}
          onChange={(choice) => choose(index, choice)}
        />
      ))}
      {answerable ? (
        <div className="chat-question-actions">
          <button className="primary" disabled={!answers} onClick={() => void send(answers)}>
            Send answer
          </button>
          <button onClick={() => void send(null)}>Answer in terminal</button>
        </div>
      ) : (
        <p className="chat-question-note" role="status">
          {sent === 'chat'
            ? `Answer sent to ${name}.`
            : sent === 'failed'
              ? `${name} stopped waiting for a Chat answer. Respond in its terminal below.`
              : `Respond directly to ${name} in its terminal below.`}
        </p>
      )}
      {sent !== 'chat' && (
        <details open={terminalOpen} onToggle={(e) => setTerminalOpen(e.currentTarget.open)}>
          <summary>Agent terminal</summary>
          {terminalOpen && (
            <div className="simple-terminal-drawer">
              <TerminalPane
                componentId={record.metadata.componentId}
                terminal={{
                  id: record.metadata.terminalId,
                  name,
                  kind: 'agent',
                  command: record.spec.command,
                }}
                task={record.metadata.task ?? null}
                existingSessionId={record.id}
                focus={false}
              />
            </div>
          )}
        </details>
      )}
    </section>
  )
}

function QuestionField({
  group,
  question,
  choice,
  disabled,
  onChange,
}: {
  group: string
  question: UserQuestion
  choice: QuestionChoice | undefined
  disabled: boolean
  onChange: (choice: QuestionChoice) => void
}) {
  const selected = choice?.selected ?? []
  const other = choice?.other ?? ''
  const toggle = (value: string) =>
    onChange({
      other,
      selected: question.multiSelect
        ? selected.includes(value)
          ? selected.filter((s) => s !== value)
          : [...selected, value]
        : [value],
    })
  const type = question.multiSelect ? 'checkbox' : 'radio'
  return (
    <fieldset className="chat-question-field" disabled={disabled}>
      <legend>
        {question.header && <span className="chat-question-header">{question.header}</span>}
        {question.question}
      </legend>
      {question.options.map((option) => (
        <label key={option.label} className="chat-question-option">
          <input
            type={type}
            name={group}
            checked={selected.includes(option.label)}
            onChange={() => toggle(option.label)}
          />
          <span>
            {option.label}
            {option.description && <small>{option.description}</small>}
          </span>
        </label>
      ))}
      <label className="chat-question-option">
        <input
          type={type}
          name={group}
          checked={selected.includes(OTHER)}
          onChange={() => toggle(OTHER)}
        />
        <span>{question.options.length ? 'Other' : 'Answer'}</span>
      </label>
      {selected.includes(OTHER) && (
        <input
          className="chat-question-other"
          aria-label={`Answer to: ${question.question}`}
          value={other}
          onChange={(e) => onChange({ selected, other: e.target.value })}
        />
      )}
    </fieldset>
  )
}
