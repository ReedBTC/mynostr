/**
 * EventDetail — single-event page rendered when the URL subtab is an
 * naddr1… string. Layout (top → bottom):
 *
 *   Hero image (when set)
 *   Title  ·  hashtags
 *   Meta block: when, where, host (link to host's profile)
 *   RSVP buttons + current count summary (Going / Maybe)
 *   Description (markdown)
 *   Footer: share + edit/delete (owner only)
 *
 * Data flow:
 *   1. decodeNaddr → fetch the addressable event by (kind, pubkey, d)
 *   2. parallel-fetch: my own RSVP for this event, all RSVPs for counts
 *   3. RSVP submit → optimistic update + best-effort refetch
 */
import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import MDEditor from '@uiw/react-md-editor'
import rehypeSanitize from 'rehype-sanitize'
import { nip19 } from 'nostr-tools'
import { getNDK, connectAndWait } from '../../../lib/ndk.js'
import { isSafeUrl, safeNpubEncode } from '../../../lib/utils.js'
import {
  decodeNaddr,
  parseCalendarEvent,
  parseRsvp,
  formatEventTime,
  dedupRsvpsLatest,
  coordOf,
  KIND_RSVP,
  KIND_DATE_EVENT,
  KIND_TIME_EVENT,
} from '../../../lib/eventTypes.js'
import RsvpButtons from './RsvpButtons.jsx'
import EventActionsMenu from './EventActionsMenu.jsx'
import { buildReminderPrefill } from '../../../lib/eventReminder.js'
import CommentsThread from './CommentsThread.jsx'
import ZapModal from '../../../components/ZapModal.jsx'
import { useMyZapped, useMyZapPending } from '../../../lib/useMyZapped.js'
import { useMyLiked } from '../../../lib/useMyLiked.js'
import { publishLike } from '../../../lib/publishLike.js'
import { useCommentCount, formatCommentCount } from '../../../lib/useCommentCount.js'

export default function EventDetail({ naddr, viewerNpub, sessionUser }) {
  const navigate = useNavigate()
  const location = useLocation()

  // Back button: if the user navigated here from elsewhere in the app,
  // history.back is the right move (preserves their feed scroll +
  // filter state). On a fresh deep-link (no in-app history), fall
  // back to the author's events list — leaving the app via -1 from
  // a deep link feels broken. React Router stamps `location.key`
  // with 'default' on the entry route; any other key means we came
  // from a navigate() within the SPA.
  const handleBack = useCallback(() => {
    if (location.key && location.key !== 'default') {
      navigate(-1)
      return
    }
    let authorPubkey = ''
    try {
      const decoded = naddr ? nip19.decode(naddr) : null
      if (decoded?.type === 'naddr') authorPubkey = decoded.data.pubkey
    } catch {}
    if (authorPubkey) {
      try {
        const authorNpub = nip19.npubEncode(authorPubkey)
        navigate(`/${authorNpub}/events`)
        return
      } catch {}
    }
    if (viewerNpub) navigate(`/${viewerNpub}/events`)
    else navigate('/')
  }, [location.key, navigate, naddr, viewerNpub])

  const [parsed, setParsed] = useState(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [hostProfile, setHostProfile] = useState(null)

  // RSVP state
  const [myStatus, setMyStatus] = useState('')
  const [counts, setCounts] = useState({ accepted: 0, tentative: 0, declined: 0 })

  // Three-dot menu — anchor + open state. Trigger ref is passed into
  // EventActionsMenu so its portaled body anchors off this exact button.
  const menuTriggerRef = useRef(null)
  const [menuOpen, setMenuOpen] = useState(false)

  // Zap state — opens ZapModal targeting the event coordinate so the
  // receipt references this specific event, not just the host.
  const [zapOpen, setZapOpen] = useState(false)

  const isOwner = sessionUser?.pubkey && parsed?.pubkey && sessionUser.pubkey === parsed.pubkey

  // "Load in editor" handler — owner-only. Writes the snapshot into the
  // composer's autosave key and navigates to /<npub>/events/write so
  // EventComposer picks it up via loadAutosave on mount. The composer
  // is a single-draft surface, so this clobbers any in-progress draft;
  // the user explicitly chose this action and the draft was already
  // auto-saved elsewhere if they were mid-edit on a different event.
  const handleLoadInEditor = useCallback(({ snapshot }) => {
    if (!sessionUser?.pubkey || !sessionUser?.npub) return
    try {
      const key = `mynostr_event_draft_${sessionUser.pubkey}`
      localStorage.setItem(key, JSON.stringify(snapshot))
    } catch {
      // localStorage can fail in private/quota-exceeded modes — fall
      // through to the navigate so the user at least lands on the
      // composer instead of staring at an unresponsive menu item.
    }
    navigate(`/${sessionUser.npub}/events/write`)
  }, [navigate, sessionUser])

  // "Schedule reminder" — opens the notes composer with a quoted naddr,
  // a pre-populated body, and (when the event is far enough out) the
  // schedule toggle pre-checked at event.start − 24h. The composer's
  // existing auto-toggle on `snapshot.publishAt` does the schedule-mode
  // hydration; we just hand it the prefill via router state.
  const handleScheduleReminder = useCallback((p) => {
    if (!sessionUser?.pubkey || !sessionUser?.npub) return
    const prefill = buildReminderPrefill(p)
    if (!prefill) return
    navigate(`/${sessionUser.npub}/notes/write`, { state: { composerPrefill: prefill } })
  }, [navigate, sessionUser])

  const handleDeleted = useCallback(() => {
    // Land back on the user's events list — relay-side tombstone will
    // propagate; mynostr's own feeds honour kind 5 by id.
    if (viewerNpub) navigate(`/${viewerNpub}/events`)
    else navigate('/')
  }, [navigate, viewerNpub])

  // Resolve naddr → fetch event
  useEffect(() => {
    let cancelled = false
    setLoading(true); setNotFound(false); setParsed(null); setHostProfile(null)
    setMyStatus(''); setCounts({ accepted: 0, tentative: 0, declined: 0 })
    const decoded = decodeNaddr(naddr)
    if (!decoded) { setLoading(false); setNotFound(true); return }
    const ndk = getNDK()
    ;(async () => {
      try {
        await connectAndWait(ndk, 3000)
        const ev = await ndk.fetchEvent({
          kinds: [decoded.kind],
          authors: [decoded.pubkey],
          '#d': [decoded.identifier],
        })
        if (cancelled) return
        if (!ev) { setNotFound(true); setLoading(false); return }
        const p = parseCalendarEvent({
          id: ev.id,
          pubkey: ev.pubkey,
          kind: ev.kind,
          tags: ev.tags || [],
          content: ev.content || '',
          created_at: ev.created_at,
        })
        if (!p) { setNotFound(true); setLoading(false); return }
        setParsed(p)
        setLoading(false)
        // Fan out: host kind 0 + RSVPs (all + mine)
        ndk.fetchEvent({ kinds: [0], authors: [p.pubkey] })
          .then(prof => {
            if (cancelled || !prof) return
            try { setHostProfile(JSON.parse(prof.content || '{}')) } catch {}
          }).catch(() => {})
        refreshRsvps(p, sessionUser?.pubkey, cancelledRef => {
          if (cancelledRef) return
          // counts + my status set inside refreshRsvps
        }, setCounts, setMyStatus)
      } catch {
        if (!cancelled) { setNotFound(true); setLoading(false) }
      }
    })()
    return () => { cancelled = true }
  // sessionUser?.pubkey intentionally in deps — switching account changes
  // which RSVP we read as "mine". eslint-disable handled implicitly by
  // the wrapped refreshRsvps closure capture.
  }, [naddr, sessionUser?.pubkey])

  const handleRsvpStatusChange = useCallback((status) => {
    // Optimistic local update so the chips reflect the new state
    // immediately. A full refetch races behind it for the count update.
    setMyStatus(prev => {
      setCounts(c => {
        const next = { ...c }
        if (prev) next[prev] = Math.max(0, next[prev] - 1)
        next[status] = (next[status] || 0) + 1
        return next
      })
      return status
    })
    if (parsed) {
      refreshRsvps(parsed, sessionUser?.pubkey, () => {}, setCounts, setMyStatus)
    }
  }, [parsed, sessionUser?.pubkey])

  const hostNpub = useMemo(
    () => safeNpubEncode(nip19, parsed?.pubkey, 'EventDetail.host'),
    [parsed?.pubkey],
  )

  // Hooks must run unconditionally on every render — hoisted above the
  // loading / notFound early returns to satisfy the rules of hooks. The
  // values themselves are safe to read while parsed is null because each
  // hook tolerates an empty addressable / undefined eventId.
  const eventATag = parsed ? `${parsed.kind}:${parsed.pubkey}:${parsed.dTag}` : ''
  const zapped     = useMyZapped({ eventId: parsed?.id, addressable: eventATag })
  const zapPending = useMyZapPending({ eventId: parsed?.id, addressable: eventATag })
  const liked      = useMyLiked({ eventId: parsed?.id, addressable: eventATag })
  const [liking, setLiking] = useState(false)
  const commentCount      = useCommentCount({ aTag: eventATag || null })
  const commentCountLabel = formatCommentCount(commentCount)
  const commentsRef = useRef(null)

  if (loading) {
    return (
      <div className="px-3 sm:px-6 py-4 sm:py-6 max-w-3xl mx-auto">
        <HeaderBar onBack={handleBack} />
        <div className="px-4 py-12 text-center text-sm text-neutral-500">
          Loading event…
        </div>
      </div>
    )
  }

  if (notFound || !parsed) {
    return (
      <div className="px-3 sm:px-6 py-4 sm:py-6 max-w-3xl mx-auto">
        <HeaderBar onBack={handleBack} />
        <div className="px-4 py-12 text-center">
          <div className="text-2xl mb-2">🤷</div>
          <div className="text-sm text-neutral-300">Event not found</div>
          <div className="text-[11px] text-neutral-500 mt-1">
            The relays we tried don't have this one. It may have been deleted, or it may live on a relay we don't talk to.
          </div>
        </div>
      </div>
    )
  }

  const hostDisplay = hostProfile?.display_name || hostProfile?.displayName || hostProfile?.name || ''
  const hostLud16 = hostProfile?.lud16 || ''
  const canLike   = !isOwner && !!sessionUser?.pubkey && !sessionUser.readOnly && !!parsed?.id
  async function handleLike() {
    if (!canLike || liking) return
    setLiking(true)
    await publishLike({
      eventId:     parsed.id,
      eventPubkey: parsed.pubkey,
      kind:        parsed.kind,
      addressable: eventATag,
    })
    setLiking(false)
  }

  return (
    <div className="px-3 sm:px-6 py-4 sm:py-6 max-w-3xl mx-auto">
      <HeaderBar
        onBack={handleBack}
        menuTriggerRef={menuTriggerRef}
        menuOpen={menuOpen}
        onToggleMenu={() => setMenuOpen(o => !o)}
      />
      <EventActionsMenu
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        parsed={parsed}
        triggerRef={menuTriggerRef}
        isOwner={isOwner}
        sessionUser={sessionUser}
        onLoadInEditor={isOwner ? handleLoadInEditor : null}
        onScheduleReminder={handleScheduleReminder}
        onDeleted={handleDeleted}
      />
      {parsed.image && isSafeUrl(parsed.image) && (
        <div className="rounded-lg overflow-hidden border border-neutral-800 mb-4 bg-neutral-950">
          <img
            src={parsed.image}
            alt=""
            className="block w-full h-auto max-h-[420px] object-cover"
            onError={(e) => { e.currentTarget.style.display = 'none' }}
          />
        </div>
      )}

      <h1 className="text-xl sm:text-2xl font-bold text-neutral-100 leading-tight">
        {parsed.title}
      </h1>
      {parsed.summary && (
        <p className="text-sm text-neutral-400 mt-1.5">{parsed.summary}</p>
      )}

      {parsed.hashtags.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {parsed.hashtags.map(t => (
            <button
              key={t}
              type="button"
              onClick={() => {
                // Land on whichever profile is currently in the URL —
                // same neutral-context rule the card click uses. The
                // tag is passed as a query param; EventsDiscover seeds
                // it into selectedTags on mount and strips the param.
                const target = viewerNpub
                if (!target) return
                navigate(`/${target}/events/discover?tag=${encodeURIComponent(t)}`)
              }}
              title={`Find more events tagged #${t}`}
              className="text-[10px] px-1.5 py-0.5 rounded bg-neutral-900 border border-neutral-800 text-neutral-400 hover:text-purple-200 hover:border-purple-800 transition-colors focus:outline-none focus:ring-1 focus:ring-purple-600"
            >
              #{t}
            </button>
          ))}
        </div>
      )}

      {/* Meta block */}
      <div className="mt-4 space-y-1.5 text-sm">
        <MetaRow icon="🕒" body={formatEventTime(parsed)} />
        {parsed.location && <MetaRow icon="📍" body={parsed.location} />}
        {hostNpub && (
          <MetaRow
            icon="🎙"
            body={
              <>
                Hosted by{' '}
                <a
                  href={`/${hostNpub}/profile`}
                  className="text-purple-300 hover:text-purple-200 underline-offset-2 hover:underline"
                >
                  {hostDisplay || `${hostNpub.slice(0, 14)}…`}
                </a>
              </>
            }
          />
        )}
      </div>

      {/* RSVP block */}
      <div className="mt-5 pt-4 border-t border-neutral-800">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <RsvpButtons
            parsed={parsed}
            sessionUser={sessionUser}
            currentStatus={myStatus}
            onStatusChange={handleRsvpStatusChange}
          />
          {/* Comment — scrolls to the inline thread below. Count covers
              both kind 1 (legacy) and kind 1111 (NIP-22) replies on the
              event's a-tag, matching what CommentsThread renders. */}
          <button
            type="button"
            onClick={() => commentsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
            title="Jump to comments"
            className="text-xs px-3 py-1.5 rounded-md border border-neutral-700 text-neutral-300 bg-neutral-900 hover:border-neutral-500 hover:text-neutral-100 transition-colors inline-flex items-center gap-1.5"
          >
            <span aria-hidden>💬</span>
            <span>{commentCountLabel || 'Comment'}</span>
          </button>
          {canLike && (
            <button
              type="button"
              onClick={handleLike}
              disabled={liking || liked}
              title={liked ? 'You liked this event' : 'Like this event'}
              className={`text-xs px-3 py-1.5 rounded-md border focus:outline-none focus:ring-1 focus:ring-red-500 disabled:opacity-60 transition-colors inline-flex items-center gap-1.5 ${
                liked
                  ? 'border-red-700 text-red-300 bg-red-950/40'
                  : 'border-neutral-700 text-neutral-300 bg-neutral-900 hover:border-red-700 hover:text-red-300'
              } ${liking ? 'animate-pulse' : ''}`}
            >
              <span aria-hidden>{liked ? '❤️' : '🤍'}</span>
              <span>{liked ? 'Liked' : 'Like'}</span>
            </button>
          )}
          {hostLud16 && !isOwner && (
            <button
              type="button"
              onClick={() => setZapOpen(true)}
              title={zapped ? 'You zapped this event · zap again' : `Zap ${hostDisplay || 'the host'}`}
              className={`text-xs px-3 py-1.5 rounded-md border focus:outline-none focus:ring-1 focus:ring-amber-500 transition-colors inline-flex items-center gap-1.5 ${
                zapped
                  ? 'border-amber-500 text-amber-100 bg-amber-700/40 hover:bg-amber-700/55'
                  : 'border-amber-700/60 text-amber-200 bg-amber-950/30 hover:bg-amber-900/40 hover:text-amber-100'
              } ${zapPending ? 'animate-pulse' : ''}`}
            >
              <span aria-hidden>⚡</span>
              <span>{zapped ? 'Zapped' : 'Zap'}</span>
            </button>
          )}
        </div>
        <div className="mt-2.5 text-[11px] text-neutral-500">
          <span className="text-neutral-300 font-medium">{counts.accepted}</span> going
          <span className="mx-1.5 text-neutral-700">·</span>
          <span className="text-neutral-300 font-medium">{counts.tentative}</span> maybe
          {counts.declined > 0 && (
            <>
              <span className="mx-1.5 text-neutral-700">·</span>
              <span className="text-neutral-300 font-medium">{counts.declined}</span> not going
            </>
          )}
        </div>
      </div>

      {/* Description */}
      {parsed.content && (
        <div className="mt-6 pt-4 border-t border-neutral-800 prose prose-invert prose-sm max-w-none font-sans prose-img:block prose-img:mx-auto prose-img:max-h-[70vh]">
          <MDEditor.Markdown
            source={parsed.content}
            rehypePlugins={[rehypeSanitize]}
            style={{ backgroundColor: 'transparent', color: 'inherit' }}
          />
        </div>
      )}

      <div ref={commentsRef} className="scroll-mt-4">
        <CommentsThread parsed={parsed} sessionUser={sessionUser} />
      </div>

      {zapOpen && hostLud16 && (
        <ZapModal
          lud16={hostLud16}
          recipientPubkey={parsed.pubkey}
          recipientName={hostDisplay || 'host'}
          targetEvent={parsed.id ? { id: parsed.id } : null}
          aTag={eventATag}
          targetKind={String(parsed.kind)}
          user={sessionUser}
          onClose={() => setZapOpen(false)}
        />
      )}
    </div>
  )
}

// Top bar of the detail page: Back chip on the left, three-dots menu
// trigger on the right (when wired). Used in the loading and not-found
// states too, so the user always has a way out — `onToggleMenu` and
// `menuTriggerRef` are optional, omitted in those states.
function HeaderBar({ onBack, menuTriggerRef, menuOpen, onToggleMenu }) {
  return (
    <div className="flex items-center justify-between mb-4">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded border border-neutral-800 text-neutral-400 hover:text-neutral-100 hover:border-neutral-600 focus:outline-none focus:ring-1 focus:ring-purple-600 transition-colors"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path d="M6.5 2 L3 5 L6.5 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Back
      </button>
      {onToggleMenu && (
        <button
          ref={menuTriggerRef}
          type="button"
          onClick={onToggleMenu}
          aria-expanded={menuOpen}
          aria-label="More actions"
          className="inline-flex items-center justify-center w-7 h-7 rounded border border-neutral-800 text-neutral-400 hover:text-neutral-100 hover:border-neutral-600 focus:outline-none focus:ring-1 focus:ring-purple-600 transition-colors"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
            <circle cx="3" cy="8" r="1.4" fill="currentColor" />
            <circle cx="8" cy="8" r="1.4" fill="currentColor" />
            <circle cx="13" cy="8" r="1.4" fill="currentColor" />
          </svg>
        </button>
      )}
    </div>
  )
}

function MetaRow({ icon, body }) {
  return (
    <div className="flex items-start gap-2 text-neutral-300">
      <span className="shrink-0">{icon}</span>
      <span className="min-w-0 break-words">{body}</span>
    </div>
  )
}

// ── RSVP fetch helper ─────────────────────────────────────────────────

/**
 * Pull all RSVPs for this event coordinate, dedup latest-per-author,
 * tally counts, and locate the session user's own RSVP if any.
 *
 * `onCancelled` is called once with `false`; callers track their own
 * cancellation flag and treat the rest as best-effort.
 */
async function refreshRsvps(parsed, myPubkey, _onCancelled, setCounts, setMyStatus) {
  const ndk = getNDK()
  try {
    await connectAndWait(ndk, 3000)
    const events = await ndk.fetchEvents({
      kinds: [KIND_RSVP],
      '#a': [coordOf(parsed)],
    })
    const list = []
    for (const ev of events || []) {
      const r = parseRsvp({
        id: ev.id, pubkey: ev.pubkey, kind: ev.kind,
        tags: ev.tags || [], content: ev.content || '', created_at: ev.created_at,
      })
      if (r) list.push(r)
    }
    const deduped = dedupRsvpsLatest(list)
    const next = { accepted: 0, tentative: 0, declined: 0 }
    let mine = ''
    for (const r of deduped) {
      next[r.status] = (next[r.status] || 0) + 1
      if (myPubkey && r.pubkey === myPubkey) mine = r.status
    }
    setCounts(next)
    setMyStatus(mine)
  } catch {
    // Non-fatal — leave the chips empty.
  }
}

// (kept here for clarity even though only the kinds are referenced;
//  the import keeps the parser happy on tree-shaken builds)
void KIND_DATE_EVENT
void KIND_TIME_EVENT
