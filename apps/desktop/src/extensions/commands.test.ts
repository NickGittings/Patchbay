import { expect, test } from 'vitest'
import { useStore } from '../store'
import type { Extension } from '../types'

function extension(id: string, permissions: string[]): Extension {
  return {
    id,
    dir: '',
    enabled: true,
    errors: [],
    approvedHosts: [],
    manifest: {
      publisher: 'fixture',
      name: id,
      version: '0.1.0',
      engines: { patchbay: '^0.1.0' },
      permissions,
      activationEvents: [],
      network: [],
      contributes: {
        devices: [],
        detectors: [],
        commands: [{ id, title: id, run: null }],
        menus: { 'stories/item': [{ command: id }], 'stories/toolbar': [{ command: id }] },
        views: [],
        context: [],
      },
    },
  }
}

test('only story readers contribute story editor commands', () => {
  const state = useStore.getState()
  try {
    state.setExtensions({
      extensions: [extension('writer', ['stories:write']), extension('reader', ['stories:read'])],
      errors: [],
    })
    expect(useStore.getState().menus['stories/item']).toEqual([{ command: 'reader' }])
    expect(useStore.getState().menus['stories/toolbar']).toEqual([
      { command: 'writer' },
      { command: 'reader' },
    ])
  } finally {
    state.setExtensions(state.extensions)
  }
})
