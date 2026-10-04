import type { Component, View } from '../types'
export interface WhenContext {
  component?: Component | null
  files?: Set<string>
  view: View
}
/** A bounded parser, never eval. Unknown keys and malformed expressions are false. */
export function evaluateWhen(expression: string | null | undefined, context: WhenContext): boolean {
  if (!expression?.trim()) return true
  if (expression.length > 4096) return false
  const tokens =
    expression.match(/\s+|&&|\|\||==|!=|[!()]|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|[\w.-]+/g) ?? []
  if (tokens.join('') !== expression) return false
  const input = tokens.filter((t) => t.trim())
  let cursor = 0
  const peek = () => input[cursor]
  const take = () => input[cursor++]
  const literal = (token: string | undefined): string => {
    if (!token) throw new Error('Missing value')
    return /^['"]/.test(token) ? token.slice(1, -1).replace(/\\(['"\\])/g, '$1') : token
  }
  const value = (): unknown => {
    const key = take()
    if (key === '(') {
      const result = or()
      if (take() !== ')') throw new Error('Missing )')
      return result
    }
    if (key === 'component.hasFile' || key === 'component.hasTerminal') {
      if (take() !== '(') throw new Error('Missing (')
      const id = literal(take())
      if (take() !== ')') throw new Error('Missing )')
      return key === 'component.hasFile'
        ? (context.files?.has(id) ?? false)
        : (context.component?.terminals.some((t) => t.id === id) ?? false)
    }
    if (key === 'component.kind') return context.component?.kind
    if (key === 'component.id') return context.component?.id
    if (key === 'view') return context.view
    if (key === 'true') return true
    if (key === 'false') return false
    if (key?.startsWith("'") || key?.startsWith('"')) return literal(key)
    throw new Error('Unknown key')
  }
  const unary = (): unknown => (peek() === '!' ? (take(), !unary()) : value())
  const comparison = (): boolean => {
    const left = unary()
    if (peek() === '==' || peek() === '!=') {
      const op = take()
      const right = literal(take())
      return op === '==' ? left === right : left !== right
    }
    return Boolean(left)
  }
  const and = (): boolean => {
    let result = comparison()
    while (peek() === '&&') {
      take()
      const right = comparison()
      result = result && right
    }
    return result
  }
  const or = (): boolean => {
    let result = and()
    while (peek() === '||') {
      take()
      const right = and()
      result = result || right
    }
    return result
  }
  try {
    const result = or()
    return cursor === input.length && result
  } catch {
    return false
  }
}
