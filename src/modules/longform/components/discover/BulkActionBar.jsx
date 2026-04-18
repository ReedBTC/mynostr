import { useState, useEffect, useRef } from 'react'
import JSZip from 'jszip'
import { getNDK } from '../../../../lib/ndk.js'
import { buildEpubBlob, exportChapterizedEpub, exportChapterizedMd } from '../../../../lib/epub.js'
import { titleToSlug } from '../../../../lib/utils.js'

function getTag(event, name) {
  return event.tags?.find(t => t[0] === name)?.[1] || ''
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename; a.click()
  URL.revokeObjectURL(url)
}

// Resolve full article data — uses event.content if present, fetches from NDK if not
async function resolveContent(article) {
  if (article.content) return article.content
  const aTag = article._aTag || `30023:${article.pubkey}:${getTag(article, 'd')}`
  const [, pubkey, ...dParts] = aTag.split(':')
  try {
    const ndk = getNDK()
    const events = await Promise.race([
      ndk.fetchEvents({ kinds: [30023], authors: [pubkey], '#d': [dParts.join(':')] }),
      new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 6000)),
    ])
    return Array.from(events)[0]?.content || ''
  } catch { return '' }
}

function buildMeta(article) {
  return {
    title:           getTag(article, 'title') || 'Untitled',
    summary:         getTag(article, 'summary') || '',
    image:           getTag(article, 'image')   || '',
    publishedAtDate: article.created_at
      ? new Date(article.created_at * 1000).toISOString().split('T')[0]
      : '',
    tags: article.tags?.filter(t => t[0] === 't').map(t => t[1]) || [],
  }
}

/**
 * Toolbar shown when articles are checked in the feed or bookmarks.
 * Props:
 *   articles   — array of article objects (events or fake bookmark events)
 *   profiles   — Map<pubkey, profile> for resolving display names
 *   lists      — reading lists for "Bookmark" dropdown
 *   onAddToList(listId, meta) — add single article to list
 *   onCreateList(name)        — create a new reading list
 *   onClearSelection()
 */
export default function BulkActionBar({ articles, profiles, lists, onAddToList, onCreateList, onMoveArticle, onRemoveArticle, onClearSelection }) {
  const [pendingExport,  setPendingExport]  = useState(null) // null | 'md' | 'epub'
  const [bookmarkOpen,   setBookmarkOpen]   = useState(false)
  const [moveOpen,       setMoveOpen]       = useState(false)
  const [newListInput,   setNewListInput]   = useState(false)
  const [newListName,    setNewListName]    = useState('')
  const [exportStatus,   setExportStatus]   = useState('')   // '' | 'fetching' | 'done' | 'error'
  const [exportError,    setExportError]    = useState('')
  const [bookmarkStatus, setBookmarkStatus] = useState('')   // '' | 'saving' | 'done'
  const [moveStatus,     setMoveStatus]     = useState('')   // '' | 'moving' | 'done'
  const bookmarkRef = useRef(null)
  const moveRef     = useRef(null)

  // Close bookmark dropdown on outside click
  useEffect(() => {
    if (!bookmarkOpen) return
    function handler(e) {
      if (bookmarkRef.current && !bookmarkRef.current.contains(e.target)) {
        setBookmarkOpen(false); setNewListInput(false); setNewListName('')
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [bookmarkOpen])

  // Close move dropdown on outside click
  useEffect(() => {
    if (!moveOpen) return
    function handler(e) {
      if (moveRef.current && !moveRef.current.contains(e.target)) setMoveOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [moveOpen])

  const count = articles.length
  if (!count) return null

  // ── Resolve all selected articles ───────────────────────────────────────────

  async function resolveAll() {
    setExportStatus('fetching')
    const out = []
    for (const article of articles) {
      const content    = await resolveContent(article)
      const authorName = article._authorName
        || profiles.get(article.pubkey)?.display_name
        || profiles.get(article.pubkey)?.name
        || ''
      out.push({ content, author: authorName, metadata: buildMeta(article) })
    }
    return out
  }

  // ── Export handlers ─────────────────────────────────────────────────────────

  async function handleExport(format, combined) {
    setPendingExport(null)
    try {
      const resolved = await resolveAll()
      const slug = 'selected-articles'

      if (format === 'md' && combined) {
        exportChapterizedMd(resolved, 'Selected Articles')
      } else if (format === 'md') {
        const zip = new JSZip()
        for (let i = 0; i < resolved.length; i++) {
          const a    = resolved[i]
          const name = titleToSlug(a.metadata.title) || `article-${i + 1}`
          zip.file(name + '.md', `# ${a.metadata.title}\n\n${a.content}`)
        }
        triggerDownload(await zip.generateAsync({ type: 'blob' }), slug + '-md.zip')
      } else if (format === 'epub' && combined) {
        await exportChapterizedEpub(resolved, 'Selected Articles')
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
    } catch (e) {
      setExportStatus('error')
      setExportError(e.message || 'Export failed')
    }
  }

  // ── Bookmark handlers ───────────────────────────────────────────────────────

  async function handleAddAllToList(listId) {
    setBookmarkOpen(false)
    setNewListInput(false)
    setNewListName('')
    setBookmarkStatus('saving')
    for (const article of articles) {
      await onAddToList(listId, {
        aTag:      article._aTag || `30023:${article.pubkey}:${getTag(article, 'd')}`,
        title:     getTag(article, 'title') || 'Untitled',
        image:     getTag(article, 'image') || '',
        author:    article._authorName || profiles.get(article.pubkey)?.display_name || '',
        authorPic: article._authorPic || profiles.get(article.pubkey)?.picture || '',
        addedAt:   Date.now(),
      })
    }
    setBookmarkStatus('done')
    setTimeout(() => setBookmarkStatus(''), 2000)
  }

  async function handleCreateAndAddAll() {
    const name = newListName.trim()
    if (!name) return
    setBookmarkStatus('saving')
    try {
      const list = await onCreateList(name)
      await handleAddAllToList(list.id)
    } catch {
      setBookmarkStatus('')
    }
  }

  const busy = exportStatus === 'fetching' || bookmarkStatus === 'saving' || moveStatus === 'moving'

  return (
    <div className="flex items-center gap-1.5 px-3 py-2 bg-neutral-900 border-b border-neutral-800 flex-shrink-0 flex-wrap">
      <span className="text-xs text-neutral-400 mr-1 flex-shrink-0">{count} selected</span>

      {/* Export controls */}
      {!pendingExport ? (
        <>
          <span className="text-xs text-neutral-600 flex-shrink-0">Export</span>
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
          <span className="text-xs text-neutral-500 flex-shrink-0">
            {pendingExport === 'md' ? '.md' : '.epub'} format:
          </span>
          <button onClick={() => handleExport(pendingExport, false)} disabled={busy}
            className="text-xs px-2 py-0.5 rounded border border-neutral-700 text-neutral-300 hover:text-white hover:border-neutral-500 disabled:opacity-40 transition-colors">
            Separate .zip
          </button>
          <button onClick={() => handleExport(pendingExport, true)} disabled={busy}
            className="text-xs px-2 py-0.5 rounded border border-purple-800 text-purple-300 hover:text-purple-100 hover:border-purple-600 disabled:opacity-40 transition-colors">
            Combined
          </button>
          <button onClick={() => setPendingExport(null)} className="text-xs text-neutral-600 hover:text-neutral-400">✕</button>
        </>
      )}

      {/* Bookmark dropdown — only when a session user can actually save lists.
          In readOnly (not-logged-in) mode the parent passes onAddToList=null,
          so the bookmark controls collapse out and the bar becomes export-only. */}
      {onAddToList && (
        <>
          <span className="text-neutral-700 mx-0.5 flex-shrink-0">|</span>
          <div className="relative flex-shrink-0" ref={bookmarkRef}>
            <button
              onClick={() => { setBookmarkOpen(o => !o); setNewListInput(false) }}
              disabled={busy}
              className={`text-xs px-2 py-0.5 rounded border transition-colors disabled:opacity-40 ${
                bookmarkStatus === 'done'
                  ? 'border-amber-800 text-amber-400'
                  : 'border-neutral-700 text-neutral-400 hover:text-neutral-200 hover:border-neutral-500'
              }`}
            >
              {bookmarkStatus === 'done' ? '🔖 Bookmarked' : bookmarkStatus === 'saving' ? '…' : '🔖 Bookmark'}
            </button>
            {bookmarkOpen && (
              <div className="absolute left-0 top-full mt-1 bg-neutral-800 border border-neutral-700 rounded shadow-xl z-20 min-w-[180px]">
                {lists.length === 0 ? (
                  <p className="px-3 py-2 text-xs text-neutral-500">No lists yet.</p>
                ) : (
                  lists.map(list => (
                    <button key={list.id} onClick={() => handleAddAllToList(list.id)}
                      className="w-full text-left px-3 py-2 text-xs text-neutral-300 hover:bg-neutral-700 transition-colors">
                      {list.title}
                    </button>
                  ))
                )}
                {newListInput ? (
                  <div className="px-2 py-2 border-t border-neutral-700 flex gap-1">
                    <input autoFocus type="text" value={newListName} onChange={e => setNewListName(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && handleCreateAndAddAll()}
                      placeholder="List name…" maxLength={60}
                      className="flex-1 bg-neutral-700 border border-neutral-600 rounded px-2 py-1 text-xs text-neutral-100 focus:outline-none" />
                    <button onClick={handleCreateAndAddAll} disabled={!newListName.trim()}
                      className="text-xs px-2 rounded bg-purple-700 hover:bg-purple-600 disabled:opacity-40 text-white transition-colors">✓</button>
                  </div>
                ) : (
                  <button onClick={() => setNewListInput(true)}
                    className="w-full text-left px-3 py-2 text-xs text-neutral-500 hover:text-neutral-300 border-t border-neutral-700 hover:bg-neutral-700 transition-colors">
                    + New list
                  </button>
                )}
              </div>
            )}
          </div>
        </>
      )}

      {/* Move to — only for bookmark items that have a _listId */}
      {onMoveArticle && articles.some(a => a._listId) && (
        <>
          <span className="text-neutral-700 mx-0.5 flex-shrink-0">|</span>
          <div className="relative flex-shrink-0" ref={moveRef}>
            <button
              onClick={() => { setMoveOpen(o => !o) }}
              disabled={busy}
              className="text-xs px-2 py-0.5 rounded border border-neutral-700 text-neutral-400 hover:text-neutral-200 hover:border-neutral-500 disabled:opacity-40 transition-colors">
              {moveStatus === 'done' ? '✓ Moved' : moveStatus === 'moving' ? '…' : 'Move to'}
            </button>
            {moveOpen && (
              <div className="absolute left-0 top-full mt-1 bg-neutral-800 border border-neutral-700 rounded shadow-xl z-20 min-w-[180px]">
                {lists.map(list => (
                  <button key={list.id}
                    onClick={async () => {
                      setMoveOpen(false)
                      setMoveStatus('moving')
                      for (const article of articles) {
                        if (article._listId && article._listId !== list.id) {
                          await onMoveArticle(article._listId, list.id, article._aTag || article.id)
                        }
                      }
                      setMoveStatus('done')
                      setTimeout(() => setMoveStatus(''), 2000)
                    }}
                    className="w-full text-left px-3 py-2 text-xs text-neutral-300 hover:bg-neutral-700 transition-colors truncate">
                    {list.title}
                  </button>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {/* Bulk remove — only for bookmark items */}
      {onRemoveArticle && articles.some(a => a._listId) && (
        <>
          <span className="text-neutral-700 mx-0.5 flex-shrink-0">|</span>
          <button
            onClick={async () => {
              for (const article of articles) {
                if (article._listId) {
                  await onRemoveArticle(article._listId, article._aTag || article.id)
                }
              }
              onClearSelection()
            }}
            disabled={busy}
            className="text-xs px-2 py-0.5 rounded border border-red-900/60 text-red-400 hover:text-red-300 hover:border-red-700 disabled:opacity-40 transition-colors">
            Remove
          </button>
        </>
      )}

      {/* Status */}
      {exportStatus === 'fetching' && (
        <span className="text-xs text-neutral-500 flex items-center gap-1">
          <span className="w-3 h-3 border border-neutral-500 border-t-transparent rounded-full animate-spin inline-block" />
          Fetching…
        </span>
      )}
      {exportStatus === 'done'  && <span className="text-xs text-green-500">✓ exported</span>}
      {exportStatus === 'error' && <span className="text-xs text-red-400">{exportError}</span>}

      {/* Clear */}
      <button onClick={onClearSelection} className="ml-auto text-xs text-neutral-600 hover:text-neutral-400 transition-colors">
        × clear
      </button>
    </div>
  )
}
