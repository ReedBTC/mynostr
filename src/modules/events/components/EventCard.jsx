/**
 * EventCard — the single row used in every events list (Created,
 * RSVPs, Discover). Layout:
 *   [DatePill] [title + summary + meta + RSVP avatars] [thumbnail] [⋯]
 *
 * Click the main area → navigate to the event's detail URL under the
 * CURRENT viewer's npub (or the session user's, or the home route as a
 * last-resort fallback). The naddr in the URL is the canonical event
 * identity, so EventDetail renders the right event regardless of which
 * npub is in the URL — keeping the user on whichever profile they were
 * already browsing instead of yanking them onto the author's page.
 *
 * The trailing `⋯` button opens EventActionsMenu in a portal — same
 * set of actions as on the detail page (Copy naddr, Copy share link,
 * Load in editor, Export JSON, View on njump.me / Plektos, Delete).
 * The "Copy share link" inside the menu still uses the author's npub
 * so shared URLs are canonical.
 *
 * Owner-only actions (Load in editor, Delete) are gated by comparing
 * the session user's pubkey to the event's pubkey. Visitors get the
 * read-only subset (Copy + View externally + Export).
 */
import { useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { isSafeUrl } from '../../../lib/utils.js'
import { dateBits, formatEventTime } from '../../../lib/eventTypes.js'
import { buildReminderPrefill } from '../../../lib/eventReminder.js'
import EventActionsMenu from './EventActionsMenu.jsx'

export default function EventCard({ parsed, summary, sessionUser, onDeleted }) {
  const navigate = useNavigate()
  const { npub: routeNpub } = useParams()
  const menuTriggerRef = useRef(null)
  const [menuOpen, setMenuOpen] = useState(false)

  if (!parsed) return null
  const { dayNum, monthShort } = dateBits(parsed)

  const isOwner = !!sessionUser?.pubkey && sessionUser.pubkey === parsed.pubkey

  function handleClick() {
    if (!parsed.naddr) return
    // Keep the user on whichever profile context they were browsing
    // (Discover/My Events/My RSVPs are all under some npub's URL).
    // Falls back to the session user's npub for hypothetical embeds
    // outside the route, and finally to home if neither is known —
    // never navigate to the author's profile.
    const targetNpub = routeNpub || sessionUser?.npub
    if (!targetNpub) {
      navigate(`/`)
      return
    }
    navigate(`/${targetNpub}/events/${parsed.naddr}`)
  }

  // "Load in editor" — owner-only. Seeds the composer's localStorage
  // (mynostr_event_draft_<pubkey>) and navigates to /<npub>/events/write
  // so EventComposer's loadAutosave picks the snapshot up on mount.
  // Same flow as EventDetail's handler — kept inline here so the card
  // is self-contained and doesn't need an orchestrating prop.
  function handleLoadInEditor({ snapshot }) {
    if (!sessionUser?.pubkey || !sessionUser?.npub) return
    try {
      const key = `mynostr_event_draft_${sessionUser.pubkey}`
      localStorage.setItem(key, JSON.stringify(snapshot))
    } catch {
      // localStorage can fail in private/quota-exceeded modes — fall
      // through to the navigate so the user lands on the composer.
    }
    navigate(`/${sessionUser.npub}/events/write`)
  }

  // "Schedule reminder" — opens the notes composer with a quoted naddr,
  // pre-populated body, and the schedule toggle pre-checked at
  // event.start − 24h (when the event is far enough out). Mirrors
  // EventDetail's handler — composerPrefill flows through router state
  // and NotesModule does the createDraft + nav to /notes/write.
  function handleScheduleReminder(p) {
    if (!sessionUser?.pubkey || !sessionUser?.npub) return
    const prefill = buildReminderPrefill(p)
    if (!prefill) return
    navigate(`/${sessionUser.npub}/notes/write`, { state: { composerPrefill: prefill } })
  }

  return (
    <div className="group flex items-stretch gap-3 px-3 py-2.5 border-b border-neutral-900 hover:bg-neutral-900/40 focus-within:bg-neutral-900/40 transition-colors">
      <button
        type="button"
        onClick={handleClick}
        className="flex-1 min-w-0 flex items-stretch gap-3 text-left focus:outline-none"
      >
        <DatePill dayNum={dayNum} monthShort={monthShort} />
        <div className="flex-1 min-w-0">
          <div className="text-sm text-neutral-100 font-medium truncate group-hover:text-purple-200">
            {parsed.title}
          </div>
          {parsed.summary && (
            <div className="text-[11px] text-neutral-400 truncate mt-0.5">
              {parsed.summary}
            </div>
          )}
          <div className="text-[10px] text-neutral-500 mt-1 flex items-center gap-2 flex-wrap">
            <span className="truncate">{formatEventTime(parsed)}</span>
            {parsed.location && (
              <>
                <span className="text-neutral-700">·</span>
                <span className="truncate">📍 {parsed.location}</span>
              </>
            )}
          </div>
          {summary && summary.goingCount > 0 && (
            <div className="mt-1.5">
              <RsvpAvatarStack summary={summary} />
            </div>
          )}
        </div>
        {parsed.image && isSafeUrl(parsed.image) && (
          <div className="hidden sm:block shrink-0 w-20 h-20 rounded overflow-hidden bg-neutral-900">
            <img
              src={parsed.image}
              alt=""
              className="w-full h-full object-cover"
              loading="lazy"
              onError={(e) => { e.currentTarget.style.display = 'none' }}
            />
          </div>
        )}
      </button>

      {/* Trailing three-dot trigger. Lives outside the main card button
          so clicking it doesn't navigate. The button itself
          stops propagation defensively in case the card switches to a
          larger clickable target later. */}
      <div className="flex-shrink-0 flex items-start" onMouseDown={e => e.stopPropagation()}>
        <button
          ref={menuTriggerRef}
          type="button"
          onClick={(e) => { e.stopPropagation(); setMenuOpen(o => !o) }}
          className="p-1 rounded text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800 transition-colors"
          title="Actions"
          aria-label="More actions"
          aria-expanded={menuOpen}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
            <circle cx="3" cy="8" r="1.4" />
            <circle cx="8" cy="8" r="1.4" />
            <circle cx="13" cy="8" r="1.4" />
          </svg>
        </button>
        <EventActionsMenu
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          parsed={parsed}
          triggerRef={menuTriggerRef}
          isOwner={isOwner}
          sessionUser={sessionUser}
          onLoadInEditor={isOwner ? handleLoadInEditor : null}
          onScheduleReminder={handleScheduleReminder}
          onDeleted={onDeleted ? () => onDeleted(parsed) : undefined}
        />
      </div>
    </div>
  )
}

function DatePill({ dayNum, monthShort }) {
  return (
    <div className="shrink-0 w-12 h-12 rounded border border-neutral-800 bg-neutral-950 flex flex-col items-center justify-center leading-none">
      <span className="text-[9px] uppercase tracking-wider text-purple-400 font-semibold">{monthShort}</span>
      <span className="text-lg font-bold text-neutral-100 mt-0.5">{dayNum}</span>
    </div>
  )
}

function RsvpAvatarStack({ summary }) {
  const { goingCount, acceptedTop = [] } = summary
  const overflow = Math.max(0, goingCount - acceptedTop.length)
  return (
    <div className="flex items-center gap-1.5">
      <div className="flex -space-x-1.5">
        {acceptedTop.map(({ pubkey, profile }) => (
          <Avatar key={pubkey} pubkey={pubkey} profile={profile} />
        ))}
        {overflow > 0 && (
          <span
            className="w-5 h-5 rounded-full bg-neutral-900 border border-neutral-700 text-[9px] font-semibold text-neutral-400 flex items-center justify-center ring-1 ring-neutral-950"
            aria-label={`${overflow} more going`}
          >
            +{overflow > 99 ? '99' : overflow}
          </span>
        )}
      </div>
      <span className="text-[10px] text-neutral-500">
        <span className="text-neutral-300 font-medium">{goingCount}</span> going
      </span>
    </div>
  )
}

function Avatar({ pubkey, profile }) {
  const url = profile?.picture && isSafeUrl(profile.picture) ? profile.picture : ''
  const fallback = (profile?.display_name || profile?.displayName || profile?.name || pubkey || '?').slice(0, 1).toUpperCase()
  return (
    <span
      className="w-5 h-5 rounded-full bg-neutral-800 border border-neutral-700 overflow-hidden flex items-center justify-center text-[9px] text-neutral-300 ring-1 ring-neutral-950"
      title={profile?.display_name || profile?.displayName || profile?.name || ''}
    >
      {url ? (
        <img
          src={url}
          alt=""
          className="w-full h-full object-cover"
          onError={(e) => { e.currentTarget.replaceWith(document.createTextNode(fallback)) }}
        />
      ) : (
        fallback
      )}
    </span>
  )
}
