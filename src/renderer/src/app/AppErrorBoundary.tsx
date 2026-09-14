import { Component, type ErrorInfo, type ReactNode } from 'react'
import { IconRefresh, IconWarningOctogonFill } from '@pierre/icons'

interface AppErrorBoundaryProps {
  children: ReactNode
}

interface AppErrorBoundaryState {
  error: Error | null
}

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Renderer failed:', error, info.componentStack)
  }

  render(): ReactNode {
    if (this.state.error == null) return this.props.children
    return (
      <main className="fatal-error" role="alert">
        <IconWarningOctogonFill />
        <h1>The workspace stopped rendering</h1>
        <p>{this.state.error.message}</p>
        <button type="button" onClick={() => window.location.reload()}>
          <IconRefresh />Reload workspace
        </button>
      </main>
    )
  }
}
