import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

/**
 * A render-time crash should not become a blank page.
 *
 * Without this, any throw during render unmounts the whole tree: no shell, no
 * navigation, no way back, and nothing in the console a creator could act on.
 * Here it becomes a sentence and a button.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // No telemetry exists yet, so at least make it findable in the console.
    console.error('[ui] render failed', error, info.componentStack)
  }

  private reload(): void {
    this.setState({ error: null })
    globalThis.location.reload()
  }

  override render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div className="auth-shell">
        <div className="card auth-card">
          <h1 style={{ margin: 0, fontSize: 22 }}>Something went wrong</h1>
          <p style={{ marginTop: 10 }}>
            This page stopped working. Reloading usually clears it, and nothing you have saved is
            lost.
          </p>
          <p className="help">{error.message}</p>
          <button className="primary" onClick={() => this.reload()}>
            Reload
          </button>
        </div>
      </div>
    )
  }
}
