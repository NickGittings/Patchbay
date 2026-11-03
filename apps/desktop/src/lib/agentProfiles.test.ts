import { expect, test } from 'vitest'
import { commandProfile, profileHookProvider } from './agentProfiles'
import { hookSource, presetProvider } from './agentHooks'

const profile = {
  name: 'Router ✓',
  configDir: '/tmp/router-profile',
  openRouter: true,
  model: 'anthropic/example',
}
const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(profile))))
  .replace(/\+/g, '-')
  .replace(/\//g, '_')
  .replace(/=+$/, '')
const command = `PATCHBAY_AGENT_PROFILE=${encoded} claude --model anthropic/example`

test('profile settings and Unicode names survive the preset command snapshot', () => {
  expect(commandProfile(command)).toEqual(profile)
  expect(commandProfile('claude')).toBeUndefined()
  expect(commandProfile('PATCHBAY_AGENT_PROFILE=broken claude')).toBeUndefined()
})
test('profile hooks are keyed separately from the default Claude configuration', () => {
  const provider = profileHookProvider(command)!
  expect(presetProvider({ command, adapter: 'claude' }, {})).toBe(provider)
  expect(hookSource(provider)).toBe('/tmp/router-profile/settings.json')
})
