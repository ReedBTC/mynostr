/**
 * EventsModule — NIP-52 calendar events.
 *
 * Subtabs:
 *   created     — kind 31922/31923 by the viewed user (default)
 *   rsvps       — kind 31925 by the viewed user, dereferenced to events
 *   discover    — global future-events feed
 *   write       — composer (owner only); visitors get bounced
 *   calendars   — kind 31924 calendar-list grid for the viewed user
 *   cal-<dTag>  — single calendar detail page
 *   naddr1…     — single-event detail page (deep link target)
 *
 * Detail-page routing note: existing modules (Articles, Marketplace)
 * use modal/drawer detail. Events live or die on shareability, so the
 * detail pages are real URLs. The shell detects subtab prefixes:
 *   `naddr1…`    → EventDetail
 *   `cal-<dTag>` → CalendarDetailView
 * Other subtabs flow into the standard tab strip.
 */
import { useCallback, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useOwnerContext } from '../../lib/ownerContext.jsx'
import ErrorBoundary from '../../components/ErrorBoundary.jsx'
import EventComposer from './components/EventComposer.jsx'
import EventDetail from './components/EventDetail.jsx'
import EventsDiscover from './components/EventsDiscover.jsx'
import MyCreated from './components/MyCreated.jsx'
import MyRsvps from './components/MyRsvps.jsx'
import CalendarsTab from './components/CalendarsTab.jsx'
import CalendarDetailView from './components/CalendarDetailView.jsx'

const TAB_DEFS_VISITOR = [
  { id: 'created',   label: 'Events' },
  { id: 'rsvps',     label: 'RSVPs'  },
  { id: 'calendars', label: 'Calendars' },
  { id: 'discover',  label: 'Discover' },
]
// Owner tab order matches the other modules' "write/sell tab first,
// then the public-visible feeds, then discover/search." Labels are
// the user-facing rename: My Events / RSVPs / My Calendars / Discover.
const TAB_DEFS_OWNER = [
  { id: 'write',     label: 'New Event' },
  { id: 'created',   label: 'My Events' },
  { id: 'rsvps',     label: 'My RSVPs'  },
  { id: 'calendars', label: 'My Calendars' },
  { id: 'discover',  label: 'Discover'  },
]

export default function EventsModule({ user, sessionUser, subtab }) {
  const { isOwner } = useOwnerContext()
  const navigate = useNavigate()
  const npub = user?.npub

  // Detail-page detection — both naddr1… (single event) and cal-…
  // (single calendar list) render via dedicated detail components,
  // bypassing the tab strip.
  const isEventDetail    = typeof subtab === 'string' && subtab.startsWith('naddr1')
  const isCalendarDetail = typeof subtab === 'string' && subtab.startsWith('cal-')
  const isDetail = isEventDetail || isCalendarDetail
  const calendarDTag = isCalendarDetail ? decodeURIComponent(subtab.slice(4)) : ''

  const moduleTab = (() => {
    if (isDetail) return null
    if (subtab === 'write' && isOwner) return 'write'
    if (subtab === 'rsvps')     return 'rsvps'
    if (subtab === 'discover')  return 'discover'
    if (subtab === 'calendars') return 'calendars'
    if (subtab === 'created')   return 'created'
    return 'created'
  })()

  const setModuleTab = useCallback((id) => {
    if (!npub) return
    const path = id === 'created' ? `/${npub}/events` : `/${npub}/events/${id}`
    navigate(path)
  }, [npub, navigate])

  // Visitor bounce: write is owner-only.
  useEffect(() => {
    if (!isOwner && subtab === 'write' && npub) {
      navigate(`/${npub}/events`, { replace: true })
    }
  }, [isOwner, subtab, npub, navigate])

  const tabs = isOwner ? TAB_DEFS_OWNER : TAB_DEFS_VISITOR

  // Per-surface ErrorBoundary wrappers. A render error in one tab or
  // detail page paints a styled fallback inside its own wrapper rather
  // than blanking the whole module, and the user can still navigate
  // via the tab strip / Back button to recover.
  if (isEventDetail) {
    return (
      <div className="flex-1 min-h-0 overflow-y-auto">
        <ErrorBoundary label="EventDetail">
          <EventDetail naddr={subtab} viewerNpub={npub} sessionUser={sessionUser} />
        </ErrorBoundary>
      </div>
    )
  }

  if (isCalendarDetail) {
    return (
      <div className="flex-1 min-h-0 overflow-y-auto">
        <ErrorBoundary label="CalendarDetailView">
          <CalendarDetailView
            dTag={calendarDTag}
            viewedUser={user}
            sessionUser={sessionUser}
            isOwner={isOwner}
          />
        </ErrorBoundary>
      </div>
    )
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <TabStrip tabs={tabs} active={moduleTab} onChange={setModuleTab} />
      <div className="flex-1 min-h-0 overflow-y-auto">
        {moduleTab === 'write' && (
          <ErrorBoundary label="EventComposer">
            <EventComposer sessionUser={sessionUser} ownerNpub={npub} />
          </ErrorBoundary>
        )}
        {moduleTab === 'created' && (
          <ErrorBoundary label="MyCreated">
            <MyCreated viewedUser={user} sessionUser={sessionUser} />
          </ErrorBoundary>
        )}
        {moduleTab === 'rsvps' && (
          <ErrorBoundary label="MyRsvps">
            <MyRsvps viewedUser={user} sessionUser={sessionUser} />
          </ErrorBoundary>
        )}
        {moduleTab === 'calendars' && (
          <ErrorBoundary label="CalendarsTab">
            <CalendarsTab viewedUser={user} sessionUser={sessionUser} isOwner={isOwner} />
          </ErrorBoundary>
        )}
        {moduleTab === 'discover' && (
          <ErrorBoundary label="EventsDiscover">
            <EventsDiscover viewerNpub={npub} sessionUser={sessionUser} />
          </ErrorBoundary>
        )}
      </div>
    </div>
  )
}

// Joined-button tab strip — same shape Marketplace uses (rounded ends,
// -ml-px joins, purple-600 active fill). Inner container scrolls
// horizontally on narrow screens; -mx-4 px-4 lets the scroll area run
// edge-to-edge while keeping the bar's outer padding aligned.
function TabStrip({ tabs, active, onChange }) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-neutral-800 flex-shrink-0">
      <div className="flex items-center gap-0 overflow-x-auto -mx-4 px-4 max-w-full">
        {tabs.map(({ id, label }, i, arr) => {
          const isActive = id === active
          return (
            <button
              key={id}
              type="button"
              onClick={() => onChange(id)}
              className={`text-xs px-2.5 py-1 border transition-colors flex-shrink-0 whitespace-nowrap
                ${i === 0 ? 'rounded-l' : ''} ${i === arr.length - 1 ? 'rounded-r' : ''}
                ${isActive
                  ? 'bg-purple-600 border-purple-600 text-white'
                  : 'bg-neutral-900 border-neutral-700 text-neutral-300 hover:text-white hover:border-neutral-500'}
                ${i > 0 ? '-ml-px' : ''}`}
            >
              {label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
