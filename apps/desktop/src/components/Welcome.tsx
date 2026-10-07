import { modifierKey, shiftKey } from '../lib/platform'
import { useOpenProject } from '../lib/project'

export default function Welcome() {
  const openFolder = useOpenProject()
  return (
    <div className="welcome">
      <div className="welcome-card">
        <div className="welcome-mark" aria-hidden>
          ◈
        </div>
        <h1>Patchbay</h1>
        <p>
          See your application one component at a time. Open a repository and Patchbay maps its main
          parts, each with its own terminals, agent and health.
        </p>
        <button className="primary" onClick={() => void openFolder()}>
          Open project folder…
        </button>
        <ul className="welcome-steps">
          <li>
            <strong>Map</strong>
            Packages and repos become components, linked by what they depend on.
          </li>
          <li>
            <strong>Run</strong>
            Dev servers, tests and agents per component, briefed with its context.
          </li>
          <li>
            <strong>Ship</strong>
            Plan across components, implement side by side, review every change.
          </li>
        </ul>
        <div className="welcome-keys">
          <kbd>{modifierKey}</kbd> <kbd>{shiftKey}</kbd> <kbd>P</kbd> command palette
        </div>
      </div>
    </div>
  )
}
