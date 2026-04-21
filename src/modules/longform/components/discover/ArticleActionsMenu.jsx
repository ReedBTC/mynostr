import { useState, useEffect, useRef } from 'react'
import { nip19 } from 'nostr-tools'
import { exportEpub } from '../../../../lib/epub.js'
import { titleToSlug, buildFrontmatter, copyToClipboard, getPublishedAt, getPublishedAtDate, withTimeout } from '../../../../lib/utils.js'
import { getNDK, connectAndWait } from '../../../../lib/ndk.js'

/**
 * Shared three-dots action menu used by:
 *   - Article feed items (My Articles / Search results)
 *   - The reader pane header
 *   - Bookmarked items in the Collection feed
 *
 * Renders only the absolutely-positioned popup — the parent owns the trigger
 * button and a relatively-positioned container. Closed by calling onClose.
 *
 * Sections are conditional: a section is only rendered when its props are
 * present, so each call site gets exactly the actions that make sense for it.
 */
export default function ArticleActionsMenu({
  open,
  onClose,
  article,
  title,
  summary,
  image,
  tTags,
  content,              // export body; omit to hide Export items
  lists,                // optional — enables "Add to bookmarks" submenu
  onAddToList,
  onMoveArticle,        // optional — when set + article._listId, list picks become a move instead of an add
  onRemoveFromList,     // optional — enables "Remove from bookmarks" for already-bookmarked items
  onCreateList,
  onMovePrivacy,        // optional — enables Make public/private toggle for already-bookmarked items
  defaultPrivacy,       // 'public' (default) | 'private' — initial pill position
  authorName,           // used as bookmark metadata + epub author
  authorPic,
  onLoadInEditor,       // optional — enables "Load in editor"
}) {
  const [listSubmenu, setListSubmenu] = useState(false)
  const [newListName, setNewListName] = useState('')
  const [addPrivacy,  setAddPrivacy]  = useState(defaultPrivacy === 'private' ? 'private' : 'public')
  const [copied,      setCopied]      = useState(null) // 'naddr' | 'url' | null
  const [exporting,   setExporting]   = useState(null) // 'md' | 'epub' | null
  // Bookmark write state. While `pendingAction` is set we show a spinner and
  // lock the menu so the user can't race a second sign/publish on top of
  // the first. On failure we park `actionError` so the user sees that the
  // change didn't land — no more silently pretending it worked.
  const [pendingAction, setPendingAction] = useState(null) // 'add' | 'move' | 'create' | 'flip' | 'remove' | null
  const [actionError,   setActionError]   = useState('')
  // Guards against setState after unmount — user may close the menu (and thus
  // unmount this component) while an export fetch is still in flight.
  const mountedRef = useRef(true)
  useEffect(() => () => { mountedRef.current = false }, [])

  if (!open) return null

  const dTag     = article.tags?.find(t => t[0] === 'd')?.[1] || ''
  const aTag     = article._aTag || (article.pubkey && dTag ? `30023:${article.pubkey}:${dTag}` : '')
  const safeTags = Array.isArray(tTags) ? tTags : []

  function getNaddr() {
    try { return nip19.naddrEncode({ kind: 30023, pubkey: article.pubkey, identifier: dTag }) }
    catch { return null }
  }

  async function handleCopy(kind) {
    const naddr = getNaddr()
    if (!naddr) return
    const text = kind === 'url' ? `https://njump.me/${naddr}` : naddr
    const ok = await copyToClipboard(text)
    if (!ok) return
    setCopied(kind)
    // Keep menu open briefly so the user sees the confirmation.
    setTimeout(() => {
      setCopied(null)
      onClose?.()
    }, 1200)
  }

  // Close the menu on a successful publish; otherwise keep it open and park
  // the error so the user can retry. Every bookmark handler funnels through
  // here so the close/error semantics stay consistent.
  function finishAction(ok, errorMessage = 'Save failed — tap to retry') {
    if (!mountedRef.current) return
    if (ok) {
      setPendingAction(null)
      setActionError('')
      setListSubmenu(false)
      onClose?.()
    } else {
      setPendingAction(null)
      setActionError(errorMessage)
    }
  }

  // When the article is already bookmarked in some list, picking a target list
  // is a MOVE (remove from source, add to target) — not an add. Otherwise this
  // is a fresh bookmark onto the article.
  async function addToList(listId) {
    if (!aTag || pendingAction) return
    setActionError('')
    const isAlreadyBookmarked = !!article?._listId
    setPendingAction(isAlreadyBookmarked && onMoveArticle ? 'move' : 'add')
    try {
      let ok
      if (isAlreadyBookmarked && onMoveArticle) {
        ok = await onMoveArticle(article._listId, listId, aTag, { privacy: addPrivacy })
      } else {
        ok = await onAddToList(listId, {
          aTag,
          title: title || '',
          image: image || '',
          author: authorName || '',
          authorPic: authorPic || '',
          addedAt: Date.now(),
          publishedAt: getPublishedAt(article),
          tTags: safeTags,
        }, { privacy: addPrivacy })
      }
      finishAction(ok !== false)
    } catch {
      finishAction(false)
    }
  }

  async function createAndAdd() {
    const name = newListName.trim()
    if (!name || pendingAction) return
    setActionError('')
    setPendingAction('create')
    try {
      const list = await onCreateList(name)
      if (!list) { finishAction(false); return }
      // addToList will manage its own pending state after we clear ours.
      setPendingAction(null)
      setNewListName('')
      await addToList(list.id)
    } catch {
      finishAction(false)
    }
  }

  async function handleMovePrivacy() {
    if (!onMovePrivacy || !article?._listId || !aTag || pendingAction) return
    setActionError('')
    setPendingAction('flip')
    try {
      const newPrivacy = article._privacy === 'private' ? 'public' : 'private'
      const ok = await onMovePrivacy(article._listId, aTag, newPrivacy)
      finishAction(ok !== false)
    } catch {
      finishAction(false)
    }
  }

  async function handleRemove() {
    if (!onRemoveFromList || !article?._listId || !aTag || pendingAction) return
    setActionError('')
    setPendingAction('remove')
    try {
      const ok = await onRemoveFromList(article._listId, aTag, {
        privacy: article._privacy || 'public',
      })
      finishAction(ok !== false, 'Remove failed — tap to retry')
    } catch {
      finishAction(false, 'Remove failed — tap to retry')
    }
  }

  // Collection items are synthetic — they carry metadata but no body content.
  // Fetch the real kind-30023 event on-demand so Export works there too.
  async function ensureContent() {
    if (content) return { content, tags: article.tags || [], created_at: article.created_at }
    if (!article.pubkey || !dTag) return null
    const ndk = getNDK()
    await connectAndWait(ndk, 3000).catch(() => {})
    const events = await withTimeout(
      ndk.fetchEvents({
        kinds: [30023], authors: [article.pubkey], '#d': [dTag],
      }),
      8000,
      'fetch-timeout'
    ).catch(() => null)
    if (!events) return null
    const ev = Array.from(events)[0]
    if (!ev) return null
    return { content: ev.content || '', tags: ev.tags || [], created_at: ev.created_at }
  }

  async function handleExportMd() {
    setExporting('md')
    try {
      const resolved = await ensureContent()
      if (!resolved?.content) return
      const tTagsResolved = resolved.tags.filter(t => t[0] === 't').map(t => t[1])
      const slug = titleToSlug(title) || 'article'
      const metadata = {
        title:   title   || '',
        summary: summary || '',
        publishedAtDate: getPublishedAtDate(resolved),
        image:   image   || '',
        tags:    tTagsResolved.length ? tTagsResolved : safeTags,
      }
      const frontmatter = buildFrontmatter(metadata, null)
      const blob = new Blob([frontmatter + resolved.content], { type: 'text/markdown;charset=utf-8' })
      const url  = URL.createObjectURL(blob)
      const a    = document.createElement('a')
      a.href = url; a.download = slug + '.md'; a.click()
      URL.revokeObjectURL(url)
    } finally {
      if (mountedRef.current) {
        setExporting(null)
        onClose?.()
      }
    }
  }

  async function handleExportEpub() {
    setExporting('epub')
    try {
      const resolved = await ensureContent()
      if (!resolved?.content) return
      const tTagsResolved = resolved.tags.filter(t => t[0] === 't').map(t => t[1])
      await exportEpub(
        resolved.content,
        {
          title:   title   || '',
          summary: summary || '',
          image:   image   || '',
          publishedAtDate: getPublishedAtDate(resolved),
          tags:    tTagsResolved.length ? tTagsResolved : safeTags,
        },
        null, authorName || '', ''
      )
    } finally {
      if (mountedRef.current) {
        setExporting(null)
        onClose?.()
      }
    }
  }

  function handleLoadInEditor() {
    if (!onLoadInEditor) return
    onLoadInEditor({
      content: content || article.content || '',
      metadata: {
        title:   title   || '',
        summary: summary || '',
        publishedAtDate: getPublishedAtDate(article),
        image:   image   || '',
        tagsRaw: safeTags.join(', '),
        tags:    safeTags,
      },
      naddr: getNaddr() || '',
    })
    onClose?.()
  }

  const canBookmark = lists && onAddToList && onCreateList && aTag
  const canExport   = !!content || (article.pubkey && !!dTag)
  const canLoad     = !!onLoadInEditor
  const canMovePrivacy = !!onMovePrivacy && !!article?._listId && !!article?._privacy && !!aTag
  const canRemove      = !!onRemoveFromList && !!article?._listId && !!aTag
  const isBookmarked   = !!article?._listId

  return (
    <div
      className="absolute right-0 top-full mt-1 bg-neutral-800 border border-neutral-700 rounded shadow-xl z-30 min-w-[200px] max-h-[70vh] overflow-y-auto"
      onMouseDown={e => e.stopPropagation()}
      onClick={e => e.stopPropagation()}
    >
      {canBookmark && (
        <>
          <button
            onClick={() => { if (!pendingAction) setListSubmenu(o => !o) }}
            disabled={!!pendingAction}
            className={`w-full text-left px-3 py-2 text-xs transition-colors flex items-center justify-between ${
              actionError && (pendingAction === null)
                ? 'text-red-400 hover:bg-red-950/40'
                : 'text-neutral-300 hover:bg-neutral-700'
            } disabled:opacity-60`}
          >
            <span className="inline-flex items-center gap-1.5">
              {pendingAction === 'add' || pendingAction === 'move' || pendingAction === 'create' ? (
                <>
                  <span className="w-3 h-3 border border-current border-t-transparent rounded-full animate-spin inline-block" />
                  <span>Saving…</span>
                </>
              ) : actionError && !pendingAction ? (
                <span>⚠️ {actionError}</span>
              ) : (
                <span>{isBookmarked && onMoveArticle ? 'Move to…' : 'Add to bookmarks'}</span>
              )}
            </span>
            <span className="text-neutral-600 text-[10px]">{listSubmenu ? '▲' : '▼'}</span>
          </button>
          {listSubmenu && (
            <div className="border-t border-neutral-700">
              <div className="px-3 py-1.5 flex items-center justify-center">
                <div className="inline-flex items-center rounded-full border border-neutral-700 bg-neutral-900 p-0.5">
                  {[
                    { key: 'public',  label: 'Public'  },
                    { key: 'private', label: 'Private' },
                  ].map(opt => {
                    const active = addPrivacy === opt.key
                    return (
                      <button
                        key={opt.key}
                        type="button"
                        onClick={() => setAddPrivacy(opt.key)}
                        disabled={!!pendingAction}
                        className={`text-[10px] px-2 py-0.5 rounded-full transition-colors disabled:opacity-40 ${
                          active
                            ? (opt.key === 'private' ? 'bg-neutral-700 text-neutral-100' : 'bg-purple-700 text-white')
                            : 'text-neutral-500 hover:text-neutral-300'
                        }`}
                      >
                        {opt.label}
                      </button>
                    )
                  })}
                </div>
              </div>
              {lists.map(list => (
                <button
                  key={list.id}
                  onClick={() => addToList(list.id)}
                  disabled={!!pendingAction}
                  className="w-full text-left px-4 py-1.5 text-xs text-neutral-400 hover:bg-neutral-700 transition-colors truncate disabled:opacity-50"
                >
                  {list.title}
                </button>
              ))}
              <div className="px-3 py-1.5 flex gap-1">
                <input
                  type="text"
                  value={newListName}
                  onChange={e => setNewListName(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') createAndAdd()
                    if (e.key === 'Escape') setListSubmenu(false)
                  }}
                  placeholder="New group…"
                  maxLength={60}
                  disabled={!!pendingAction}
                  className="flex-1 bg-neutral-700 border border-neutral-600 rounded px-2 py-1 text-xs text-neutral-100 focus:outline-none disabled:opacity-60"
                />
                <button
                  onClick={createAndAdd}
                  disabled={!newListName.trim() || !!pendingAction}
                  className="text-xs px-2 py-1 rounded bg-purple-700 hover:bg-purple-600 disabled:opacity-40 text-white transition-colors inline-flex items-center gap-1"
                >
                  {pendingAction === 'create' ? (
                    <span className="w-3 h-3 border border-current border-t-transparent rounded-full animate-spin inline-block" />
                  ) : '✓'}
                </button>
              </div>
            </div>
          )}
          {canMovePrivacy && (
            <button
              onClick={handleMovePrivacy}
              disabled={!!pendingAction}
              className="w-full text-left px-3 py-2 text-xs text-neutral-300 hover:bg-neutral-700 transition-colors border-t border-neutral-700 disabled:opacity-60 inline-flex items-center gap-1.5"
            >
              {pendingAction === 'flip' ? (
                <>
                  <span className="w-3 h-3 border border-current border-t-transparent rounded-full animate-spin inline-block" />
                  <span>Saving…</span>
                </>
              ) : (article._privacy === 'private' ? 'Make public' : 'Make private')}
            </button>
          )}
          {canRemove && (
            <button
              onClick={handleRemove}
              disabled={!!pendingAction}
              className="w-full text-left px-3 py-2 text-xs text-red-400 hover:bg-red-950/40 transition-colors border-t border-neutral-700 disabled:opacity-60 inline-flex items-center gap-1.5"
            >
              {pendingAction === 'remove' ? (
                <>
                  <span className="w-3 h-3 border border-current border-t-transparent rounded-full animate-spin inline-block" />
                  <span>Removing…</span>
                </>
              ) : 'Remove from bookmarks'}
            </button>
          )}
          <div className="border-t border-neutral-700" />
        </>
      )}

      <button
        onClick={() => handleCopy('naddr')}
        className="w-full text-left px-3 py-2 text-xs text-neutral-300 hover:bg-neutral-700 transition-colors"
      >
        {copied === 'naddr' ? '✓ Copied!' : 'Copy naddr'}
      </button>
      <button
        onClick={() => handleCopy('url')}
        className="w-full text-left px-3 py-2 text-xs text-neutral-300 hover:bg-neutral-700 transition-colors"
      >
        {copied === 'url' ? '✓ Copied!' : 'Copy URL'}
      </button>

      {(canLoad || canExport) && <div className="border-t border-neutral-700" />}

      {canLoad && (
        <button
          onClick={handleLoadInEditor}
          className="w-full text-left px-3 py-2 text-xs text-neutral-300 hover:bg-neutral-700 transition-colors"
        >
          Load in editor
        </button>
      )}
      {canExport && (
        <>
          <button
            onClick={handleExportMd}
            disabled={exporting === 'md'}
            className="w-full text-left px-3 py-2 text-xs text-neutral-300 hover:bg-neutral-700 transition-colors disabled:opacity-50"
          >
            {exporting === 'md' ? 'Exporting…' : 'Export .md'}
          </button>
          <button
            onClick={handleExportEpub}
            disabled={exporting === 'epub'}
            className="w-full text-left px-3 py-2 text-xs text-neutral-300 hover:bg-neutral-700 transition-colors disabled:opacity-50"
          >
            {exporting === 'epub' ? 'Exporting…' : 'Export .epub'}
          </button>
        </>
      )}
    </div>
  )
}
