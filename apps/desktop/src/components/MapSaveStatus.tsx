import { useStore } from '../store'
import { reloadSavedMap, saveMapNow } from '../lib/mapSave'
import Menu, { MenuItem, MenuSeparator } from './Menu'

export default function MapSaveStatus() {
  const id = useStore((s) => s.activeProjectId)
  const entry = useStore((s) => (id ? s.projects[id] : undefined))
  const dirty = useStore((s) => s.dirty)
  if (!id || !entry) return null
  const absent = entry.fingerprint === 'absent'
  const status = entry.mapSave?.status
  const blocked = !!entry.conflict || !!entry.unavailable
  const label = blocked
    ? 'Map needs recovery'
    : status === 'error'
      ? 'Map couldn’t save'
      : status === 'conflict'
        ? 'Map changed externally'
        : status === 'saving'
          ? 'Saving map'
          : absent
            ? 'Map not saved'
            : dirty
              ? 'Map changes pending'
              : 'Map saved'
  return (
    <Menu
      label={
        <span role="status" aria-live="polite">
          {label}
        </span>
      }
      title="Map configuration saving"
      align="right"
      className="map-save-status"
      triggerClassName={status === 'error' || status === 'conflict' ? 'map-save-error' : ''}
    >
      <p className="map-save-description">
        {absent
          ? 'Create patchbay.json to save the component map and terminal presets. Later map edits save automatically.'
          : 'The component map and terminal presets are saved automatically to patchbay.json.'}
      </p>
      {entry.mapSave?.error && (
        <p className="map-save-description" role="alert">
          {entry.mapSave.error}
        </p>
      )}
      {blocked && (
        <p className="map-save-description">Resolve project recovery before saving the map.</p>
      )}
      <MenuSeparator />
      {status === 'conflict' ? (
        <>
          <MenuItem onClick={() => void reloadSavedMap(id)}>Reload saved map</MenuItem>
          <MenuItem onClick={() => void saveMapNow(id, true)}>Replace with my map</MenuItem>
        </>
      ) : (
        <MenuItem disabled={blocked || status === 'saving'} onClick={() => void saveMapNow(id)}>
          {status === 'error'
            ? 'Retry'
            : absent
              ? 'Create map configuration'
              : 'Save map configuration now'}
        </MenuItem>
      )}
    </Menu>
  )
}
