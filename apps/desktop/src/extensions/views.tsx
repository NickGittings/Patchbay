import { useEffect } from 'react'
import { useStore } from '../store'
import { activateView, bindViewFrame } from './host'
export function ExtensionView({ id }: { id: string }) {
  const registry = useStore((s) => s.extensions)
  const project = useStore((s) => s.project)
  const html = useStore((s) => s.extensionViews[id])
  useEffect(() => {
    void activateView(id).catch((e) => useStore.getState().setMessage(String(e)))
    return () => bindViewFrame(id, null)
  }, [id, registry, project])
  if (!html)
    return (
      <div className="hint" data-extension-view={id}>
        Waiting for extension view…
      </div>
    )
  const document = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'"><script>window.patchbayView={postMessage:value=>parent.postMessage({patchbay:1,value},'*'),onMessage:fn=>addEventListener('message',e=>{if(e.source===parent&&e.data?.patchbay===1)fn(e.data.value)})}</script>${html}`
  return (
    <iframe
      className="extension-webview"
      title={id}
      data-extension-view={id}
      sandbox="allow-scripts"
      srcDoc={document}
      ref={(frame) => bindViewFrame(id, frame)}
    />
  )
}
