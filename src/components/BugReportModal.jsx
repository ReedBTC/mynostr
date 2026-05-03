/**
 * Bug-report modal.
 *
 * Single textarea pre-seeded with a brief template. Auto-injects which
 * page the user was on (`window.location.href`), browser, screen size,
 * timezone, and build mode — pasted into the body so the user can
 * review and edit before sending. We do NOT scrape personally-
 * identifying info beyond what the user can see in the body.
 *
 * Image attach (drag, paste, click): uploaded via the existing Blossom
 * helper, URL spliced into the textarea as `[image: <url>]` so the
 * triage script (`npm run bugs`) sees a plain markdown-ish reference
 * without needing to parse imeta tags.
 *
 * Login gate: if no signer, we route to the login modal — the publish
 * step requires a key to sign with. Read-only sessions can't report.
 */
import { useEffect, useRef, useState } from 'react'
import { uploadToBlossom } from '../lib/blossom.js'
import { publishBugReport } from '../lib/bugReport.js'

const TEMPLATE = `What went wrong:


Steps to reproduce:
1.
2.
3.

What you expected:


What happened instead:


Anything else (optional):

`

function buildContextBlock() {
  const lines = []
  try { lines.push(`Page: ${window.location.href}`) } catch {}
  try {
    const { width, height } = window.screen || {}
    if (width && height) lines.push(`Screen: ${width}×${height}, viewport ${window.innerWidth}×${window.innerHeight}`)
  } catch {}
  try { lines.push(`Browser: ${navigator.userAgent}`) } catch {}
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    if (tz) lines.push(`Timezone: ${tz}`)
  } catch {}
  try { lines.push(`Build: ${import.meta.env.MODE}`) } catch {}
  if (lines.length === 0) return ''
  return `\n---\n${lines.join('\n')}\n`
}

export default function BugReportModal({ user, onClose }) {
  const [content, setContent] = useState(() => TEMPLATE + buildContextBlock())
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)
  const [uploading, setUploading] = useState(false)
  const taRef = useRef(null)

  useEffect(() => {
    function onKey(e) {
      if (submitting) return
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, submitting])

  async function handleImageFile(file) {
    if (!file || !file.type?.startsWith('image/')) return
    if (uploading) return
    // Bound the upload size before we tie up bandwidth and the modal —
    // Blossom would reject huge files anyway, but only after the bytes
    // are already on the wire. 25 MB is generous for a screenshot.
    const MAX_BYTES = 25 * 1024 * 1024
    if (file.size > MAX_BYTES) {
      setError('Image too large (max 25 MB).')
      return
    }
    setUploading(true)
    setError('')
    try {
      const url = await uploadToBlossom(file)
      // Splice at the textarea's current selection so the URL drops
      // wherever the user's cursor is. Plain text marker keeps the
      // triage script's parsing trivial — no NIP-94 needed.
      const ta = taRef.current
      const insert = `\n[image: ${url}]\n`
      if (ta) {
        const start = ta.selectionStart ?? content.length
        const end   = ta.selectionEnd   ?? content.length
        const next  = content.slice(0, start) + insert + content.slice(end)
        setContent(next)
        // Restore cursor after React re-render.
        requestAnimationFrame(() => {
          ta.focus()
          const pos = start + insert.length
          ta.setSelectionRange(pos, pos)
        })
      } else {
        setContent(c => c + insert)
      }
    } catch (e) {
      setError(e?.message || 'Image upload failed.')
    } finally {
      setUploading(false)
    }
  }

  function onPaste(e) {
    const item = [...(e.clipboardData?.items || [])].find(i => i.type?.startsWith('image/'))
    if (!item) return
    const file = item.getAsFile()
    if (file) {
      e.preventDefault()
      handleImageFile(file)
    }
  }

  function onDrop(e) {
    const file = e.dataTransfer?.files?.[0]
    if (file?.type?.startsWith('image/')) {
      e.preventDefault()
      handleImageFile(file)
    }
  }

  async function handleSubmit() {
    if (submitting) return
    if (!user?.pubkey) {
      setError('Sign in first — bug reports are signed by your Nostr key.')
      return
    }
    if (!content.trim()) {
      setError('Tell us what went wrong before sending.')
      return
    }
    setSubmitting(true)
    setError('')
    try {
      await publishBugReport(content)
      setDone(true)
    } catch (e) {
      setError(e?.message || 'Couldn\'t send. Try again in a moment.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <div
        className="fixed inset-0 bg-black/70 z-40"
        onClick={submitting ? undefined : onClose}
        aria-hidden="true"
      />
      <div
        className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6"
        role="dialog"
        aria-label="Report a bug"
      >
        <div
          className="bg-neutral-900 border border-neutral-800 rounded-lg w-full max-w-lg flex flex-col max-h-[90vh]"
          onDragOver={e => e.preventDefault()}
          onDrop={onDrop}
        >
          <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-800 shrink-0">
            <h2 className="text-sm font-semibold text-neutral-200">🐛 Report a bug</h2>
            <button
              onClick={onClose}
              disabled={submitting}
              className="text-neutral-500 hover:text-neutral-300 transition-colors text-lg leading-none disabled:opacity-30"
              aria-label="Close"
            >
              ✕
            </button>
          </div>

          {done ? (
            <div className="px-4 py-8 text-center space-y-4">
              <div className="text-3xl">✅</div>
              <p className="text-sm text-neutral-200 font-medium">Report sent.</p>
              <p className="text-xs text-neutral-500 leading-snug">
                Thank you for reporting! This will be automatically added as an issue in github shortly. If we need
                clarification we'll DM the npub you signed with.
              </p>
              <button
                onClick={onClose}
                className="px-4 py-2 rounded bg-neutral-800 hover:bg-neutral-700 text-sm text-neutral-200 transition-colors"
              >
                Done
              </button>
            </div>
          ) : (
            <div className="flex flex-col flex-1 min-h-0">
              <div className="px-4 pt-3 pb-2 text-[11px] text-neutral-500 leading-snug shrink-0 space-y-1">
                <p>
                  Drag, paste, or click to attach a screenshot. Edit anything below before sending — page URL,
                  browser, screen size, timezone, and build mode are auto-included.
                </p>
                <p className="text-rose-300/90">
                  ⚠️ Don't paste passwords, private keys (nsec…), or API tokens. Reports are public.
                </p>
              </div>

              <div className="flex-1 min-h-0 px-4 pb-3 overflow-y-auto">
                <textarea
                  ref={taRef}
                  value={content}
                  onChange={e => setContent(e.target.value)}
                  onPaste={onPaste}
                  rows={14}
                  spellCheck
                  className="w-full bg-neutral-950 border border-neutral-800 rounded px-3 py-2 text-xs text-neutral-100 font-mono resize-y focus:outline-none focus:border-purple-600 focus:ring-2 focus:ring-purple-500/30"
                  placeholder="Describe the bug…"
                />
              </div>

              <div className="px-4 py-3 border-t border-neutral-800 shrink-0 flex items-center gap-2 flex-wrap">
                <label className={`text-xs px-2.5 py-1.5 rounded border border-neutral-700 text-neutral-300 hover:bg-neutral-800 cursor-pointer transition-colors ${uploading ? 'opacity-50 pointer-events-none' : ''}`}>
                  {uploading ? 'Uploading…' : '📎 Attach image'}
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={e => {
                      const f = e.target.files?.[0]
                      if (f) handleImageFile(f)
                      e.target.value = ''
                    }}
                  />
                </label>
                <div className="flex-1" />
                {error && (
                  <p className="text-[11px] text-red-400 w-full sm:w-auto sm:max-w-[20rem] order-3 sm:order-2">
                    {error}
                  </p>
                )}
                <button
                  onClick={handleSubmit}
                  disabled={submitting || !user?.pubkey}
                  title={!user?.pubkey ? 'Sign in to report a bug' : ''}
                  className="px-4 py-1.5 rounded bg-purple-600 hover:bg-purple-500 disabled:opacity-40 disabled:cursor-not-allowed text-sm font-medium text-white transition-colors order-2 sm:order-3"
                >
                  {submitting ? 'Sending…' : 'Send report'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  )
}
