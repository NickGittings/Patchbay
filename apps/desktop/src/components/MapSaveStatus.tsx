import { useStore } from '../store'
import { mapBlocked, reloadSavedMap, saveMapNow } from '../lib/mapSave'
import PanelContent from './PanelContent'

export default function MapSaveStatus() {
  const id = useStore((s) => s.activeProjectId)
  const entry = useStore((s) => (id ? s.projects[id] : undefined))
  const dirty = useStore((s) => s.dirty)
  if (!id || !entry) return null
  const absent = entry.fingerprint === 'absent'
  const status = entry.mapSave?.status
  const blocked = mapBlocked(entry)
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
    <section className="map-save-status">
      <PanelContent>
        <strong role="status">{label}</strong>
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
        <hr />
        {status === 'conflict' ? (
          <>
            <button onClick={() => void reloadSavedMap(id)}>Reload saved map</button>
            <button onClick={() => void saveMapNow(id, true)}>Replace with my map</button>
          </>
        ) : (
          <button disabled={blocked || status === 'saving'} onClick={() => void saveMapNow(id)}>
            {status === 'error'
              ? 'Retry'
              : absent
                ? 'Create map configuration'
                : 'Save map configuration now'}
          </button>
        )}
      </PanelContent>
    </section>
  )
}
