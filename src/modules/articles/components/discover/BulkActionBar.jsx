import { useState, useEffect, useRef } from 'react'
import JSZip from 'jszip'
import { getNDK } from '../../../../lib/ndk.js'
import { buildEpubBlob, exportChapterizedEpub, exportChapterizedMd } from '../../../../lib/epub.js'
import { titleToSlug, withTimeout } from '../../../../lib/utils.js'
import BookmarkIcon from '../../../../components/BookmarkIcon.jsx'

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
    const events = await withTimeout(
      ndk.fetchEvents({ kinds: [30023], authors: [pubkey], '#d': [dParts.join(':')] }),
      6000,
    )
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
export default function BulkActionBar({ articles, profiles, lists, onAddToList, onAddManyToList, onCreateList, onMoveArticle, onMoveArticlesBulk, onBulkMovePrivacy, onRemoveArticle, onRemoveArticlesBulk, onClearSelection, privacyView = 'public' }) {
  const [pendingExport,  setPendingExport]  = useState(null) // null | 'md' | 'epub'
  const [bookmarkOpen,   setBookmarkOpen]   = useState(false)
  const [moveOpen,       setMoveOpen]       = useState(false)
  const [newListInput,   setNewListInput]   = useState(false)
  const [newListName,    setNewListName]    = useState('')
  // Save-as target privacy — defaults to the current view so bulk-saving from
  // the Private panel stays private. Overridable via the in-dropdown pill.
  const [bookmarkPrivacy, setBookmarkPrivacy] = useState(privacyView === 'private' ? 'private' : 'public')
  // Move-to target privacy — defaults to current view so Move-to flips the
  // *list* without also flipping privacy.
  const [movePrivacy,     setMovePrivacy]     = useState(privacyView === 'private' ? 'private' : 'public')
  const [exportStatus,   setExportStatus]   = useState('')   // '' | 'fetching' | 'done' | 'error'
  const [exportError,    setExportError]    = useState('')
  const [bookmarkStatus, setBookmarkStatus] = useState('')   // '' | 'saving' | 'done' | 'error'
  const [moveStatus,     setMoveStatus]     = useState('')   // '' | 'moving' | 'done' | 'error'
  const [removeStatus,   setRemoveStatus]   = useState('')   // '' | 'removing' | 'error'
  const [privacyStatus,  setPrivacyStatus]  = useState('')   // '' | 'flipping' | 'done' | 'error'
  const bookmarkRef = useRef(null)
  const moveRef     = useRef(null)

  // Keep pill defaults in sync with the active view so switching Public↔Private
  // in the toolbar doesn't leave a stale default behind in the dropdowns.
  useEffect(() => {
    setBookmarkPrivacy(privacyView === 'private' ? 'private' : 'public')
    setMovePrivacy(privacyView === 'private' ? 'private' : 'public')
  }, [privacyView])

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

  function buildMetas() {
    return articles.map(article => ({
      aTag:      article._aTag || `30023:${article.pubkey}:${getTag(article, 'd')}`,
      title:     getTag(article, 'title') || 'Untitled',
      image:     getTag(article, 'image') || '',
      author:    article._authorName || profiles.get(article.pubkey)?.display_name || '',
      authorPic: article._authorPic || profiles.get(article.pubkey)?.picture || '',
      addedAt:   Date.now(),
    }))
  }

  // Batch into a single signed kind-10003 publish via onAddManyToList. Falls
  // back to looping onAddToList so older callers that don't pass the bulk
  // API still work, but note that path races itself (every addArticle signs
  // its own replaceable event, last one wins on the relay) and only exists
  // for graceful degradation — prefer passing onAddManyToList.
  async function saveMetasTo(listId) {
    setBookmarkStatus('saving')
    try {
      const metas = buildMetas()
      const opts = { privacy: bookmarkPrivacy }
      const ok = onAddManyToList
        ? await onAddManyToList(listId, metas, opts)
        : (await Promise.all(metas.map(m => onAddToList(listId, m, opts)))).every(Boolean)
      if (ok === false) {
        setBookmarkStatus('error')
        setTimeout(() => setBookmarkStatus(''), 3000)
        return
      }
      setBookmarkStatus('done')
      setTimeout(() => setBookmarkStatus(''), 2000)
    } catch {
      setBookmarkStatus('error')
      setTimeout(() => setBookmarkStatus(''), 3000)
    }
  }

  async function handleAddAllToList(listId) {
    setBookmarkOpen(false)
    setNewListInput(false)
    setNewListName('')
    await saveMetasTo(listId)
  }

  async function handleCreateAndAddAll() {
    const name = newListName.trim()
    if (!name) return
    setBookmarkOpen(false)
    setNewListInput(false)
    try {
      const list = await onCreateList(name)
      setNewListName('')
      await saveMetasTo(list.id)
    } catch {
      setBookmarkStatus('error')
      setTimeout(() => setBookmarkStatus(''), 3000)
    }
  }

  const busy = exportStatus === 'fetching'
    || bookmarkStatus === 'saving'
    || moveStatus === 'moving'
    || removeStatus === 'removing'
    || privacyStatus === 'flipping'

  // Group article aTags by their source list so one publish per source list
  // replaces N racing publishes that would otherwise overwrite each other.
  function groupATagsByListId() {
    const groups = new Map()
    for (const article of articles) {
      if (!article._listId) continue
      const aTag = article._aTag || article.id
      if (!groups.has(article._listId)) groups.set(article._listId, [])
      groups.get(article._listId).push(aTag)
    }
    return groups
  }

  async function handleMoveTo(toListId) {
    setMoveOpen(false)
    setMoveStatus('moving')
    try {
      const groups = groupATagsByListId()
      const opts = { privacy: movePrivacy }
      let allOk = true
      for (const [fromListId, aTags] of groups) {
        if (fromListId === toListId && movePrivacy === privacyView) continue
        const ok = onMoveArticlesBulk
          ? await onMoveArticlesBulk(fromListId, toListId, aTags, opts)
          : (await Promise.all(aTags.map(t => onMoveArticle(fromListId, toListId, t, opts)))).every(Boolean)
        if (ok === false) allOk = false
      }
      if (!allOk) {
        setMoveStatus('error')
        setTimeout(() => setMoveStatus(''), 3000)
        return
      }
      setMoveStatus('done')
      setTimeout(() => setMoveStatus(''), 2000)
    } catch {
      setMoveStatus('error')
      setTimeout(() => setMoveStatus(''), 3000)
    }
  }

  // Bulk flip privacy for already-bookmarked selection — one publish per list.
  async function handleBulkFlipPrivacy() {
    if (!onBulkMovePrivacy) return
    setPrivacyStatus('flipping')
    try {
      const groups = groupATagsByListId()
      const target = privacyView === 'private' ? 'public' : 'private'
      let allOk = true
      for (const [listId, aTags] of groups) {
        const ok = await onBulkMovePrivacy(listId, aTags, target)
        if (ok === false) allOk = false
      }
      if (!allOk) {
        setPrivacyStatus('error')
        setTimeout(() => setPrivacyStatus(''), 3000)
        return
      }
      setPrivacyStatus('done')
      setTimeout(() => setPrivacyStatus(''), 2000)
      onClearSelection()
    } catch {
      setPrivacyStatus('error')
      setTimeout(() => setPrivacyStatus(''), 3000)
    }
  }

  async function handleRemove() {
    setRemoveStatus('removing')
    try {
      const groups = groupATagsByListId()
      const opts = { privacy: privacyView }
      let allOk = true
      for (const [listId, aTags] of groups) {
        const ok = onRemoveArticlesBulk
          ? await onRemoveArticlesBulk(listId, aTags, opts)
          : (await Promise.all(aTags.map(t => onRemoveArticle(listId, t, opts)))).every(Boolean)
        if (ok === false) allOk = false
      }
      if (!allOk) {
        setRemoveStatus('error')
        setTimeout(() => setRemoveStatus(''), 3000)
        return
      }
      setRemoveStatus('')
      onClearSelection()
    } catch {
      setRemoveStatus('error')
      setTimeout(() => setRemoveStatus(''), 3000)
    }
  }

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
              className={`text-xs px-2 py-0.5 rounded border transition-colors disabled:opacity-60 inline-flex items-center gap-1 ${
                bookmarkStatus === 'done'
                  ? 'border-blue-800 text-blue-400'
                  : bookmarkStatus === 'error'
                  ? 'border-red-900/60 text-red-400'
                  : 'border-neutral-700 text-neutral-400 hover:text-neutral-200 hover:border-neutral-500'
              }`}
            >
              {bookmarkStatus === 'saving' ? (
                <>
                  <span className="w-3 h-3 border border-current border-t-transparent rounded-full animate-spin inline-block" />
                  <span>Saving…</span>
                </>
              ) : bookmarkStatus === 'error' ? (
                <span>⚠️ Failed</span>
              ) : (
                <>
                  <BookmarkIcon filled className="text-blue-400" />
                  <span>{bookmarkStatus === 'done' ? 'Bookmarked' : 'Bookmark'}</span>
                </>
              )}
            </button>
            {bookmarkOpen && (
              <div className="absolute left-0 top-full mt-1 bg-neutral-800 border border-neutral-700 rounded shadow-xl z-20 min-w-[200px]">
                {/* Save as: public/private pill — matches NoteActionsMenu. */}
                <div className="px-3 pt-2 pb-1.5 flex items-center justify-between gap-2 border-b border-neutral-700">
                  <span className="text-[10px] uppercase tracking-wide text-neutral-500">Save as</span>
                  <div className="inline-flex items-center rounded-full border border-neutral-700 bg-neutral-950 p-0.5">
                    <button
                      type="button"
                      onClick={() => setBookmarkPrivacy('public')}
                      className={`text-[10px] px-2 py-0.5 rounded-full transition-colors ${
                        bookmarkPrivacy === 'public' ? 'bg-purple-700 text-white' : 'text-neutral-400 hover:text-neutral-200'
                      }`}
                    >
                      Public
                    </button>
                    <button
                      type="button"
                      onClick={() => setBookmarkPrivacy('private')}
                      title="NIP-51 encrypted — visible only to you"
                      className={`text-[10px] px-2 py-0.5 rounded-full transition-colors inline-flex items-center gap-1 ${
                        bookmarkPrivacy === 'private' ? 'bg-purple-700 text-white' : 'text-neutral-400 hover:text-neutral-200'
                      }`}
                    >
                      <svg width="8" height="8" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                        <rect x="3.5" y="7" width="9" height="6.5" rx="1.2" />
                        <path d="M5.5 7V5a2.5 2.5 0 015 0v2" strokeLinecap="round" />
                      </svg>
                      Private
                    </button>
                  </div>
                </div>
                {lists.length === 0 ? (
                  <p className="px-3 py-2 text-xs text-neutral-500">No collections yet.</p>
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
                      placeholder="New collection name…" maxLength={60}
                      className="flex-1 bg-neutral-700 border border-neutral-600 rounded px-2 py-1 text-xs text-neutral-100 focus:outline-none" />
                    <button onClick={handleCreateAndAddAll} disabled={!newListName.trim()}
                      className="text-xs px-2 rounded bg-purple-700 hover:bg-purple-600 disabled:opacity-40 text-white transition-colors">✓</button>
                  </div>
                ) : (
                  <button onClick={() => setNewListInput(true)}
                    className="w-full text-left px-3 py-2 text-xs text-neutral-500 hover:text-neutral-300 border-t border-neutral-700 hover:bg-neutral-700 transition-colors">
                    + New collection
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
              className={`text-xs px-2 py-0.5 rounded border disabled:opacity-60 transition-colors inline-flex items-center gap-1 ${
                moveStatus === 'error'
                  ? 'border-red-900/60 text-red-400'
                  : 'border-neutral-700 text-neutral-400 hover:text-neutral-200 hover:border-neutral-500'
              }`}>
              {moveStatus === 'moving' ? (
                <>
                  <span className="w-3 h-3 border border-current border-t-transparent rounded-full animate-spin inline-block" />
                  <span>Moving…</span>
                </>
              ) : moveStatus === 'done' ? '✓ Moved'
                : moveStatus === 'error' ? '⚠️ Failed'
                : 'Move to'}
            </button>
            {moveOpen && (
              <div className="absolute left-0 top-full mt-1 bg-neutral-800 border border-neutral-700 rounded shadow-xl z-20 min-w-[200px]">
                {/* Save as: public/private pill — matches NoteActionsMenu. */}
                <div className="px-3 pt-2 pb-1.5 flex items-center justify-between gap-2 border-b border-neutral-700">
                  <span className="text-[10px] uppercase tracking-wide text-neutral-500">Save as</span>
                  <div className="inline-flex items-center rounded-full border border-neutral-700 bg-neutral-950 p-0.5">
                    <button
                      type="button"
                      onClick={() => setMovePrivacy('public')}
                      className={`text-[10px] px-2 py-0.5 rounded-full transition-colors ${
                        movePrivacy === 'public' ? 'bg-purple-700 text-white' : 'text-neutral-400 hover:text-neutral-200'
                      }`}
                    >
                      Public
                    </button>
                    <button
                      type="button"
                      onClick={() => setMovePrivacy('private')}
                      title="NIP-51 encrypted — visible only to you"
                      className={`text-[10px] px-2 py-0.5 rounded-full transition-colors inline-flex items-center gap-1 ${
                        movePrivacy === 'private' ? 'bg-purple-700 text-white' : 'text-neutral-400 hover:text-neutral-200'
                      }`}
                    >
                      <svg width="8" height="8" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                        <rect x="3.5" y="7" width="9" height="6.5" rx="1.2" />
                        <path d="M5.5 7V5a2.5 2.5 0 015 0v2" strokeLinecap="round" />
                      </svg>
                      Private
                    </button>
                  </div>
                </div>
                {lists.map(list => (
                  <button key={list.id}
                    onClick={() => handleMoveTo(list.id)}
                    className="w-full text-left px-3 py-2 text-xs text-neutral-300 hover:bg-neutral-700 transition-colors truncate">
                    {list.title}
                  </button>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {/* Bulk privacy flip — only meaningful for already-bookmarked items. The
          button label reflects the opposite of the current view. */}
      {onBulkMovePrivacy && articles.some(a => a._listId) && (
        <>
          <span className="text-neutral-700 mx-0.5 flex-shrink-0">|</span>
          <button
            onClick={handleBulkFlipPrivacy}
            disabled={busy}
            className={`text-xs px-2 py-0.5 rounded border disabled:opacity-60 transition-colors inline-flex items-center gap-1 ${
              privacyStatus === 'error'
                ? 'border-red-900/60 text-red-400'
                : 'border-neutral-700 text-neutral-400 hover:text-neutral-200 hover:border-neutral-500'
            }`}>
            {privacyStatus === 'flipping' ? (
              <>
                <span className="w-3 h-3 border border-current border-t-transparent rounded-full animate-spin inline-block" />
                <span>Flipping…</span>
              </>
            ) : privacyStatus === 'done' ? '✓ Flipped'
              : privacyStatus === 'error' ? '⚠️ Failed'
              : privacyView === 'private' ? 'Make public' : 'Make private'}
          </button>
        </>
      )}

      {/* Bulk remove — only for bookmark items */}
      {onRemoveArticle && articles.some(a => a._listId) && (
        <>
          <span className="text-neutral-700 mx-0.5 flex-shrink-0">|</span>
          <button
            onClick={handleRemove}
            disabled={busy}
            className="text-xs px-2 py-0.5 rounded border border-red-900/60 text-red-400 hover:text-red-300 hover:border-red-700 disabled:opacity-40 transition-colors inline-flex items-center gap-1">
            {removeStatus === 'removing' ? (
              <>
                <span className="w-3 h-3 border border-current border-t-transparent rounded-full animate-spin inline-block" />
                <span>Removing…</span>
              </>
            ) : removeStatus === 'error' ? '⚠️ Failed' : 'Remove'}
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
