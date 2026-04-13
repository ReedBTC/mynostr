import { useState, useEffect } from 'react'
import { nip19 } from 'nostr-tools'
import { getNDK } from '../lib/ndk.js'

// Pulls a single tag value from an event's tag array
function getTag(event, name) {
  return event.tags.find(t => t[0] === name)?.[1] || ''
}

// Formats a unix timestamp into a readable date string
function formatDate(unix) {
  if (!unix) return ''
  return new Date(parseInt(unix) * 1000).toLocaleDateString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
  })
}

export default function ArticleDrawer({ user, onLoad, onClose }) {
  const [articles, setArticles] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    async function fetchArticles() {
      try {
        const ndk = getNDK()

        // Fetch the user's Kind 10002 relay list and add any write relays to the pool.
        // This is critical for read-only (npub) logins where no signer is set and NDK
        // has never fetched the user's relay preferences — without this we only query
        // the hardcoded fallback relays, which may not have this user's articles.
        try {
          const relayListEvent = await Promise.race([
            ndk.fetchEvent({ kinds: [10002], authors: [user.pubkey] }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000)),
          ])
          if (relayListEvent) {
            const writeRelays = relayListEvent.tags
              .filter(t => t[0] === 'r' && (!t[2] || t[2] === 'write'))
              .map(t => t[1])
              .filter(Boolean)
            for (const url of writeRelays) {
              try { ndk.addExplicitRelay(url) } catch { /* non-fatal */ }
            }
            // Give newly added relays a moment to connect before querying
            if (writeRelays.length) await new Promise(res => setTimeout(res, 1000))
          }
        } catch {
          // Non-fatal — continue with whatever relays are already connected
        }

        const events = await Promise.race([
          ndk.fetchEvents({ kinds: [30023], authors: [user.pubkey] }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 10000)),
        ])
        // Sort newest first by created_at
        const sorted = Array.from(events).sort((a, b) => b.created_at - a.created_at)
        setArticles(sorted)
      } catch (err) {
        setError(err.message === 'timeout'
          ? 'Relay timed out. Try again.'
          : 'Failed to load articles.')
      } finally {
        setLoading(false)
      }
    }
    fetchArticles()
  }, [user.pubkey])

  function handleLoad(event) {
    const publishedAtUnix = getTag(event, 'published_at')
    // Only populate the date field if the event had an explicit published_at tag
    const publishedAtDate = publishedAtUnix
      ? new Date(parseInt(publishedAtUnix) * 1000).toISOString().split('T')[0]
      : ''

    const tTags = event.tags.filter(t => t[0] === 't').map(t => t[1])

    // Construct naddr so the epub can link back to the published Nostr article
    let naddr = ''
    try {
      const identifier = getTag(event, 'd')
      naddr = nip19.naddrEncode({ kind: 30023, pubkey: event.pubkey, identifier })
    } catch {
      // Non-fatal — epub will just omit dc:source
    }

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

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/60 z-20"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Drawer */}
      <div
        className="fixed top-0 left-0 h-full w-80 bg-neutral-900 border-r border-neutral-800 z-30 flex flex-col"
        role="dialog"
        aria-label="My published articles"
      >
        {/* Drawer header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-neutral-800">
          <h2 className="text-sm font-semibold text-neutral-200">My Articles</h2>
          <button
            onClick={onClose}
            className="text-neutral-500 hover:text-neutral-300 transition-colors text-lg leading-none"
            aria-label="Close article list"
          >
            ✕
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {loading && (
            <div className="flex items-center justify-center h-32 text-neutral-500 text-sm">
              Loading...
            </div>
          )}

          {error && (
            <div className="p-5 text-sm text-red-400">{error}</div>
          )}

          {!loading && !error && articles.length === 0 && (
            <div className="p-5 text-sm text-neutral-500">
              No long-form articles found for this key.
            </div>
          )}

          {!loading && articles.map(event => {
            const title = getTag(event, 'title') || '(untitled)'
            const publishedAt = getTag(event, 'published_at')
            const dateStr = formatDate(publishedAt || String(event.created_at))

            return (
              <button
                key={event.id}
                onClick={() => handleLoad(event)}
                className="w-full text-left px-5 py-4 border-b border-neutral-800 hover:bg-neutral-800 transition-colors group"
                aria-label={`Load article: ${title}`}
              >
                <p className="text-sm text-neutral-200 group-hover:text-white leading-snug line-clamp-2">
                  {title}
                </p>
                <p className="text-xs text-neutral-500 mt-1">{dateStr}</p>
              </button>
            )
          })}
        </div>

        {/* Footer hint */}
        {!loading && articles.length > 0 && (
          <div className="px-5 py-3 border-t border-neutral-800">
            <p className="text-xs text-neutral-600">
              Click an article to load it into the editor.
            </p>
          </div>
        )}
      </div>
    </>
  )
}
