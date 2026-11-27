import { serviceBlock } from '../lib/display'
import { useStore } from '../store'
import OutdatedServiceNotice from './OutdatedServiceNotice'

/** Session service problems only the user can resolve, whether or not a terminal is on screen. */
export default function ServiceBanner() {
  const blocked = useStore(serviceBlock)
  if (!blocked) return null
  return (
    <div className="recovery-banner" role="alert">
      {blocked === 'older' || blocked === 'updated' ? (
        <OutdatedServiceNotice updated={blocked === 'updated'} />
      ) : (
        <span>
          A newer Patchbay version is running the session service, so this version can't connect.
          Use a matching Patchbay version.
        </span>
      )}
    </div>
  )
}
