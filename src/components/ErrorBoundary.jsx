/**
 * ErrorBoundary — catches render errors in the wrapped subtree and
 * shows a styled fallback instead of letting the whole app blank out.
 *
 * Logs the full error + component stack to console.error so the
 * browser DevTools surface what actually broke.
 *
 * Use sparingly — wrap leaf modules that can fail in isolation rather
 * than the whole app, so an isolated bug doesn't take everything down.
 */
import { Component } from 'react'

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null, info: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    // The component stack is only available here, not in
    // getDerivedStateFromError. Stash it so the fallback can render it
    // — and log it loudly so it shows up in the user's console.
    this.setState({ info })
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary]', this.props.label || 'unknown subtree', error, info?.componentStack)
  }

  reset = () => {
    this.setState({ error: null, info: null })
  }

  // Go back one step in browser history. React Router intercepts the
  // popstate, so this preserves SPA navigation when there's in-app
  // history — e.g. coming back to a calendar from a broken event view.
  // For users who deep-linked into the broken page (no in-app history),
  // history.length is 1 and `back()` is a no-op; fall back to the home
  // route so they're not stuck staring at the error card.
  goBack = () => {
    if (typeof window === 'undefined') return
    if (window.history.length > 1) {
      window.history.back()
    } else {
      window.location.href = '/'
    }
  }

  render() {
    if (!this.state.error) return this.props.children
    const { error, info } = this.state
    return (
      <div className="px-4 py-6 max-w-2xl mx-auto">
        <div className="rounded-lg border border-rose-900/60 bg-rose-950/25 px-4 py-3">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-rose-300 text-sm font-medium">Something broke in this view</span>
          </div>
          <div className="text-[11px] text-neutral-300 font-mono break-words">
            {String(error?.message || error)}
          </div>
          {info?.componentStack && (
            <details className="mt-2">
              <summary className="text-[10px] text-neutral-500 cursor-pointer hover:text-neutral-300">
                Component stack
              </summary>
              <pre className="mt-1 text-[10px] text-neutral-500 whitespace-pre-wrap break-words">
                {info.componentStack}
              </pre>
            </details>
          )}
          <div className="mt-3 flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={this.goBack}
              className="text-xs px-2.5 py-1 rounded border border-neutral-700 text-neutral-300 hover:text-neutral-100 hover:border-neutral-500 transition-colors"
            >
              ← Back
            </button>
            <button
              type="button"
              onClick={this.reset}
              className="text-xs px-2.5 py-1 rounded border border-neutral-700 text-neutral-300 hover:text-neutral-100 hover:border-neutral-500 transition-colors"
            >
              Try again
            </button>
            <span className="text-[10px] text-neutral-500">Full details in browser console.</span>
          </div>
        </div>
      </div>
    )
  }
}
