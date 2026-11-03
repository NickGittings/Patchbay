import { invoke } from '@tauri-apps/api/core'

export interface AgentProfile {
  id: string
  name: string
  executable: string
  configDir: string
  model: string
  openRouter: boolean
  environment: Record<string, string>
  credential: string | null
  credentialEnv: string | null
  archived: boolean
}

export const listAgentProfiles = () => invoke<AgentProfile[]>('agent_profiles_list')
export const saveAgentProfile = (profile: AgentProfile, key?: string, clearKey = false) =>
  invoke<AgentProfile>('agent_profile_save', { profile, key, clearKey })

export function profileSnapshot(command: string): string | undefined {
  return command.match(/(?:^|\s)PATCHBAY_AGENT_PROFILE=([\w-]+)/)?.[1]
}
export function decodeProfile(encoded: string): AgentProfile {
  const bytes = Uint8Array.from(atob(encoded.replace(/-/g, '+').replace(/_/g, '/')), (c) =>
    c.charCodeAt(0),
  )
  return JSON.parse(new TextDecoder().decode(bytes)) as AgentProfile
}
export function commandProfile(command: string): AgentProfile | undefined {
  const encoded = profileSnapshot(command)
  try {
    return encoded ? decodeProfile(encoded) : undefined
  } catch {
    return undefined
  }
}
export const profileHookProvider = (command: string) => {
  const encoded = profileSnapshot(command)
  return encoded && commandProfile(command) ? (`claude:${encoded}` as const) : undefined
}
