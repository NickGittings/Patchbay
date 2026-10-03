import { useOpenProject } from '../lib/project'

export default function Welcome() {
  const openFolder = useOpenProject()
  return (
    <div className="welcome">
      <div className="welcome-card">
        <h1>Patchbay</h1>
        <p>
          See your application one component at a time. Open a repository and Patchbay maps its main
          parts, each with its own terminals, agent and health.
        </p>
        <button className="primary" onClick={() => void openFolder()}>
          Open project folder…
        </button>
      </div>
    </div>
  )
}
