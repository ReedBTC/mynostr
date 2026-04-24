import { useState, useEffect } from 'react'
import JSZip from 'jszip'
import { nip19 } from 'nostr-tools'
import { getNDK } from '../../../lib/ndk.js'
import { buildEpubBlob, exportChapterizedEpub, exportChapterizedMd } from '../../../lib/epub.js'
import { isSafeUrl, titleToSlug, buildFrontmatter } from '../../../lib/utils.js'

function getTag(event, name) {
  return event.tags?.find(t => t[0] === name)?.[1] || ''
}

function formatDate(unix) {
  if (!unix) return ''
  return new Date(parseInt(unix) * 1000).toLocaleDateString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
  })
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename; a.click()
  URL.revokeObjectURL(url)
}

function buildMeta(event) {
  const tTags = event.tags.filter(t => t[0] === 't').map(t => t[1])
  const publishedAtUnix = getTag(event, 'published_at')
  return {
    title:           getTag(event, 'title') || 'Untitled',
    summary:         getTag(event, 'summary') || '',
    image:           getTag(event, 'image') || '',
    publishedAtDate: publishedAtUnix
      ? new Date(parseInt(publishedAtUnix) * 1000).toISOString().split('T')[0]
      : event.created_at
        ? new Date(event.created_at * 1000).toISOString().split('T')[0]
        : '',
    tags: tTags,
  }
}

export default function ArticleDrawer({ user, onLoad, onClose }) {
  const [articles,      setArticles]      = useState([])
  const [loading,       setLoading]       = useState(true)
  const [error,         setError]         = useState('')
  const [pendingExport, setPendingExport] = useState(null)   // null | 'md' | 'epub'
  const [exportStatus,  setExportStatus]  = useState('')     // '' | 'exporting' | 'done' | 'error'
  const [exportError,   setExportError]   = useState('')

  const authorName = user?.profile?.displayName || user?.profile?.name || ''

  useEffect(() => {
    async function fetchArticles() {
      try {
        const ndk = getNDK()
        try {
          const relayListEvent = await Promise.race([
            ndk.fetchEvent({ kinds: [10002], authors: [user.pubkey] }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000)),
          ])
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

        const events = await Promise.race([
          ndk.fetchEvents({ kinds: [30023], authors: [user.pubkey] }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 10000)),
        ])
        const sorted = Array.from(events).sort((a, b) => b.created_at - a.created_at)
        setArticles(sorted)
      } catch (err) {
        setError(err.message === 'timeout' ? 'Relay timed out. Try again.' : 'Failed to load articles.')
      } finally {
        setLoading(false)
      }
    }
    fetchArticles()
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
      naddr = nip19.naddrEncode({ kind: 30023, pubkey: event.pubkey, identifier })
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

  async function handleExportAll(format, combined) {
    setPendingExport(null)
    setExportStatus('exporting')
    setExportError('')
    try {
      const resolved = articles.map(ev => ({
        content:  ev.content,
        author:   authorName,
        metadata: buildMeta(ev),
      }))
      const slug = 'my-articles'

      if (format === 'md' && combined) {
        exportChapterizedMd(resolved, 'My Articles')
      } else if (format === 'md') {
        const zip = new JSZip()
        for (let i = 0; i < resolved.length; i++) {
          const a    = resolved[i]
          const name = titleToSlug(a.metadata.title) || `article-${i + 1}`
          zip.file(name + '.md', buildFrontmatter(a.metadata, null) + a.content)
        }
        triggerDownload(await zip.generateAsync({ type: 'blob' }), slug + '-md.zip')
      } else if (format === 'epub' && combined) {
        await exportChapterizedEpub(resolved, 'My Articles')
      } else {
        const zip = new JSZip()
        for (let i = 0; i < resolved.length; i++) {
          const a    = resolved[i]
          const blob = await buildEpubBlob(a.content, a.metadata, null, a.author, '')
          const name = titleToSlug(a.metadata.title) || `article-${i + 1}`
          zip.file(name + '.epub', blob)
        }
        triggerDownload(await zip.generateAsync({ type: 'blob' }), slug + '-epubs.zip')
      }
      setExportStatus('done')
      setTimeout(() => setExportStatus(''), 2500)
    } catch (e) {
      setExportStatus('error')
      setExportError(e.message || 'Export failed')
    }
  }

  const busy = exportStatus === 'exporting'

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/60 z-20" onClick={onClose} aria-hidden="true" />

      {/* Drawer */}
      <div
        className="fixed top-0 left-0 h-full w-[480px] bg-neutral-900 border-r border-neutral-800 z-30 flex flex-col"
        role="dialog"
        aria-label="My published articles"
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-neutral-800 flex-shrink-0">
          <h2 className="text-sm font-semibold text-neutral-200 flex-shrink-0">My Articles</h2>

          {/* Export All controls */}
          {articles.length > 0 && !loading && (
            <div className="flex items-center gap-1 ml-2">
              {!pendingExport ? (
                <>
                  <span className="text-xs text-neutral-600">Export all</span>
                  <button onClick={() => { setExportStatus(''); setPendingExport('md') }} disabled={busy}
                    className="text-xs px-2 py-0.5 rounded border border-neutral-700 text-neutral-400 hover:text-neutral-200 hover:border-neutral-500 disabled:opacity-40 transition-colors">
                    .md
                  </button>
                  <button onClick={() => { setExportStatus(''); setPendingExport('epub') }} disabled={busy}
                    className="text-xs px-2 py-0.5 rounded border border-neutral-700 text-neutral-400 hover:text-neutral-200 hover:border-neutral-500 disabled:opacity-40 transition-colors">
                    .epub
                  </button>
                </>
              ) : (
                <>
                  <span className="text-xs text-neutral-500">
                    {pendingExport === 'md' ? '.md' : '.epub'}:
                  </span>
                  <button onClick={() => handleExportAll(pendingExport, false)} disabled={busy}
                    className="text-xs px-2 py-0.5 rounded border border-neutral-700 text-neutral-300 hover:text-white hover:border-neutral-500 disabled:opacity-40 transition-colors">
                    Separate .zip
                  </button>
                  <button onClick={() => handleExportAll(pendingExport, true)} disabled={busy}
                    className="text-xs px-2 py-0.5 rounded border border-purple-800 text-purple-300 hover:text-purple-100 hover:border-purple-600 disabled:opacity-40 transition-colors">
                    Combined
                  </button>
                  <button onClick={() => setPendingExport(null)} className="text-xs text-neutral-600 hover:text-neutral-400">✕</button>
                </>
              )}
              {exportStatus === 'exporting' && (
                <span className="w-3 h-3 border border-neutral-500 border-t-transparent rounded-full animate-spin inline-block ml-1" />
              )}
              {exportStatus === 'done'  && <span className="text-xs text-green-500 ml-1">✓</span>}
              {exportStatus === 'error' && <span className="text-xs text-red-400 ml-1">{exportError}</span>}
            </div>
          )}

          <button
            onClick={onClose}
            className="ml-auto text-neutral-500 hover:text-neutral-300 transition-colors text-lg leading-none flex-shrink-0"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {/* Article list */}
        <div className="flex-1 overflow-y-auto">
          {loading && (
            <div className="flex items-center justify-center h-32 gap-2 text-neutral-500 text-sm">
              <span className="w-4 h-4 border-2 border-neutral-600 border-t-transparent rounded-full animate-spin inline-block" />
              Loading…
            </div>
          )}

          {error && <div className="p-5 text-sm text-red-400">{error}</div>}

          {!loading && !error && articles.length === 0 && (
            <div className="p-5 text-sm text-neutral-500">
              No long-form articles found for this key.
            </div>
          )}

          {!loading && articles.map(event => {
            const title     = getTag(event, 'title') || '(untitled)'
            const image     = getTag(event, 'image')
            const summary   = getTag(event, 'summary')
            const pubAt     = getTag(event, 'published_at')
            const dateStr   = formatDate(pubAt || String(event.created_at))

            return (
              <button
                key={event.id}
                onClick={() => handleLoad(event)}
                className="w-full flex items-center gap-3 px-4 border-b border-neutral-800/60 hover:bg-neutral-800/50 transition-colors text-left group"
                style={{ height: '88px' }}
                aria-label={`Load article: ${title}`}
              >
                {/* Thumbnail */}
                <div className="w-14 h-14 rounded flex-shrink-0 bg-neutral-800 overflow-hidden">
                  {image && isSafeUrl(image) ? (
                    <img
                      src={image}
                      alt=""
                      className="w-full h-full object-cover"
                      onError={e => { e.target.style.display = 'none' }}
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-neutral-600 text-lg">✍️</div>
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
            )
          })}
        </div>

        {!loading && articles.length > 0 && (
          <div className="px-4 py-2 border-t border-neutral-800 flex-shrink-0">
            <p className="text-xs text-neutral-600">Click an article to load it into the editor.</p>
          </div>
        )}
      </div>
    </>
  )
}
