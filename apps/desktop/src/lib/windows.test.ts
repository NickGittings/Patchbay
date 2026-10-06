import { expect, test, vi } from 'vitest'

// windows.ts reads a smoke flag from `window` at load; node has none.
vi.stubGlobal('window', {})
vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: () => ({ label: 'main' }),
  WebviewWindow: class {},
}))
vi.mock('../store', () => ({ useStore: { getState: () => ({}) }, projectFrom: () => null }))
const { componentLabel } = await import('./windows')

// Pinned in `src-tauri/src/lib.rs` too (`component_window_label`): the backend routes a pop-out's
// terminal events by this label, and `capabilities/default.json` matches `component-*`.
test('component window labels match the backend', () => {
  expect(componentLabel('web', 'p-1')).toBe('component-5b-22-70-2d-31-22-2c-22-77-65-62-22-5d')
  expect(componentLabel('a"/ü😀', 'p')).toBe(
    'component-5b-22-70-22-2c-22-61-5c-22-2f-fc-1f600-22-5d',
  )
})
