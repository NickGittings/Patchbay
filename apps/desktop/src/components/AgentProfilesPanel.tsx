import { useEffect, useState } from 'react'
import SettingsDialog, { SettingsFeedback, SettingsSection } from './SettingsDialog'
import { listAgentProfiles, saveAgentProfile, type AgentProfile } from '../lib/agentProfiles'
import { listDevices, agentHooksCheck, agentHooksConfigure } from '../lib/ipc'
import { rememberProfileHooks } from '../lib/agentHooks'
import { useStore } from '../store'

const empty = (): AgentProfile => ({
  id: '',
  name: '',
  executable: 'claude',
  configDir: '',
  model: '',
  openRouter: true,
  environment: {},
  credential: null,
  credentialEnv: null,
  archived: false,
})

export default function AgentProfilesPanel({ onClose }: { onClose: () => void }) {
  const [profiles, setProfiles] = useState<AgentProfile[]>([])
  const [profile, setProfile] = useState<AgentProfile>(empty)
  const [key, setKey] = useState('')
  const [clearKey, setClearKey] = useState(false)
  const [environment, setEnvironment] = useState('{}')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [isError, setIsError] = useState(false)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    void listAgentProfiles()
      .then(setProfiles)
      .catch((e) => {
        setIsError(true)
        setMessage(String(e))
      })
      .finally(() => setLoading(false))
  }, [])
  const select = (next: AgentProfile) => {
    setProfile(next)
    setKey('')
    setClearKey(false)
    setEnvironment(JSON.stringify(next.environment, null, 2))
    setMessage('')
    setIsError(false)
  }
  const update = (patch: Partial<AgentProfile>) => setProfile((p) => ({ ...p, ...patch }))
  const save = async () => {
    setBusy(true)
    setMessage('')
    setIsError(false)
    try {
      const variables: unknown = JSON.parse(environment)
      if (
        !variables ||
        typeof variables !== 'object' ||
        Array.isArray(variables) ||
        Object.values(variables).some((v) => typeof v !== 'string')
      )
        throw new Error('Environment must be a JSON object with string values')
      const saved = await saveAgentProfile(
        { ...profile, environment: variables as Record<string, string> },
        key || undefined,
        clearKey,
      )
      select(saved)
      setProfiles(await listAgentProfiles())
      useStore.getState().setDevices(await listDevices())
      setMessage(
        'Saved. New sessions use these settings; existing sessions retain their launch settings.',
      )
    } catch (e) {
      setIsError(true)
      setMessage(String(e))
    } finally {
      setBusy(false)
    }
  }
  const hooks = async (install: boolean) => {
    setBusy(true)
    setMessage('')
    setIsError(false)
    try {
      const source = profile.configDir.replace(/[\\/]$/, '') + '/settings.json'
      const result = install
        ? await agentHooksConfigure('claude', true, source)
        : await agentHooksCheck('claude', source)
      rememberProfileHooks(source, result)
      setMessage(
        result.installed
          ? 'Status hooks installed. Restart this agent to use them.'
          : 'Status hooks are not installed.',
      )
    } catch (e) {
      setIsError(true)
      setMessage(String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <SettingsDialog
      title="Agent profiles"
      subtitle="Reusable Claude Code configurations across projects"
      behavior="Changes apply when you save the profile. Hook actions apply immediately."
      onClose={onClose}
      footer={
        <>
          <button
            disabled={busy || loading}
            onClick={() =>
              select({
                ...profile,
                id: '',
                name: `${profile.name} copy`,
                configDir: '',
                credential: null,
                credentialEnv: null,
              })
            }
          >
            Duplicate
          </button>
          {profile.id && (
            <>
              <button disabled={busy || loading} onClick={() => void hooks(false)}>
                Check status hooks
              </button>
              <button disabled={busy || loading} onClick={() => void hooks(true)}>
                Install status hooks
              </button>
            </>
          )}
          <button className="primary" disabled={busy || loading} onClick={() => void save()}>
            {busy ? 'Working…' : 'Save profile'}
          </button>
        </>
      }
    >
      {loading && <SettingsFeedback>Loading profiles…</SettingsFeedback>}
      <fieldset disabled={busy || loading} className="settings-form">
        <SettingsSection title="Configuration">
          <label className="settings-field">
            Profile
            <select
              value={profile.id}
              onChange={(e) => select(profiles.find((p) => p.id === e.target.value) ?? empty())}
            >
              <option value="">New profile</option>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.archived ? ' (archived)' : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="settings-field">
            Setup
            <select
              value={profile.openRouter ? 'router' : 'claude'}
              onChange={(e) => update({ openRouter: e.target.value === 'router' })}
            >
              <option value="router">Claude Code via OpenRouter</option>
              <option value="claude">Claude Code</option>
            </select>
          </label>
          <label className="settings-field">
            Display name
            <input value={profile.name} onChange={(e) => update({ name: e.target.value })} />
          </label>
          <label className="settings-field">
            Executable path
            <input
              value={profile.executable}
              onChange={(e) => update({ executable: e.target.value })}
            />
          </label>
          <label className="settings-field">
            Model ID
            <input
              placeholder="Full OpenRouter model ID"
              value={profile.model}
              onChange={(e) => update({ model: e.target.value })}
            />
          </label>
          <label className="settings-field">
            Claude configuration directory
            <input
              placeholder="Automatic isolated directory"
              value={profile.configDir}
              onChange={(e) => update({ configDir: e.target.value })}
            />
          </label>
        </SettingsSection>
        {profile.openRouter && (
          <SettingsSection title="Credentials">
            <p>
              Endpoint: https://openrouter.ai/api. Claude Code must be installed separately. Use a
              fresh configuration directory to avoid cached Anthropic login credentials.
            </p>
            <label className="settings-field">
              API key
              <input
                type="password"
                autoComplete="new-password"
                value={key}
                placeholder={
                  profile.credential
                    ? 'Key saved in OS credential store'
                    : 'Enter OpenRouter API key'
                }
                onChange={(e) => setKey(e.target.value)}
              />
            </label>
            <label className="settings-field">
              Or credential environment variable
              <input
                value={profile.credentialEnv ?? ''}
                onChange={(e) => update({ credentialEnv: e.target.value || null })}
              />
            </label>
            <p>
              The environment variable must be available to the session helper. Restart the helper
              after changing its environment. OS-store keys are never shown again.
            </p>
            {profile.credential && (
              <label className="settings-toggle">
                <input
                  type="checkbox"
                  checked={clearKey}
                  onChange={(e) => setClearKey(e.target.checked)}
                />
                Clear saved key on save (requires an environment variable for an active OpenRouter
                profile)
              </label>
            )}
            <p>
              <a href="https://openrouter.ai/activity" target="_blank" rel="noreferrer">
                Verify routing in OpenRouter activity
              </a>
            </p>
          </SettingsSection>
        )}
        <SettingsSection title="Advanced">
          <details>
            <summary>Advanced environment variables</summary>
            <p>
              JSON object of non-secret string values. Patchbay transport and managed Claude
              settings are reserved.
            </p>
            <textarea
              aria-label="Environment variables"
              rows={5}
              value={environment}
              onChange={(e) => setEnvironment(e.target.value)}
            />
          </details>
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={profile.archived}
              onChange={(e) => update({ archived: e.target.checked })}
            />
            Archived (hidden from new-agent selectors)
          </label>
        </SettingsSection>
      </fieldset>
      {message && <SettingsFeedback error={isError}>{message}</SettingsFeedback>}
    </SettingsDialog>
  )
}
