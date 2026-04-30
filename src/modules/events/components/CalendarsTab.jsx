/**
 * CalendarsTab — owner sees their own kind 31924 calendar lists;
 * visitors see the page-owner's public calendars. Click a tile to
 * navigate to that calendar's detail view.
 *
 * Subtab routing: bare /events/calendars renders this grid. A row
 * click navigates to /events/calendar/<dTag> which EventsModule
 * dispatches to CalendarDetailView.
 */
import { useNavigate } from 'react-router-dom'
import { isSafeUrl } from '../../../lib/utils.js'
import { useEventCalendars } from '../../../lib/useEventCalendars.js'

export default function CalendarsTab({ viewedUser, sessionUser, isOwner }) {
  const navigate = useNavigate()
  const { calendars, loading, error } = useEventCalendars(viewedUser?.pubkey || null)

  const npub = viewedUser?.npub
  function openCalendar(dTag) {
    if (!npub || !dTag) return
    // `cal-` prefix on the subtab so EventsModule can detect a
    // calendar-detail URL without expanding the App router. dTags are
    // [a-z0-9-]+ from generateCalendarDTag, so they're URL-safe.
    navigate(`/${npub}/events/cal-${encodeURIComponent(dTag)}`)
  }

  if (!viewedUser?.pubkey) return null

  if (loading) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-24 rounded bg-neutral-900 animate-pulse" />
        ))}
      </div>
    )
  }

  if (error) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-12 text-center">
        <div className="text-3xl mb-2">⚠️</div>
        <div className="text-sm text-neutral-300">Couldn't load calendars</div>
        <div className="text-[11px] text-neutral-500 mt-1">{error}</div>
      </div>
    )
  }

  if (calendars.length === 0) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-12 text-center">
        <div className="text-3xl mb-2">🗓</div>
        <div className="text-sm text-neutral-300">
          {isOwner ? 'No calendars yet' : 'No calendars to show'}
        </div>
        <div className="text-[11px] text-neutral-500 mt-1 max-w-xs mx-auto">
          {isOwner
            ? 'Save events to a calendar from the ⋯ menu on any event.'
            : 'This user hasn\'t organized any events into calendars yet.'}
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-4 space-y-2">
      {calendars.map(({ decoded }) => (
        <CalendarRow
          key={decoded.dTag}
          decoded={decoded}
          onOpen={() => openCalendar(decoded.dTag)}
        />
      ))}
    </div>
  )
}

function CalendarRow({ decoded, onOpen }) {
  const count = (decoded.eventRefs || []).length
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group w-full flex items-stretch gap-3 px-3 py-2.5 border border-neutral-800 rounded-md hover:border-neutral-600 hover:bg-neutral-900/40 transition-colors text-left"
    >
      <Thumbnail image={decoded.image} />
      <div className="flex-1 min-w-0">
        <div className="text-sm text-neutral-100 font-medium truncate group-hover:text-purple-200">
          {decoded.title}
        </div>
        {decoded.summary && (
          <div className="text-[11px] text-neutral-400 truncate mt-0.5">
            {decoded.summary}
          </div>
        )}
        <div className="text-[10px] text-neutral-500 mt-1">
          {count} event{count === 1 ? '' : 's'}
        </div>
      </div>
    </button>
  )
}

function Thumbnail({ image }) {
  if (image && isSafeUrl(image)) {
    return (
      <img
        src={image}
        alt=""
        className="w-12 h-12 rounded bg-neutral-800 border border-neutral-700 object-cover flex-shrink-0"
        onError={(e) => { e.currentTarget.style.display = 'none' }}
      />
    )
  }
  return (
    <div className="w-12 h-12 rounded bg-neutral-800 border border-neutral-700 flex items-center justify-center text-neutral-600 flex-shrink-0">
      <span className="text-base" aria-hidden>🗓</span>
    </div>
  )
}
