import { describe, expect, test } from 'vitest'
import type { Component } from '../types'
import { evaluateWhen, type WhenContext } from './when'

const component: Component = {
  id: 'web',
  name: 'Web',
  kind: 'frontend',
  path: 'web',
  notes: '',
  position: { x: 0, y: 0 },
  terminals: [{ id: 'dev', name: 'Dev', command: 'npm run dev', kind: 'task' }],
}
const context: WhenContext = {
  component,
  files: new Set(['package.json', 'Dockerfile']),
  view: 'navigation',
}
const when = (expression: string | null | undefined, c = context) => evaluateWhen(expression, c)

describe('evaluateWhen', () => {
  test('no clause always applies', () => {
    expect(when(undefined)).toBe(true)
    expect(when(null)).toBe(true)
    expect(when('   ')).toBe(true)
  })

  test('compares keys with quoted or bare literals', () => {
    expect(when("component.kind == 'frontend'")).toBe(true)
    expect(when('component.kind == frontend')).toBe(true)
    expect(when('component.id != "web"')).toBe(false)
    expect(when("view == 'navigation'")).toBe(true)
    expect(when("component.kind == 'it\\'s'")).toBe(false)
  })

  test('checks files and terminals', () => {
    expect(when("component.hasFile('Dockerfile')")).toBe(true)
    expect(when("component.hasFile('Cargo.toml')")).toBe(false)
    expect(when("component.hasTerminal('dev')")).toBe(true)
    expect(when("component.hasTerminal('dev')", { view: 'plan' })).toBe(false)
  })

  test('combines with !, && and || by precedence and parentheses', () => {
    expect(when("!component.hasFile('Cargo.toml') && view == navigation")).toBe(true)
    expect(when('false && false || true')).toBe(true)
    expect(when('false && (false || true)')).toBe(false)
    expect(when('!!true')).toBe(true)
  })

  test('unknown keys and malformed clauses are false, never evaluated', () => {
    expect(when('window.alert')).toBe(false)
    expect(when('constructor')).toBe(false)
    expect(when("component.kind == 'frontend'; alert(1)")).toBe(false)
    expect(when('(true')).toBe(false)
    expect(when('true true')).toBe(false)
    expect(when("component.hasFile('x'")).toBe(false)
    expect(when('`true`')).toBe(false)
    expect(when('true || '.repeat(1000) + 'true')).toBe(false)
  })
})
