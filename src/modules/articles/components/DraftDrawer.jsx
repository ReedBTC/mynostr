import { useState, useEffect } from 'react'
import { nip19 } from 'nostr-tools'
import { NDKEvent } from '@nostr-dev-kit/ndk'
import { getNDK, signWithTimeout, publishToOwnOutbox } from '../../../lib/ndk.js'
import { isSafeUrl, withTimeout } from '../../../lib/utils.js'

function getTag(event, name) {
  return event.tags?.find(t => t[0] === name)?.[1] || ''
}

function formatDate(unix) {
  if (!unix) return ''
  return new Date(parseInt(unix) * 1000).toLocaleDateString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
  })
}

export default function DraftDrawer({ user, onLoad, onClose }) {
  const [drafts,       setDrafts]       = useState([])
  const [loading,      setLoading]      = useState(true)
  const [error,        setError]        = useState('')
  const [deletingId,   setDeletingId]   = useState(null)
  const [confirmDelId, setConfirmDelId] = useState(null)

  useEffect(() => {
    async function fetchDrafts() {
      try {
        const ndk = getNDK()
        // Try to add user's write relays for better coverage
        try {
          const relayListEvent = await withTimeout(
            ndk.fetchEvent({ kinds: [10002], authors: [user.pubkey] }),
            4000,
          )
          if (relayListEvent) {
            const writeRelays = relayListEvent.tags
              .filter(t => t[0] === 'r' && (!t[2] || t[2] === 'write'))
              .map(t => t[1]).filter(Boolean)
            for (const url of writeRelays) {
              try { ndk.addExplicitRelay(url) } catch {}
            }
            if (writeRelays.length) await new Promise(res => setTimeout(res, 1000))
          }
        } catch {}

        const events = await withTimeout(
          ndk.fetchEvents({ kinds: [31023], authors: [user.pubkey] }),
          10000,
        )
        const sorted = Array.from(events).sort((a, b) => b.created_at - a.created_at)
        setDrafts(sorted)
      } catch (err) {
        setError(err.message === 'timeout' ? 'Relay timed out. Try again.' : 'Failed to load drafts.')
      } finally {
        setLoading(false)
      }
    }
    fetchDrafts()
  }, [user.pubkey])

  function handleLoad(event) {
    const tTags = event.tags.filter(t => t[0] === 't').map(t => t[1])
    const publishedAtUnix = getTag(event, 'published_at')
    const publishedAtDate = publishedAtUnix
      ? new Date(parseInt(publishedAtUnix) * 1000).toISOString().split('T')[0]
      : ''
    let naddr = ''
    try {
      const identifier = getTag(event, 'd')
      naddr = nip19.naddrEncode({ kind: 31023, pubkey: event.pubkey, identifier })
    } catch {}
    onLoad({
      content: event.content,
      metadata: {
        title: getTag(event, 'title'),
        summary: getTag(event, 'summary'),
        publishedAtDate,
        image: getTag(event, 'image'),
        tagsRaw: tTags.join(', '),
        tags: tTags,
      },
      naddr,
    })
    onClose()
  }

  async function handleDelete(event) {
    const dTag = getTag(event, 'd')
    setDeletingId(event.id)
    try {
      const ndk = getNDK()
      // Publish an empty replacement to "delete" the draft
      const ev = new NDKEvent(ndk)
      ev.kind = 31023
      ev.tags = [['d', dTag]]
      ev.content = ''
      await signWithTimeout(ev)
      // Draft is replaceable (kind 31023) — the empty replacement must land
      // on the same relays the draft originally did (user's write relays) so
      // third-party clients see it as deleted too.
      await publishToOwnOutbox(ev)
      // Remove from local list
      setDrafts(prev => prev.filter(d => d.id !== event.id))
    } catch {} finally {
      setDeletingId(null)
      setConfirmDelId(null)
    }
  }

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/60 z-20" onClick={onClose} aria-hidden="true" />

      {/* Drawer */}
      <div
        className="fixed top-0 left-0 h-full w-[480px] bg-neutral-900 border-r border-neutral-800 z-30 flex flex-col"
        role="dialog"
        aria-label="My draft notes"
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-neutral-800 flex-shrink-0">
          <h2 className="text-sm font-semibold text-neutral-200 flex-shrink-0">My Drafts</h2>
          {!loading && drafts.length > 0 && (
            <span className="text-xs text-neutral-600">{drafts.length} draft{drafts.length !== 1 ? 's' : ''}</span>
          )}
          <button
            onClick={onClose}
            className="ml-auto text-neutral-500 hover:text-neutral-300 transition-colors text-lg leading-none flex-shrink-0"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {/* Draft list */}
        <div className="flex-1 overflow-y-auto">
          {loading && (
            <div className="flex items-center justify-center h-32 gap-2 text-neutral-500 text-sm">
              <span className="w-4 h-4 border-2 border-neutral-600 border-t-transparent rounded-full animate-spin inline-block" />
              Loading…
            </div>
          )}

          {error && <div className="p-5 text-sm text-red-400">{error}</div>}

          {!loading && !error && drafts.length === 0 && (
            <div className="p-5 text-sm text-neutral-500">
              No draft notes found for this key.
            </div>
          )}

          {!loading && drafts.map(event => {
            const title     = getTag(event, 'title') || '(untitled draft)'
            const image     = getTag(event, 'image')
            const summary   = getTag(event, 'summary')
            const dateStr   = formatDate(String(event.created_at))
            const isDeleting = deletingId === event.id
            const isConfirming = confirmDelId === event.id

            return (
              <div
                key={event.id}
                className="flex items-center border-b border-neutral-800/60 hover:bg-neutral-800/50 transition-colors group"
                style={{ height: '88px' }}
              >
                <button
                  onClick={() => handleLoad(event)}
                  className="flex items-center gap-3 px-4 text-left flex-1 min-w-0 h-full"
                  aria-label={`Load draft: ${title}`}
                >
                  {/* Thumbnail */}
                  <div className="w-14 h-14 rounded flex-shrink-0 bg-neutral-800 overflow-hidden">
                    {image && isSafeUrl(image) ? (
                      <img src={image} alt="" className="w-full h-full object-cover"
                        onError={e => { e.target.style.display = 'none' }} />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-neutral-600 text-lg">📝</div>
                    )}
                  </div>

                  {/* Text */}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-neutral-200 group-hover:text-white truncate leading-snug">
                      {title}
                    </p>
                    {summary && (
                      <p className="text-xs text-neutral-500 mt-0.5 truncate">{summary}</p>
                    )}
                    <p className="text-xs text-neutral-600 mt-1">{dateStr}</p>
                  </div>
                </button>

                {/* Delete button */}
                <div className="flex-shrink-0 pr-3">
                  {isConfirming ? (
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => handleDelete(event)}
                        disabled={isDeleting}
                        className="text-xs text-red-500 hover:text-red-400 transition-colors px-1 disabled:opacity-50"
                      >
                        {isDeleting ? '…' : 'Yes'}
                      </button>
                      <button
                        onClick={() => setConfirmDelId(null)}
                        className="text-xs text-neutral-600 hover:text-neutral-400 transition-colors px-1"
                      >
                        No
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setConfirmDelId(event.id)}
                      className="text-xs text-neutral-700 hover:text-red-500 transition-colors px-1"
                      title="Delete draft"
                    >
                      ✕
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>

        {!loading && drafts.length > 0 && (
          <div className="px-4 py-2 border-t border-neutral-800 flex-shrink-0">
            <p className="text-xs text-neutral-600">Click a draft to load it into the editor.</p>
          </div>
        )}
      </div>
    </>
  )
}
