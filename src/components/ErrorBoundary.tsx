import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
  errorInfo: ErrorInfo | null
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, errorInfo: null }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    this.setState({ error, errorInfo })
    console.error('[ErrorBoundary] Caught crash:', error, errorInfo)
  }

  handleGoHome = () => {
    this.setState({ error: null, errorInfo: null })
    window.location.hash = ''
    // Force a full renderer reload so the broken module state is cleared
    window.location.reload()
  }

  render() {
    const { error, errorInfo } = this.state
    if (!error) return this.props.children

    const componentStack = errorInfo?.componentStack ?? ''
    const firstLine = componentStack.trim().split('\n')[0] ?? ''

    return (
      <div style={{
        height: '100vh', display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        background: 'var(--axon-bg, #0f1117)', gap: 20, padding: 32,
      }}>
        {/* Icon */}
        <div style={{
          width: 56, height: 56, borderRadius: 16,
          background: 'var(--axon-red-d, rgba(239,68,68,0.12))',
          border: '1px solid rgba(239,68,68,0.25)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 24,
        }}>
          ⚠
        </div>

        {/* Heading */}
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--axon-t1, #e2e8f0)', marginBottom: 6 }}>
            Something went wrong
          </div>
          <div style={{ fontSize: 13, color: 'var(--axon-t3, #64748b)', maxWidth: 420 }}>
            A rendering error crashed this view. Your data is safe — you can go back to the home screen and continue working.
          </div>
        </div>

        {/* Error detail */}
        <div style={{
          background: 'var(--axon-bg2, #161b27)', border: '1px solid var(--axon-border, rgba(255,255,255,0.07))',
          borderRadius: 10, padding: '12px 16px', maxWidth: 500, width: '100%',
        }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--axon-red, #f87171)', marginBottom: 6 }}>
            {error.name}: {error.message}
          </div>
          {firstLine && (
            <div style={{ fontSize: 10, color: 'var(--axon-t4, #475569)', fontFamily: 'monospace' }}>
              {firstLine}
            </div>
          )}
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', gap: 10 }}>
          <button
            onClick={this.handleGoHome}
            style={{
              padding: '9px 20px', borderRadius: 8, fontSize: 13, fontWeight: 600,
              cursor: 'pointer', border: 'none',
              background: 'var(--axon-nexus, #6f5fe8)', color: '#fff',
              fontFamily: 'inherit',
            }}
          >
            ← Go to Home Screen
          </button>
          <button
            onClick={() => this.setState({ error: null, errorInfo: null })}
            style={{
              padding: '9px 20px', borderRadius: 8, fontSize: 13, fontWeight: 600,
              cursor: 'pointer', border: '1px solid var(--axon-border2, rgba(255,255,255,0.12))',
              background: 'transparent', color: 'var(--axon-t2, #94a3b8)',
              fontFamily: 'inherit',
            }}
          >
            Try Again
          </button>
        </div>
      </div>
    )
  }
}
