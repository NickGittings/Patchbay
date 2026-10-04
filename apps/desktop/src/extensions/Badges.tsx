import { useStore } from '../store'
export default function ExtensionBadges({ componentId }: { componentId: string }) {
  const badges = useStore((s) => s.extensionBadges[componentId])
  return (
    <>
      {badges?.map((badge, i) => (
        <span
          key={i}
          className={`extension-badge tone-${badge.tone ?? 'info'}`}
          title={badge.tooltip}
          data-extension-badge={componentId}
        >
          {badge.text}
        </span>
      ))}
    </>
  )
}
