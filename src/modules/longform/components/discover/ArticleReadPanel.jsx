import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import MDEditor from '@uiw/react-md-editor'
import rehypeSanitize from 'rehype-sanitize'
import { NDKEvent } from '@nostr-dev-kit/ndk'
import { nip19 } from 'nostr-tools'
import { isSafeUrl, getPublishedAt } from '../../../../lib/utils.js'
import { getNDK, signWithTimeout } from '../../../../lib/ndk.js'
import ZapModal from '../../../../components/ZapModal.jsx'
import ArticleActionsMenu from './ArticleActionsMenu.jsx'

function getTag(event, name) {
  return event.tags?.find(t => t[0] === name)?.[1] || ''
}

function isHexOrNpub(str) {
  if (!str) return false
  return /^[a-f0-9]{6,}$/i.test(str) || str.startsWith('npub')
}

function formatDate(unixTs) {
  if (!unixTs) return ''
  return new Date(unixTs * 1000).toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric',
  })
}

export default function ArticleReadPanel({
  article,
  profile,
  lists,
  onAddToList,
  onCreateList,
  onMoveArticle,
  onMovePrivacy,
  onRemoveFromList,
  onLoadInEditor,
  defaultPrivacy = 'public',
  onClose,
  onAuthorClick,
  readOnly,
  user,
  isMobile,
}) {
  const navigate = useNavigate()

  const [listMenuOpen,   setListMenuOpen]   = useState(false)
  // 'idle' | 'saving' | 'error' — drives spinner/label on the Bookmark button
  // and gates handlers so a double-tap can't race two publishes.
  const [bookmarkStatus, setBookmarkStatus] = useState('idle')
  const [savedToList,    setSavedToList]    = useState(null)
  const [newListInput,   setNewListInput]   = useState(false)
  const [newListName,    setNewListName]    = useState('')
  const [menuOpen,       setMenuOpen]       = useState(false)
  const menuRef = useRef(null)
  const listMenuRef = useRef(null)

  // Social actions
  const [liked,        setLiked]        = useState(false)
  const [liking,       setLiking]       = useState(false)
  const [zapOpen,      setZapOpen]      = useState(false)
  const [zapLud16,     setZapLud16]     = useState(profile?.lud16 || null)
  const [zapFetching,  setZapFetching]  = useState(false)
  const [repostOpen,   setRepostOpen]   = useState(false)
  const [reposting,    setReposting]    = useState(false)
  const [repostDone,   setRepostDone]   = useState(false)

  // For bookmark articles that have empty content — fetch on mount
  const [displayContent,   setDisplayContent]   = useState(article.content || '')
  const [resolvedTags,     setResolvedTags]     = useState(null)
  const [fetchingContent,  setFetchingContent]  = useState(false)
  // Parent passes key={selected.id} so this component remounts per article;
  // no explicit reset needed, fresh useState(false) gives us a clean flag.
  const [coverBroken,      setCoverBroken]      = useState(false)

  // Close three-dots menu on outside click
  useEffect(() => {
    if (!menuOpen) return
    function handler(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [menuOpen])

  // Close bookmark dropdown on outside click
  useEffect(() => {
    if (!listMenuOpen) return
    function handler(e) {
      if (listMenuRef.current && !listMenuRef.current.contains(e.target)) {
        setListMenuOpen(false); setNewListInput(false); setNewListName('')
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [listMenuOpen])

  // Close repost popup on outside click
  const repostRef = useRef(null)
  useEffect(() => {
    if (!repostOpen) return
    function handler(e) {
      if (repostRef.current && !repostRef.current.contains(e.target)) setRepostOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [repostOpen])

  useEffect(() => {
    if (displayContent || !article._aTag) return
    setFetchingContent(true)
    ;(async () => {
      try {
        const aTag = article._aTag
        const [, pubkey, ...dParts] = aTag.split(':')
        const ndk = getNDK()
        const events = await Promise.race([
          ndk.fetchEvents({ kinds: [30023], authors: [pubkey], '#d': [dParts.join(':')] }),
          new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 7000)),
        ])
        const event = Array.from(events)[0]
        if (event?.content) setDisplayContent(event.content)
        if (event?.tags) setResolvedTags(event.tags)
      } catch { /* leave empty */ } finally {
        setFetchingContent(false)
      }
    })()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Use resolved tags from relay fetch when available (bookmark items have sparse synthetic tags)
  const effectiveTags = resolvedTags || article.tags
  const effectiveArticle = resolvedTags ? { ...article, tags: resolvedTags } : article
  const title      = getTag(effectiveArticle, 'title') || getTag(article, 'title') || 'Untitled'
  const image      = getTag(effectiveArticle, 'image') || getTag(article, 'image')
  const summary    = getTag(effectiveArticle, 'summary')
  const dTag       = getTag(article, 'd')
  const aTag       = article._aTag || `30023:${article.pubkey}:${dTag}`
  const rawName = article._authorName
    || profile?.display_name
    || profile?.name
    || ''
  const authorName = isHexOrNpub(rawName) ? '' : rawName
  const authorPic  = article._authorPic
    || profile?.picture
    || ''
  const date = formatDate(getPublishedAt(effectiveArticle))

  // ── Bookmark ────────────────────────────────────────────────────────────────
  // New saves respect the current view — saving while viewing Private lands
  // the item in the private bucket. Existing bookmarks use whichever bucket
  // the item is actually in (article._privacy) for move/remove targeting.
  const saveBucket   = article._privacy || defaultPrivacy
  const removeBucket = article._privacy || defaultPrivacy

  // Wrap any bookmark-write promise with the publish-before-commit status
  // pattern: spinner while pending, stay-open-with-error on failure, close
  // the dropdown only after a successful publish. `onOk` fires only on true
  // success so the ✓Saved indicator doesn't flash for a failed write.
  async function runBookmarkOp(op, onOk) {
    if (bookmarkStatus === 'saving') return false
    setBookmarkStatus('saving')
    try {
      const ok = await op()
      if (ok === false) {
        setBookmarkStatus('error')
        setTimeout(() => setBookmarkStatus('idle'), 3000)
        return false
      }
      setBookmarkStatus('idle')
      onOk?.()
      return true
    } catch {
      setBookmarkStatus('error')
      setTimeout(() => setBookmarkStatus('idle'), 3000)
      return false
    }
  }

  async function handleAddToList(listId) {
    const tTags = effectiveTags?.filter(t => t[0] === 't').map(t => t[1]) || []
    const ok = await runBookmarkOp(
      () => onAddToList(
        listId,
        { aTag, title, image, author: authorName, authorPic, addedAt: Date.now(), tTags, publishedAt: getPublishedAt(effectiveArticle) },
        { privacy: saveBucket },
      ),
      () => {
        setSavedToList(listId)
        setListMenuOpen(false)
        setNewListInput(false)
        setNewListName('')
      },
    )
    return ok
  }

  async function handleCreateAndAdd() {
    const name = newListName.trim()
    if (!name) return
    const ok = await runBookmarkOp(
      async () => {
        const list = await onCreateList(name)
        if (!list) return false
        const tTags = article.tags?.filter(t => t[0] === 't').map(t => t[1]) || []
        const r = await onAddToList(
          list.id,
          { aTag, title, image, author: authorName, authorPic, addedAt: Date.now(), tTags },
          { privacy: saveBucket },
        )
        if (r === false) return false
        setSavedToList(list.id)
        return true
      },
      () => {
        setListMenuOpen(false)
        setNewListInput(false)
        setNewListName('')
      },
    )
    return ok
  }

  async function handleRemoveFromBookmark() {
    if (!article._listId || !article._aTag) return
    await runBookmarkOp(
      () => onRemoveFromList(article._listId, article._aTag, { privacy: removeBucket }),
      () => onClose(),
    )
  }

  // Inline Move-to handler — same status pattern, closes dropdown on success.
  async function handleInlineMoveTo(toListId) {
    await runBookmarkOp(
      () => onMoveArticle(article._listId, toListId, aTag, { privacy: removeBucket }),
      () => setListMenuOpen(false),
    )
  }

  // Inline Create-new-group-then-save handler used by both the Enter key and
  // the ✓ button in the inline "new group" input.
  async function handleInlineCreateAndSave(mode) {
    const name = newListName.trim()
    if (!name) return
    await runBookmarkOp(
      async () => {
        const list = await onCreateList(name)
        if (!list) return false
        const articleMeta = { aTag, title, image, author: authorName, authorPic, addedAt: Date.now(), tTags: article.tags?.filter(t => t[0] === 't').map(t => t[1]) || [] }
        if (mode === 'move' && article._listId && onMoveArticle) {
          const r = await onMoveArticle(article._listId, list.id, aTag, { privacy: removeBucket })
          if (r === false) return false
        } else {
          const r = await onAddToList(list.id, articleMeta, { privacy: saveBucket })
          if (r === false) return false
          setSavedToList(list.id)
        }
        return true
      },
      () => {
        setListMenuOpen(false)
        setNewListInput(false)
        setNewListName('')
      },
    )
  }

  // ── Social actions ───────────────────────────────────────────────────────────
  const canPublish = !readOnly && !!user?.pubkey

  // Resolve the real event ID for bookmark items (whose .id is an aTag string).
  // For articles fetched from relays/Primal, .id is already a valid hex event ID.
  const hasRealEventId = /^[a-f0-9]{64}$/.test(article.id)

  async function handleLike() {
    if (!canPublish || liking || liked) return
    // Optimistic flip — heart lights up immediately, pulses while in flight,
    // reverts if sign/publish errors OR if publish returns without any
    // relay ack. Matches NoteActionBar so a like reaching zero relays can't
    // leave the UI in a false "liked" state on either module.
    setLiking(true)
    setLiked(true)
    try {
      const ndk = getNDK()
      const ev = new NDKEvent(ndk)
      ev.kind = 7
      ev.content = '+'
      ev.tags = [
        ['p', article.pubkey],
        ['a', aTag],
        ['k', '30023'],
      ]
      if (hasRealEventId) ev.tags.unshift(['e', article.id])
      await signWithTimeout(ev)
      const publishedTo = await ev.publish()
      if (!publishedTo || publishedTo.size === 0) {
        if (import.meta.env.DEV) console.warn('Article like reached no relays')
        setLiked(false)
      }
    } catch (err) {
      if (import.meta.env.DEV) console.warn('Like failed:', err)
      setLiked(false)
    } finally {
      setLiking(false)
    }
  }

  async function handleRepost() {
    if (!canPublish || reposting) return
    // Optimistic flip — "✓ Reposting…" shows immediately, settles to
    // "✓ Reposted" once at least one relay acks; reverts on error or
    // zero-ack so the label doesn't lie about persistence.
    setReposting(true)
    setRepostDone(true)
    setRepostOpen(false)
    try {
      const ndk = getNDK()
      const ev = new NDKEvent(ndk)
      // NIP-18: kind 16 for generic reposts (kind 6 is only for kind 1 notes)
      ev.kind    = 16
      ev.content = ''
      ev.tags    = [
        ['p', article.pubkey],
        ['a', aTag],
        ['k', '30023'],
      ]
      if (hasRealEventId) ev.tags.unshift(['e', article.id])
      await signWithTimeout(ev)
      const publishedTo = await ev.publish()
      if (!publishedTo || publishedTo.size === 0) {
        if (import.meta.env.DEV) console.warn('Article repost reached no relays')
        setRepostDone(false)
      }
    } catch (err) {
      if (import.meta.env.DEV) console.warn('Repost failed:', err)
      setRepostDone(false)
    } finally {
      setReposting(false)
    }
  }

  // Deep-link this article into the Notes Write module. We pass a naddr
  // so the composer can emit an NIP-10 a-tag (root) for Reply, or embed
  // the article as a nostr: URI for Quote. Only reachable when canPublish —
  // the Notes module's Write tab is owner-only, and navigating there as a
  // visitor would bounce back to the Notes feed.
  function openInComposer(field) {
    if (!canPublish || !user?.npub) return
    if (!article?.pubkey || !dTag) return
    try {
      const naddr = nip19.naddrEncode({ kind: 30023, pubkey: article.pubkey, identifier: dTag })
      navigate(`/${user.npub}/notes`, {
        state: { composerPrefill: { [field]: naddr } },
      })
    } catch {}
  }

  async function handleZapClick() {
    if (zapLud16) {
      setZapOpen(true)
      return
    }
    setZapFetching(true)
    try {
      const ndk = getNDK()
      const events = await Promise.race([
        ndk.fetchEvents({ kinds: [0], authors: [article.pubkey] }),
        new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 5000)),
      ])
      const event = Array.from(events)[0]
      if (event) {
        try {
          const parsed = JSON.parse(event.content)
          if (parsed.lud16) {
            setZapLud16(parsed.lud16)
            setZapOpen(true)
            return
          }
        } catch { /* malformed profile JSON */ }
      }
    } catch { /* silently fail */ } finally {
      setZapFetching(false)
    }
  }

  return (
    <>
    {zapOpen && zapLud16 && (
      <ZapModal
        lud16={zapLud16}
        recipientPubkey={article.pubkey}
        recipientName={authorName}
        articleEvent={hasRealEventId ? article : null}
        aTag={aTag}
        user={user}
        onClose={() => setZapOpen(false)}
      />
    )}
    <div className="flex-1 flex flex-col overflow-hidden min-w-0">
      {/* ── Header ── */}
      <div className="flex items-center justify-between gap-2 px-4 py-2 border-b border-neutral-800 flex-shrink-0">
        {/* Mobile back button — collapses the reader and returns to the feed.
            Same onClose path as the desktop ✕ button; shown as a chevron + the
            word "Back" so it reads unambiguously as navigation. */}
        {isMobile && (
          <button
            onClick={onClose}
            aria-label="Back to feed"
            className="flex-shrink-0 flex items-center gap-1 text-xs px-2 py-1 -ml-2 rounded text-neutral-300 hover:text-neutral-100 hover:bg-neutral-800 transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10 12 L6 8 L10 4" />
            </svg>
            <span>Back</span>
          </button>
        )}

        {/* Author + date */}
        <div className="flex items-center gap-2 min-w-0 text-xs text-neutral-500">
          {onAuthorClick && (authorName || authorPic) ? (
            <button
              onClick={() => onAuthorClick({ pubkey: article.pubkey, name: authorName, picture: authorPic })}
              className="flex items-center gap-2 min-w-0 hover:text-purple-400 transition-colors"
            >
              {authorPic && isSafeUrl(authorPic) && (
                <img src={authorPic} alt="" className="w-5 h-5 rounded-full flex-shrink-0 object-cover"
                  onError={e => { e.target.style.display = 'none' }} />
              )}
              <span className="truncate">{authorName}</span>
            </button>
          ) : (
            <>
              {authorPic && isSafeUrl(authorPic) && (
                <img src={authorPic} alt="" className="w-5 h-5 rounded-full flex-shrink-0 object-cover"
                  onError={e => { e.target.style.display = 'none' }} />
              )}
              <span className="truncate">{authorName}</span>
            </>
          )}
          {date && <span className="flex-shrink-0 text-neutral-700">· {date}</span>}
        </div>

        {/* Close — desktop only. On mobile the leading back arrow handles
            dismissal so we don't show two close controls. Bookmark + ⋯ live
            on the social action bar below. */}
        {!isMobile && (
          <button onClick={onClose}
            className="flex-shrink-0 text-neutral-600 hover:text-neutral-300 transition-colors text-base leading-none px-1">
            ✕
          </button>
        )}
      </div>

      {/* ── Social action bar ── */}
      <div className="flex items-center gap-1.5 px-4 py-1.5 border-b border-neutral-800 flex-shrink-0">

        {/* Like */}
        <button
          onClick={handleLike}
          disabled={!canPublish || liking}
          title={canPublish ? 'Like' : 'Sign in with private key to react'}
          className={`flex items-center gap-1 text-xs px-2 py-1 rounded border transition-colors disabled:opacity-40 ${
            liked
              ? 'border-red-800 text-red-400'
              : 'border-neutral-800 text-neutral-500 hover:border-neutral-600 hover:text-neutral-300'
          } ${liking ? 'animate-pulse' : ''}`}
        >
          {liked ? '❤️' : '🤍'} {liked ? 'Liked' : 'Like'}
        </button>

        {/* Zap — opens invoice modal; fetches lud16 from kind 0 if not in Primal profile */}
        <button
          onClick={handleZapClick}
          disabled={zapFetching}
          title={`Zap ${authorName}`}
          className="flex items-center gap-1 text-xs px-2 py-1 rounded border border-neutral-800 text-neutral-500 hover:border-amber-800 hover:text-amber-400 disabled:opacity-40 transition-colors"
        >
          ⚡ {zapFetching ? 'Finding…' : 'Zap'}
        </button>

        {/* Comment — navigates to the Notes Write module with this article
            prefilled into the Reply field. Publishes as a kind 1 threaded by
            a-tag against the article's naddr coordinate. */}
        <button
          onClick={() => openInComposer('replyTo')}
          disabled={!canPublish}
          title={canPublish ? 'Comment on this article' : 'Sign in to comment'}
          className="flex items-center gap-1 text-xs px-2 py-1 rounded border border-neutral-800 text-neutral-500 hover:border-neutral-600 hover:text-neutral-300 disabled:opacity-40 transition-colors"
        >
          💬 Comment
        </button>

        {/* Repost */}
        <div className="relative" ref={repostRef}>
          {repostDone ? (
            <span className={`text-xs text-neutral-500 px-2 ${reposting ? 'animate-pulse' : ''}`}>
              ✓ {reposting ? 'Reposting…' : 'Reposted'}
            </span>
          ) : (
            <button
              onClick={() => setRepostOpen(o => !o)}
              disabled={!canPublish}
              title={canPublish ? 'Repost' : 'Sign in with private key to repost'}
              className="flex items-center gap-1 text-xs px-2 py-1 rounded border border-neutral-800 text-neutral-500 hover:border-neutral-600 hover:text-green-400 disabled:opacity-40 transition-colors"
            >
              🔁 Repost
            </button>
          )}
          {repostOpen && (
            <div className="absolute left-0 top-full mt-1 bg-neutral-900 border border-neutral-700 rounded shadow-xl z-20 min-w-[170px] py-1">
              <button
                onClick={handleRepost}
                disabled={reposting}
                className="w-full text-left px-3 py-2 text-xs text-neutral-300 hover:bg-neutral-800 disabled:opacity-40 transition-colors"
              >
                🔁 {reposting ? 'Reposting…' : 'Repost'}
              </button>
              <button
                onClick={() => { setRepostOpen(false); openInComposer('quote') }}
                disabled={!canPublish}
                className="w-full text-left px-3 py-2 text-xs text-neutral-300 hover:bg-neutral-800 disabled:opacity-40 transition-colors"
              >
                💬 Quote
              </button>
            </div>
          )}
        </div>

        {/* Right-aligned: bookmark + three-dots menu */}
        <div className="ml-auto flex items-center gap-1">
          {/* Bookmark button + dropdown */}
          {!readOnly && (
            <div className="relative" ref={listMenuRef}>
              <button
                onClick={() => {
                  if (bookmarkStatus === 'saving') return
                  setListMenuOpen(o => !o); setNewListInput(false)
                }}
                disabled={bookmarkStatus === 'saving'}
                className={`text-xs px-2 py-1 rounded border transition-colors inline-flex items-center gap-1 disabled:opacity-60 ${
                  bookmarkStatus === 'error'
                    ? 'border-red-900/60 text-red-400'
                    : savedToList
                    ? 'border-amber-800 text-amber-400'
                    : 'border-neutral-700 text-neutral-400 hover:text-neutral-200 hover:border-neutral-500'
                }`}
              >
                {bookmarkStatus === 'saving' ? (
                  <>
                    <span className="w-3 h-3 border border-current border-t-transparent rounded-full animate-spin inline-block" />
                    <span>Saving…</span>
                  </>
                ) : bookmarkStatus === 'error' ? '⚠️ Failed'
                  : savedToList ? '🔖 Saved'
                  : '🔖 Bookmark'}
              </button>
              {listMenuOpen && (() => {
                const isBookmarked = !!article._listId
                const otherLists = isBookmarked ? lists.filter(l => l.id !== article._listId) : lists
                return (
                  <div className="absolute right-0 top-full mt-1 bg-neutral-800 border border-neutral-700 rounded shadow-xl z-20 min-w-[200px] max-h-[70vh] overflow-y-auto">
                    {/* Move to — only for bookmarked items */}
                    {isBookmarked && onMoveArticle && otherLists.length > 0 && (
                      <>
                        <p className="px-3 py-1.5 text-[10px] text-neutral-600 uppercase tracking-wider">Move to</p>
                        {otherLists.map(list => (
                          <button key={`mv-${list.id}`}
                            onClick={() => handleInlineMoveTo(list.id)}
                            disabled={bookmarkStatus === 'saving'}
                            className="w-full text-left px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-700 transition-colors truncate disabled:opacity-50">
                            {list.title}
                          </button>
                        ))}
                        <button
                          onClick={() => { setNewListInput('move'); setNewListName('') }}
                          className="w-full text-left px-3 py-1.5 text-xs text-neutral-500 hover:text-neutral-300 hover:bg-neutral-700 transition-colors">
                          + New group
                        </button>
                        <div className="border-t border-neutral-700" />
                      </>
                    )}

                    {/* Copy to — for bookmarked items */}
                    {isBookmarked && otherLists.length > 0 && (
                      <>
                        <p className="px-3 py-1.5 text-[10px] text-neutral-600 uppercase tracking-wider">Copy to</p>
                        {otherLists.map(list => (
                          <button key={`cp-${list.id}`}
                            onClick={() => handleAddToList(list.id)}
                            disabled={bookmarkStatus === 'saving'}
                            className="w-full text-left px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-700 transition-colors truncate disabled:opacity-50">
                            {list.title}
                          </button>
                        ))}
                        <button
                          onClick={() => { setNewListInput('copy'); setNewListName('') }}
                          className="w-full text-left px-3 py-1.5 text-xs text-neutral-500 hover:text-neutral-300 hover:bg-neutral-700 transition-colors">
                          + New group
                        </button>
                        <div className="border-t border-neutral-700" />
                      </>
                    )}

                    {/* Add to — for non-bookmarked items (search results) */}
                    {!isBookmarked && (
                      <>
                        <p className="px-3 py-1.5 text-[10px] text-neutral-600 uppercase tracking-wider">Add to</p>
                        {lists.length === 0 ? (
                          <p className="px-3 py-2 text-xs text-neutral-500">No lists yet.</p>
                        ) : (
                          lists.map(list => (
                            <button key={list.id} onClick={() => handleAddToList(list.id)} disabled={bookmarkStatus === 'saving'}
                              className="w-full text-left px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-700 transition-colors truncate disabled:opacity-50">
                              {list.title}
                            </button>
                          ))
                        )}
                        <button
                          onClick={() => { setNewListInput('add'); setNewListName('') }}
                          className="w-full text-left px-3 py-1.5 text-xs text-neutral-500 hover:text-neutral-300 hover:bg-neutral-700 transition-colors">
                          + New group
                        </button>
                        <div className="border-t border-neutral-700" />
                      </>
                    )}

                    {/* New group input — shared across move/copy/add modes */}
                    {newListInput && (
                      <div className="px-2 py-2 border-t border-neutral-700 flex gap-1">
                        <input autoFocus type="text" value={newListName} onChange={e => setNewListName(e.target.value)}
                          onKeyDown={e => {
                            if (e.key === 'Enter' && newListName.trim()) {
                              handleInlineCreateAndSave(newListInput)
                            }
                            if (e.key === 'Escape') { setNewListInput(false) }
                          }}
                          placeholder="Group name…" maxLength={60}
                          disabled={bookmarkStatus === 'saving'}
                          className="flex-1 bg-neutral-700 border border-neutral-600 rounded px-2 py-1 text-xs text-neutral-100 focus:outline-none disabled:opacity-60" />
                        <button
                          onClick={() => handleInlineCreateAndSave(newListInput)}
                          disabled={!newListName.trim() || bookmarkStatus === 'saving'}
                          className="text-xs px-2 py-1 rounded bg-purple-700 hover:bg-purple-600 disabled:opacity-40 text-white transition-colors inline-flex items-center gap-1">
                          {bookmarkStatus === 'saving' ? (
                            <span className="w-3 h-3 border border-current border-t-transparent rounded-full animate-spin inline-block" />
                          ) : '✓'}
                        </button>
                      </div>
                    )}

                    {/* Remove from current list */}
                    {isBookmarked && onRemoveFromList && (
                      <button
                        onClick={handleRemoveFromBookmark}
                        disabled={bookmarkStatus === 'saving'}
                        className="w-full text-left px-3 py-2 text-xs text-red-400 hover:bg-red-950/40 transition-colors disabled:opacity-50 inline-flex items-center gap-1.5">
                        {bookmarkStatus === 'saving' ? (
                          <>
                            <span className="w-3 h-3 border border-current border-t-transparent rounded-full animate-spin inline-block" />
                            <span>Removing…</span>
                          </>
                        ) : `Remove from "${article._listTitle || 'list'}"`}
                      </button>
                    )}
                  </div>
                )
              })()}
            </div>
          )}

          {/* ⋯ Three-dots menu */}
          <div className="relative" ref={menuRef}>
            <button
              onClick={() => setMenuOpen(o => !o)}
              className="text-xs px-2 py-1 rounded border border-neutral-700 text-neutral-400 hover:text-neutral-200 hover:border-neutral-500 transition-colors"
              aria-label="More options"
            >
              ···
            </button>
            <ArticleActionsMenu
              open={menuOpen}
              onClose={() => setMenuOpen(false)}
              article={effectiveArticle}
              title={title}
              summary={summary}
              image={image}
              tTags={effectiveTags?.filter(t => t[0] === 't').map(t => t[1]) || []}
              content={displayContent || article.content || ''}
              onMovePrivacy={onMovePrivacy}
              defaultPrivacy={effectiveArticle?._privacy || defaultPrivacy}
              authorName={authorName}
              authorPic={authorPic}
              onLoadInEditor={onLoadInEditor}
            />
          </div>
        </div>

      </div>

      {/* ── Content — matches the Write module's preview rendering ── */}
      <div className="flex-1 overflow-y-auto bg-neutral-950 px-4 sm:px-8 py-6" data-color-mode="dark">
        {image && isSafeUrl(image) && !coverBroken && (
          <div className="w-full aspect-video mb-6 rounded-lg overflow-hidden border border-neutral-800">
            <img
              src={image}
              alt="Cover"
              className="w-full h-full object-cover"
              onError={() => setCoverBroken(true)}
            />
          </div>
        )}

        <h1 className="text-2xl font-bold text-neutral-100 leading-tight mb-2 font-sans">{title}</h1>

        {summary && (
          <p className="text-base text-neutral-400 leading-relaxed mb-3 font-sans">{summary}</p>
        )}

        <hr className="border-neutral-800 mb-6" />

        {fetchingContent ? (
          <div className="flex items-center gap-2 py-8 text-neutral-600 text-sm">
            <span className="w-4 h-4 border-2 border-neutral-600 border-t-transparent rounded-full animate-spin inline-block" />
            Loading article…
          </div>
        ) : (
          <div className="prose prose-invert prose-sm max-w-none font-sans prose-img:block prose-img:mx-auto prose-img:max-h-[70vh]">
            <MDEditor.Markdown
              source={displayContent}
              rehypePlugins={[rehypeSanitize]}
              style={{ backgroundColor: 'transparent', color: 'inherit' }}
            />
          </div>
        )}
      </div>
    </div>
    </>
  )
}

