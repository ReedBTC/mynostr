import { useState, useRef, useEffect } from 'react'
import { publishArticle } from '../lib/publish.js'

// Publish states
const STATE = {
  IDLE: 'idle',
  PUBLISHING: 'publishing',
  SUCCESS: 'success',
  ERROR: 'error',
}

export default function PublishButton({ content, metadata, source, user, onPublishAnother, onPublishSuccess, readOnly }) {
  const [state, setState] = useState(STATE.IDLE)
  const [result, setResult] = useState(null) // { nevent, relays }
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const publishingRef = useRef(false)

  // Reset success/error state when the user changes content or metadata,
  // so stale results from a previous publish don't linger
  useEffect(() => {
    if (state === STATE.SUCCESS || state === STATE.ERROR) {
      setState(STATE.IDLE)
      setResult(null)
      setError('')
    }
  }, [content, metadata.title])

  const canPublish = !!metadata.title.trim() && !!content.trim()

  async function handlePublish() {
    // Ref-based guard prevents double-publish from rapid clicks
    if (!canPublish || publishingRef.current) return
    publishingRef.current = true
    setState(STATE.PUBLISHING)
    setError('')
    try {
      const res = await publishArticle({ content, metadata, source })
      setResult(res)
      setState(STATE.SUCCESS)
      onPublishSuccess?.()
    } catch (err) {
      setError(err.message || 'Publish failed.')
      setState(STATE.ERROR)
    } finally {
      publishingRef.current = false
    }
  }

  async function handleCopyNaddr() {
    const text = result?.naddr
    if (!text) return
    try {
      // Clipboard API requires HTTPS or localhost — falls back to execCommand
      // for local network access (192.168.x.x) during development
      await navigator.clipboard.writeText(text)
    } catch {
      try {
        const el = document.createElement('textarea')
        el.value = text
        el.style.cssText = 'position:fixed;opacity:0'
        document.body.appendChild(el)
        el.focus()
        el.select()
        document.execCommand('copy')
        document.body.removeChild(el)
      } catch {
        return // both methods failed, don't show "Copied!"
      }
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  function handlePublishAnother() {
    setState(STATE.IDLE)
    setResult(null)
    setError('')
    onPublishAnother()
  }

  if (readOnly) {
    return (
      <button
        disabled
        className="w-full py-3 px-4 rounded bg-neutral-800 opacity-40 cursor-not-allowed text-neutral-500 font-medium text-sm border border-neutral-700"
        aria-label="Publishing unavailable in read-only mode"
      >
        Publish to Nostr
      </button>
    )
  }

  // Success state
  if (state === STATE.SUCCESS && result) {
    return (
      <div className="space-y-3">
        <div className="px-3 py-2 rounded bg-green-950 border border-green-800 text-green-400 text-sm">
          Published successfully.
        </div>

        {/* Relay list — scrollable so a large list doesn't blow out the sidebar */}
        <div className="space-y-1">
          <p className="text-xs text-neutral-600">Published to {result.relays.length} {result.relays.length === 1 ? 'relay' : 'relays'}:</p>
          <div className="max-h-32 overflow-y-auto space-y-0.5">
            {result.relays.map(r => (
              <p key={r} className="text-xs text-neutral-500 font-mono truncate">{r}</p>
            ))}
          </div>
        </div>

        {/* View on njump.me */}
        <a
          href={`https://njump.me/${result.nevent}`}
          target="_blank"
          rel="noopener noreferrer"
          className="block w-full text-center py-2 px-4 rounded bg-purple-700 hover:bg-purple-600 text-white text-sm transition-colors"
        >
          View on njump.me →
        </a>

        {/* Action buttons */}
        <div className="flex gap-2">
          <button
            onClick={handleCopyNaddr}
            className="flex-1 py-2 px-3 rounded border border-neutral-700 text-neutral-400 hover:text-neutral-200 hover:border-neutral-500 text-xs transition-colors"
          >
            {copied ? 'Copied!' : 'Copy naddr'}
          </button>
          <button
            onClick={handlePublishAnother}
            className="flex-1 py-2 px-3 rounded border border-neutral-700 text-neutral-400 hover:text-neutral-200 hover:border-neutral-500 text-xs transition-colors"
          >
            Publish Another
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {/* Validation hint */}
      {!canPublish && (
        <p className="text-xs text-neutral-600">
          {!metadata.title.trim() ? 'A title is required.' : 'Add some content to publish.'}
        </p>
      )}

      {/* Error display */}
      {state === STATE.ERROR && error && (
        <p className="text-xs text-red-400" role="alert">{error}</p>
      )}

      <button
        onClick={handlePublish}
        disabled={!canPublish || state === STATE.PUBLISHING}
        className="w-full py-3 px-4 rounded bg-purple-700 hover:bg-purple-600 disabled:opacity-40 disabled:cursor-not-allowed text-white font-medium text-sm transition-colors"
        aria-label="Sign and publish article to Nostr"
      >
        {state === STATE.PUBLISHING ? 'Publishing...' : 'Publish to Nostr'}
      </button>
    </div>
  )
}
