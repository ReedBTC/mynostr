import { useState, useEffect, useRef } from 'react'
import MDEditor from '@uiw/react-md-editor'
import rehypeSanitize from 'rehype-sanitize'
import { NDKEvent } from '@nostr-dev-kit/ndk'
import { nip19 } from 'nostr-tools'
import { exportEpub } from '../../../../lib/epub.js'
import { titleToSlug, isSafeUrl } from '../../../../lib/utils.js'
import { getNDK } from '../../../../lib/ndk.js'
import ZapModal from './ZapModal.jsx'

function getNaddr(article) {
  try {
    const identifier = article.tags?.find(t => t[0] === 'd')?.[1] ?? ''
    return nip19.naddrEncode({ kind: 30023, pubkey: article.pubkey, identifier })
  } catch {
    return null
  }
}

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
  onRemoveFromList,
  onLoadInEditor,
  onClose,
  onAuthorClick,
  readOnly,
  user,
}) {
  const [listMenuOpen, setListMenuOpen] = useState(false)
  const [adding,       setAdding]       = useState(false)
  const [savedToList,  setSavedToList]  = useState(null)
  const [epubBusy,     setEpubBusy]     = useState(false)
  const [newListInput, setNewListInput] = useState(false)
  const [newListName,  setNewListName]  = useState('')
  const [menuOpen,     setMenuOpen]     = useState(false)
  const [copied,       setCopied]       = useState(false)
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
  const [fetchingContent,  setFetchingContent]  = useState(false)

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
      } catch { /* leave empty */ } finally {
        setFetchingContent(false)
      }
    })()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const title      = getTag(article, 'title') || 'Untitled'
  const image      = getTag(article, 'image')
  const summary    = getTag(article, 'summary')
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
  const date = formatDate(article.created_at)

  // ── Bookmark ────────────────────────────────────────────────────────────────
  async function handleAddToList(listId) {
    setAdding(true)
    try {
      const tTags = article.tags?.filter(t => t[0] === 't').map(t => t[1]) || []
      await onAddToList(listId, { aTag, title, image, author: authorName, authorPic, addedAt: Date.now(), tTags })
      setSavedToList(listId)
    } finally {
      setAdding(false)
      setListMenuOpen(false)
      setNewListInput(false)
      setNewListName('')
    }
  }

  async function handleCreateAndAdd() {
    const name = newListName.trim()
    if (!name) return
    setAdding(true)
    try {
      const list = await onCreateList(name)
      const tTags = article.tags?.filter(t => t[0] === 't').map(t => t[1]) || []
      await onAddToList(list.id, { aTag, title, image, author: authorName, authorPic, addedAt: Date.now(), tTags })
      setSavedToList(list.id)
    } finally {
      setAdding(false)
      setListMenuOpen(false)
      setNewListInput(false)
      setNewListName('')
    }
  }

  // ── Three-dots menu actions ────────────────────────────────────────────────────

  function handleCopyNaddr() {
    const naddr = getNaddr(article)
    if (!naddr) return
    navigator.clipboard.writeText(naddr).then(() => {
      setCopied('naddr')
      setTimeout(() => setCopied(false), 2000)
    })
    setMenuOpen(false)
  }

  async function handleRemoveFromBookmark() {
    if (!article._listId || !article._aTag) return
    await onRemoveFromList(article._listId, article._aTag)
    onClose()
  }

  function handleCopyUrl() {
    const naddr = getNaddr(article)
    if (!naddr) return
    navigator.clipboard.writeText(`https://njump.me/${naddr}`).then(() => {
      setCopied('url')
      setTimeout(() => setCopied(false), 2000)
    })
    setMenuOpen(false)
  }

  function handleViewPrimal() {
    const naddr = getNaddr(article)
    if (!naddr) return
    window.open(`https://primal.net/a/${naddr}`, '_blank', 'noopener')
    setMenuOpen(false)
  }

  // ── Export .md ──────────────────────────────────────────────────────────────
  function handleExportMd() {
    const slug   = titleToSlug(title) || 'article'
    const header = [
      `# ${title}`,
      authorName ? `\n*by ${authorName}*` : '',
      date       ? `*${date}*`            : '',
      '',
    ].filter(Boolean).join('\n')
    const blob = new Blob([header + '\n' + displayContent], { type: 'text/markdown;charset=utf-8' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href = url; a.download = slug + '.md'; a.click()
    URL.revokeObjectURL(url)
  }

  // ── Social actions ───────────────────────────────────────────────────────────
  const canPublish = !readOnly && !!user?.pubkey

  // Resolve the real event ID for bookmark items (whose .id is an aTag string).
  // For articles fetched from relays/Primal, .id is already a valid hex event ID.
  const hasRealEventId = /^[a-f0-9]{64}$/.test(article.id)

  async function handleLike() {
    if (!canPublish || liking || liked) return
    setLiking(true)
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
      // Only include e tag if we have a real hex event ID
      if (hasRealEventId) ev.tags.unshift(['e', article.id])
      await ev.sign()
      await ev.publish()
      setLiked(true)
    } catch (err) {
      if (import.meta.env.DEV) console.warn('Like failed:', err)
    } finally {
      setLiking(false)
    }
  }

  async function handleRepost() {
    if (!canPublish || reposting) return
    setReposting(true)
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
      await ev.sign()
      await ev.publish()
      setRepostDone(true)
      setRepostOpen(false)
    } catch (err) {
      if (import.meta.env.DEV) console.warn('Repost failed:', err)
    } finally {
      setReposting(false)
    }
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

  // ── Export .epub ────────────────────────────────────────────────────────────
  async function handleExportEpub() {
    setEpubBusy(true)
    try {
      await exportEpub(
        displayContent,
        {
          title, summary, image,
          publishedAtDate: article.created_at
            ? new Date(article.created_at * 1000).toISOString().split('T')[0]
            : '',
          tags: article.tags?.filter(t => t[0] === 't').map(t => t[1]) || [],
        },
        null, authorName, ''
      )
    } finally { setEpubBusy(false) }
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

        <div className="flex items-center gap-1 flex-shrink-0">
          {/* Bookmark button + dropdown */}
          {!readOnly && (
            <div className="relative" ref={listMenuRef}>
              <button
                onClick={() => { setListMenuOpen(o => !o); setNewListInput(false) }}
                className={`text-xs px-2 py-1 rounded border transition-colors ${
                  savedToList
                    ? 'border-amber-800 text-amber-400'
                    : 'border-neutral-700 text-neutral-400 hover:text-neutral-200 hover:border-neutral-500'
                }`}
              >
                {savedToList ? '🔖 Saved' : '🔖 Bookmark'}
              </button>
              {listMenuOpen && (() => {
                const isBookmarked = !!article._listId
                const otherLists = isBookmarked ? lists.filter(l => l.id !== article._listId) : lists
                const articleMeta = { aTag, title, image, author: authorName, authorPic, addedAt: Date.now(), tTags: article.tags?.filter(t => t[0] === 't').map(t => t[1]) || [] }
                return (
                  <div className="absolute right-0 top-full mt-1 bg-neutral-800 border border-neutral-700 rounded shadow-xl z-20 min-w-[200px] max-h-[70vh] overflow-y-auto">
                    {/* Move to — only for bookmarked items */}
                    {isBookmarked && onMoveArticle && otherLists.length > 0 && (
                      <>
                        <p className="px-3 py-1.5 text-[10px] text-neutral-600 uppercase tracking-wider">Move to</p>
                        {otherLists.map(list => (
                          <button key={`mv-${list.id}`}
                            onClick={() => { onMoveArticle(article._listId, list.id, aTag); setListMenuOpen(false) }}
                            className="w-full text-left px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-700 transition-colors truncate">
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
                            onClick={() => { handleAddToList(list.id); }}
                            className="w-full text-left px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-700 transition-colors truncate">
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
                            <button key={list.id} onClick={() => handleAddToList(list.id)} disabled={adding}
                              className="w-full text-left px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-700 transition-colors truncate">
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
                              (async () => {
                                const list = await onCreateList(newListName.trim())
                                if (newListInput === 'move' && article._listId && onMoveArticle) {
                                  onMoveArticle(article._listId, list.id, aTag)
                                } else {
                                  await onAddToList(list.id, articleMeta)
                                  setSavedToList(list.id)
                                }
                                setListMenuOpen(false); setNewListInput(false); setNewListName('')
                              })()
                            }
                            if (e.key === 'Escape') { setNewListInput(false) }
                          }}
                          placeholder="Group name…" maxLength={60}
                          className="flex-1 bg-neutral-700 border border-neutral-600 rounded px-2 py-1 text-xs text-neutral-100 focus:outline-none" />
                        <button onClick={async () => {
                          const name = newListName.trim(); if (!name) return
                          const list = await onCreateList(name)
                          if (newListInput === 'move' && article._listId && onMoveArticle) {
                            onMoveArticle(article._listId, list.id, aTag)
                          } else {
                            await onAddToList(list.id, articleMeta)
                            setSavedToList(list.id)
                          }
                          setListMenuOpen(false); setNewListInput(false); setNewListName('')
                        }} disabled={!newListName.trim() || adding}
                          className="text-xs px-2 py-1 rounded bg-purple-700 hover:bg-purple-600 disabled:opacity-40 text-white transition-colors">
                          ✓
                        </button>
                      </div>
                    )}

                    {/* Remove from current list */}
                    {isBookmarked && onRemoveFromList && (
                      <button onClick={() => { handleRemoveFromBookmark(); setListMenuOpen(false) }}
                        className="w-full text-left px-3 py-2 text-xs text-red-400 hover:bg-red-950/40 transition-colors">
                        Remove from "{article._listTitle || 'list'}"
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
            {menuOpen && (
              <div className="absolute right-0 top-full mt-1 bg-neutral-900 border border-neutral-700 rounded shadow-xl z-30 min-w-[190px] py-1">
                <MenuItem onClick={handleCopyNaddr}>
                  {copied === 'naddr' ? '✓ Copied!' : 'Copy naddr'}
                </MenuItem>
                <MenuItem onClick={handleCopyUrl}>
                  {copied === 'url' ? '✓ Copied!' : 'Copy URL'}
                </MenuItem>
                <MenuItem onClick={handleViewPrimal}>
                  View on Primal ↗
                </MenuItem>
                {onLoadInEditor && (
                  <>
                    <MenuDivider />
                    <MenuItem onClick={() => {
                      const tTags = article.tags?.filter(t => t[0] === 't').map(t => t[1]) || []
                      const publishedAtUnix = getTag(article, 'published_at')
                      const publishedAtDate = publishedAtUnix
                        ? new Date(parseInt(publishedAtUnix) * 1000).toISOString().split('T')[0]
                        : ''
                      const naddr = getNaddr(article) || ''
                      onLoadInEditor({
                        content: displayContent || article.content,
                        metadata: {
                          title,
                          summary: summary || '',
                          publishedAtDate,
                          image: image || '',
                          tagsRaw: tTags.join(', '),
                          tags: tTags,
                        },
                        naddr,
                      })
                      setMenuOpen(false)
                    }}>
                      Load in editor
                    </MenuItem>
                  </>
                )}
                <MenuDivider />
                <MenuItem onClick={() => { handleExportMd(); setMenuOpen(false) }}>
                  Export .md
                </MenuItem>
                <MenuItem onClick={() => { handleExportEpub(); setMenuOpen(false) }} disabled={epubBusy}>
                  {epubBusy ? 'Exporting…' : 'Export .epub'}
                </MenuItem>
              </div>
            )}
          </div>

          {/* Close */}
          <button onClick={onClose}
            className="text-neutral-600 hover:text-neutral-300 transition-colors text-base leading-none px-1 ml-1">
            ✕
          </button>
        </div>
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
          }`}
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

        {/* Comments — coming soon tooltip */}
        <div className="relative group">
          <button
            disabled
            className="flex items-center gap-1 text-xs px-2 py-1 rounded border border-neutral-800 text-neutral-700 cursor-not-allowed opacity-40"
          >
            💬 Comments
          </button>
          <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 px-2 py-1 text-xs bg-neutral-800 border border-neutral-700 rounded whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-10">
            Coming soon
          </div>
        </div>

        {/* Repost */}
        <div className="relative" ref={repostRef}>
          {repostDone ? (
            <span className="text-xs text-neutral-500 px-2">✓ Reposted</span>
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
              <div className="relative group/quote">
                <button
                  disabled
                  className="w-full text-left px-3 py-2 text-xs text-neutral-600 cursor-not-allowed"
                >
                  💬 Quote
                </button>
                <div className="absolute left-full top-0 ml-1 px-2 py-1 text-xs bg-neutral-800 border border-neutral-700 rounded whitespace-nowrap opacity-0 group-hover/quote:opacity-100 transition-opacity pointer-events-none z-10">
                  Coming soon (Notes module)
                </div>
              </div>
            </div>
          )}
        </div>

      </div>

      {/* ── Content ── */}
      <div className="flex-1 overflow-y-auto" data-color-mode="dark">
        {image && isSafeUrl(image) && (
          <div className="flex justify-center bg-neutral-900 border-b border-neutral-800" style={{ maxHeight: '300px' }}>
            <img src={image} alt="" style={{ maxHeight: '300px', maxWidth: '100%' }}
              className="object-contain"
              onError={e => { e.target.parentElement.style.display = 'none' }} />
          </div>
        )}
        <div className="px-6 py-4">
          <h1 className="text-lg font-bold text-neutral-100 leading-snug mb-1">{title}</h1>
          {summary && <p className="text-sm text-neutral-400 italic mb-4">{summary}</p>}
          {fetchingContent ? (
            <div className="flex items-center gap-2 py-8 text-neutral-600 text-sm">
              <span className="w-4 h-4 border-2 border-neutral-600 border-t-transparent rounded-full animate-spin inline-block" />
              Loading article…
            </div>
          ) : (
            <div className="[&_img]:max-h-64 [&_img]:w-auto [&_img]:object-contain">
              <MDEditor.Markdown
                source={displayContent}
                rehypePlugins={[rehypeSanitize]}
                style={{ background: 'transparent', color: '#d4d4d8', fontSize: '0.875rem', lineHeight: '1.75' }}
              />
            </div>
          )}
        </div>
      </div>
    </div>
    </>
  )
}

function MenuItem({ onClick, disabled, children }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="w-full text-left px-3 py-2 text-xs text-neutral-300 hover:bg-neutral-800 disabled:opacity-40 transition-colors"
    >
      {children}
    </button>
  )
}

function MenuDivider() {
  return <div className="my-1 border-t border-neutral-800" />
}
