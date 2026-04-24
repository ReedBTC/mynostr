/**
 * NoteCard — a kind 1 note rendered as a standalone preview card for the
 * My Notes / Bookmarks / Search feeds.
 *
 * Layout:
 *   [pfp]  name · @handle        · time · ⋯
 *          ┌────────────────────────────┐
 *          │ preview body               │  ← clamped only on mobile
 *          │   (image, text, mentions)  │
 *          │                            │
 *          └── gradient fade ───────────┘
 *          [Show more] (mobile, only if body overflows)
 *          Like · Zap · Comment · Repost · Bookmark
 *
 * Mobile-only clamp: we measure body scrollHeight against MOBILE_COLLAPSED_PX
 * to decide whether "Show more" is worth showing. Desktop has the vertical
 * space to render the full body. Measurement re-runs briefly after mount to
 * catch late image-load reflows.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { nip19 } from 'nostr-tools'
import NotePreview from '../NotePreview.jsx'
import NoteActionsMenu from './NoteActionsMenu.jsx'
import NoteActionBar from './NoteActionBar.jsx'
import { isSafeUrl } from '../../../../lib/utils.js'
import { useIsMobile } from '../../../../hooks/useIsMobile.js'
import { useNotesNavigationContext } from '../../notesNavigationContext.jsx'

// Only mobile clamps kind-1 notes behind a "Show more" gate; desktop has
// the vertical space to just render the whole thing.
const MOBILE_COLLAPSED_PX = 288

function timeAgo(seconds) {
  if (!seconds) return ''
  const diff = Math.max(0, Math.floor(Date.now() / 1000 - seconds))
  if (diff < 60) return `${diff}s`
  if (diff < 3600) return `${Math.floor(diff / 60)}m`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`
  if (diff < 2592000) return `${Math.floor(diff / 86400)}d`
  if (diff < 31536000) return `${Math.floor(diff / 2592000)}mo`
  return `${Math.floor(diff / 31536000)}y`
}

function extractZapSplits(tags) {
  if (!tags) return []
  const out = []
  for (const t of tags) {
    if (t[0] !== 'zap' || !t[1]) continue
    if (!/^[0-9a-fA-F]{64}$/.test(t[1])) continue
    out.push({ pubkey: t[1].toLowerCase(), relay: t[2] || '', weight: Number(t[3]) || 1 })
  }
  const total = out.reduce((s, z) => s + z.weight, 0)
  return out.map(z => ({ pubkey: z.pubkey, relay: z.relay, pct: total > 0 ? Math.round(z.weight / total * 100) : 0 }))
}

export default function NoteCard({
  note,
  profile,
  inBookmarksFeed = false,
  onNoteClick,
  focused = false,
  compact = false,
  selectable = false,
  selected = false,
  onToggleSelect,
  isPrivate = false,
}) {
  const isMobile = useIsMobile()
  const { openAuthorInSearch } = useNotesNavigationContext()
  const bodyRef = useRef(null)
  const menuRef = useRef(null)
  const [expanded, setExpanded] = useState(false)
  const [canExpand, setCanExpand] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    if (!menuOpen) return
    // Capture phase + pointerdown so the close fires before any inner
    // stopPropagation, and covers mouse/touch/pen uniformly.
    //
    // The menu itself is portaled to document.body so `menuRef.contains`
    // can't see clicks inside it — check for the data attribute too.
    function onDown(e) {
      if (!menuRef.current) return
      if (menuRef.current.contains(e.target)) return
      if (e.target.closest?.('[data-note-actions-menu="true"]')) return
      setMenuOpen(false)
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [menuOpen])

  // Measure whether the rendered body exceeds the clamp. We poll briefly on
  // mount to catch late image load reflows — one-shot would miss any image
  // that hasn't loaded on first paint. Desktop skips entirely — no clamp.
  useLayoutEffect(() => {
    if (!isMobile || expanded) {
      if (canExpand) setCanExpand(false)
      return
    }
    const node = bodyRef.current
    if (!node) return
    let cancelled = false
    const measure = () => {
      if (cancelled) return
      setCanExpand(node.scrollHeight > MOBILE_COLLAPSED_PX + 8)
    }
    measure()
    const t1 = setTimeout(measure, 200)
    const t2 = setTimeout(measure, 800)
    const t3 = setTimeout(measure, 2000)
    return () => { cancelled = true; clearTimeout(t1); clearTimeout(t2); clearTimeout(t3) }
  }, [note?.id, note?.content, expanded, isMobile])

  const displayName = profile?.display_name || profile?.name || (note?.pubkey ? nip19.npubEncode(note.pubkey).slice(0, 12) + '…' : 'Anonymous')
  const handle = profile?.nip05 ? profile.nip05.replace(/^_@/, '') : ''
  const pic = profile?.picture || profile?.image
  const zapSplits = extractZapSplits(note?.tags)

  // Click-to-open-thread: we want the body region to open the thread but
  // NOT the nested interactive elements (links, embedded videos/images,
  // author pfp button, action bar buttons, three-dot menu). Check target
  // closest match before calling.
  function handleBodyClick(e) {
    if (!onNoteClick) return
    const tgt = e.target
    if (tgt.closest('a, button, video, iframe')) return
    onNoteClick(note)
  }

  const clickable = !!onNoteClick
  // min-w-0 is load-bearing on the selectable path: without it the flex-1
  // article respects its content's intrinsic width, so a wide image or
  // embedded note can push the card beyond the feed's max-w-xl frame.
  // overflow-hidden keeps the rounded corners clean when inner content
  // (e.g. an unwrapped naddr link) would otherwise poke through.
  const articleClass = [
    'bg-neutral-900 border rounded-lg p-3 transition-colors overflow-hidden',
    focused
      ? 'border-purple-700'
      : (selectable && selected ? 'border-purple-500' : 'border-neutral-800'),
    clickable ? 'hover:border-neutral-700 cursor-pointer' : '',
    selectable ? 'flex-1 min-w-0' : '',
  ].filter(Boolean).join(' ')

  const articleEl = (
    <article
      className={articleClass}
      onClick={clickable ? handleBodyClick : undefined}
    >
      {/* Header */}
      <header className="flex items-center gap-2 mb-2">
        {openAuthorInSearch && note?.pubkey ? (
          <button
            type="button"
            onClick={() => openAuthorInSearch({ pubkey: note.pubkey, name: displayName, picture: pic })}
            className="flex items-center gap-2 min-w-0 flex-1 hover:opacity-80 transition-opacity text-left"
            title={`View notes from ${displayName}`}
          >
            {pic && isSafeUrl(pic) ? (
              <img
                src={pic}
                alt=""
                className="w-8 h-8 rounded-full object-cover shrink-0"
                referrerPolicy="no-referrer"
                onError={e => { e.target.style.display = 'none' }}
              />
            ) : (
              <div className="w-8 h-8 rounded-full bg-neutral-700 shrink-0" />
            )}
            <div className="min-w-0 flex-1">
              <p className="text-xs text-neutral-200 truncate">{displayName}</p>
              {handle && <p className="text-[10px] text-neutral-500 truncate">{handle}</p>}
            </div>
          </button>
        ) : (
          <>
            {pic && isSafeUrl(pic) ? (
              <img
                src={pic}
                alt=""
                className="w-8 h-8 rounded-full object-cover shrink-0"
                referrerPolicy="no-referrer"
                onError={e => { e.target.style.display = 'none' }}
              />
            ) : (
              <div className="w-8 h-8 rounded-full bg-neutral-700 shrink-0" />
            )}
            <div className="min-w-0 flex-1">
              <p className="text-xs text-neutral-200 truncate">{displayName}</p>
              {handle && <p className="text-[10px] text-neutral-500 truncate">{handle}</p>}
            </div>
          </>
        )}
        {isPrivate && (
          <span
            className="shrink-0 inline-flex items-center gap-0.5 text-[10px] text-purple-300/80"
            title="Private bookmark — visible only to you"
          >
            <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <rect x="3.5" y="7" width="9" height="6.5" rx="1.2" />
              <path d="M5.5 7V5a2.5 2.5 0 015 0v2" strokeLinecap="round" />
            </svg>
          </span>
        )}
        <span className="text-[10px] text-neutral-500 shrink-0" title={new Date((note?.created_at || 0) * 1000).toLocaleString()}>
          {timeAgo(note?.created_at)}
        </span>
        <div ref={menuRef} className="relative shrink-0">
          <button
            type="button"
            onClick={() => setMenuOpen(v => !v)}
            aria-label="Note actions"
            className="p-1 -mr-1 rounded text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800 transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <circle cx="3" cy="8" r="1.4" />
              <circle cx="8" cy="8" r="1.4" />
              <circle cx="13" cy="8" r="1.4" />
            </svg>
          </button>
          <NoteActionsMenu open={menuOpen} onClose={() => setMenuOpen(false)} note={note} triggerRef={menuRef} />
        </div>
      </header>

      {/* Body — clamped until expanded (mobile only) */}
      <div className="relative">
        <div
          ref={bodyRef}
          className="relative overflow-hidden"
          style={isMobile && !expanded ? { maxHeight: MOBILE_COLLAPSED_PX } : undefined}
        >
          <NotePreview
            content={note?.content || ''}
            zapSplits={zapSplits}
            authorPubkey={note?.pubkey}
            compactSplits
          />
        </div>
        {/* Fade overlay hints that more content is hidden */}
        {isMobile && !expanded && canExpand && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-neutral-900 to-transparent" />
        )}
      </div>

      {/* Show more / less — mobile only */}
      {isMobile && canExpand && (
        <button
          onClick={() => setExpanded(v => !v)}
          className="mt-2 text-[11px] font-medium text-purple-400 hover:text-purple-300"
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}

      <NoteActionBar note={note} profile={profile} />
    </article>
  )

  if (selectable) {
    return (
      <div className="flex items-start gap-3 min-w-0">
        <button
          type="button"
          onClick={() => onToggleSelect?.(note.id)}
          aria-checked={selected}
          role="checkbox"
          aria-label={selected ? 'Deselect note' : 'Select note'}
          className={`mt-4 shrink-0 w-5 h-5 rounded border-2 flex items-center justify-center transition-colors ${
            selected
              ? 'bg-purple-600 border-purple-600 hover:bg-purple-500'
              : 'bg-neutral-900 border-neutral-600 hover:border-neutral-400'
          }`}
        >
          {selected && (
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="white" strokeWidth="2" aria-hidden="true">
              <path d="M2 6l3 3 5-6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </button>
        {articleEl}
      </div>
    )
  }

  return articleEl
}
