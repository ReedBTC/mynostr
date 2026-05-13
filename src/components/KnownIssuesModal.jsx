/**
 * Known-Issues modal.
 *
 * Surfaces a curated list of open GitHub issues labeled `known-issue` so
 * alpha testers can see what's already on the maintainer's radar before
 * filing a duplicate bug report. The list is fetched from
 * /api/known-issues (a Cloudflare Pages Function) — see
 * functions/api/known-issues.js for the upstream details and cache
 * strategy.
 *
 * Why a modal (vs a dedicated page): the list is meant to be a quick
 * "is this already known?" check from the sidebar, not a destination.
 * If it ever outgrows ~30 items it can graduate to a route.
 */
import { useEffect, useState } from 'react'
import { isSafeUrl } from '../lib/utils.js'

function formatDate(iso) {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  } catch {
    return ''
  }
}

// GitHub label colors come back as 6-char hex without the leading `#`.
// We render them as small chips, so a contrast-aware text color keeps
// pale labels readable on the chip background.
function textColorFor(hex) {
  if (!hex || hex.length !== 6) return '#fff'
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  // Perceived luminance — light bg → dark text, dark bg → white text.
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  return lum > 0.6 ? '#111' : '#fff'
}

export default function KnownIssuesModal({ onClose }) {
  const [state, setState] = useState({ status: 'loading', issues: [], upstreamOk: true, error: '' })

  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const res = await fetch('/api/known-issues', { headers: { accept: 'application/json' } })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json()
        if (cancelled) return
        // upstream_ok=false means the worker fail-opened with [] because
        // GitHub was unreachable / rate-limited — render a different
        // empty state so users don't misread it as "no known issues."
        setState({
          status: 'ok',
          issues: Array.isArray(data?.issues) ? data.issues : [],
          upstreamOk: data?.upstream_ok !== false,
          error: '',
        })
      } catch (e) {
        if (cancelled) return
        setState({ status: 'error', issues: [], upstreamOk: true, error: e?.message || 'Failed to load known issues.' })
      }
    }
    load()
    return () => { cancelled = true }
  }, [])

  return (
    <>
      <div
        className="fixed inset-0 bg-black/70 z-40"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6"
        role="dialog"
        aria-label="Known issues"
      >
        <div className="bg-neutral-900 border border-neutral-800 rounded-lg w-full max-w-lg flex flex-col max-h-[90vh]">
          <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-800 shrink-0">
            <h2 className="text-sm font-semibold text-neutral-200">📋 Known issues</h2>
            <button
              onClick={onClose}
              className="text-neutral-500 hover:text-neutral-300 transition-colors text-lg leading-none"
              aria-label="Close"
            >
              ✕
            </button>
          </div>

          <div className="px-4 pt-3 pb-2 text-[11px] text-neutral-500 leading-snug shrink-0">
            Things we already know are broken in the alpha and are tracking on{' '}
            <a
              href="https://github.com/ReedBTC/mynostr/issues"
              target="_blank"
              rel="noopener noreferrer"
              className="text-purple-300 hover:text-purple-200"
            >
              GitHub
            </a>
            . If the bug you hit isn't here, please report it 🙏
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3">
            {state.status === 'loading' && (
              <div className="text-xs text-neutral-500 py-6 text-center">Loading…</div>
            )}

            {state.status === 'error' && (
              <div className="text-xs text-neutral-400 py-6 text-center space-y-2">
                <p className="text-rose-300">Couldn't reach GitHub right now.</p>
                <p>
                  <a
                    href="https://github.com/ReedBTC/mynostr/issues?q=is%3Aopen+label%3Aknown-issue"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-purple-300 hover:text-purple-200 underline"
                  >
                    Open the list on GitHub
                  </a>
                </p>
              </div>
            )}

            {state.status === 'ok' && state.issues.length === 0 && state.upstreamOk && (
              <div className="text-xs text-neutral-400 py-8 text-center space-y-2">
                <div className="text-2xl">✨</div>
                <p>No known issues right now.</p>
                <p className="text-neutral-500">
                  If something's broken, the Report a Bug button is right next door.
                </p>
              </div>
            )}

            {state.status === 'ok' && state.issues.length === 0 && !state.upstreamOk && (
              <div className="text-xs text-neutral-400 py-6 text-center space-y-2">
                <p className="text-rose-300">Couldn't reach GitHub right now.</p>
                <p>
                  <a
                    href="https://github.com/ReedBTC/mynostr/issues?q=is%3Aopen+label%3Aknown-issue"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-purple-300 hover:text-purple-200 underline"
                  >
                    Open the list on GitHub
                  </a>
                </p>
              </div>
            )}

            {state.status === 'ok' && state.issues.length > 0 && (
              <ul className="space-y-2">
                {state.issues.map(issue => {
                  const safe = isSafeUrl(issue.html_url) ? issue.html_url : null
                  const Wrap = safe ? 'a' : 'div'
                  const wrapProps = safe
                    ? { href: safe, target: '_blank', rel: 'noopener noreferrer' }
                    : {}
                  return (
                    <li key={issue.number}>
                      <Wrap
                        {...wrapProps}
                        className={`block rounded border border-neutral-800 hover:border-neutral-700 bg-neutral-950 px-3 py-2 transition-colors ${safe ? 'cursor-pointer' : ''}`}
                      >
                        <div className="flex items-start gap-2">
                          <span className="text-[11px] text-neutral-500 font-mono shrink-0 mt-0.5">
                            #{issue.number}
                          </span>
                          <span className="text-xs text-neutral-100 leading-snug">
                            {issue.title}
                          </span>
                        </div>
                        {(issue.labels?.length || issue.updated_at) && (
                          <div className="flex items-center gap-1.5 flex-wrap mt-1.5 pl-[2.25rem]">
                            {(issue.labels || []).slice(0, 4).map(l => (
                              <span
                                key={l.name}
                                className="text-[10px] px-1.5 py-0.5 rounded"
                                style={{
                                  backgroundColor: `#${l.color || '6b7280'}`,
                                  color: textColorFor(l.color),
                                }}
                              >
                                {l.name}
                              </span>
                            ))}
                            {issue.updated_at && (
                              <span className="text-[10px] text-neutral-500">
                                updated {formatDate(issue.updated_at)}
                              </span>
                            )}
                          </div>
                        )}
                      </Wrap>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </div>
      </div>
    </>
  )
}
