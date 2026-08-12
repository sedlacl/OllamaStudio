import LogPanel from '../components/LogPanel'

export default function Logs(): JSX.Element {
  return (
    <div className="logs-page">
      <div className="logs-page-header">
        <h1 className="page-title">Logy serve</h1>
        <p className="logs-page-description">
          Živý stream stdout/stderr procesu <code>ollama serve</code>. Historie se ukládá také do{' '}
          <span className="mono">userData/logs/ollama-serve.log</span>.
        </p>
      </div>
      <div className="logs-panel-section">
        <LogPanel fill />
      </div>
    </div>
  )
}
