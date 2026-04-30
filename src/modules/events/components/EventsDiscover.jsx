/**
 * EventsDiscover — global future-events feed PLUS an "events by a
 * specific npub" mode entered via the search bar at the top.
 *
 * Two modes share most of the rendering chrome:
 *
 *   GLOBAL (default)
 *     • Fetches kind 31922/31923 across the user's read relays.
 *     • Filtered to future events only — past events in global Discover
 *       would just be a noisy dump.
 *     • Pills: All upcoming / Today / This week / This month.
 *
 *   AUTHOR (after picking an npub in the search box)
 *     • Fetches kind 31922/31923 by `authors: [pubkey]`.
 *     • Includes past events — the explicit reason to enter this mode
 *       is "show me what so-and-so has done."
 *     • Pills: All / Upcoming / Past.
 *
 * Hashtag chips operate on whichever set the pills land on, so the
 * chip row reflects the visible feed in either mode.
 *
 * Why limit by `limit` rather than time-window in global mode: relays
 * return the newest-published events first. A wide limit (300) catches
 * recent publishes that happen to be for events months out; an explicit
 * `since` filter would miss old-publish + future-event combos.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { nip19 } from 'nostr-tools'
import { getNDK, connectAndWait } from '../../../lib/ndk.js'
import { isSafeUrl, safeNpubEncode } from '../../../lib/utils.js'
import {
  KIND_DATE_EVENT,
  KIND_TIME_EVENT,
  parseCalendarEvent,
  isFutureEvent,
} from '../../../lib/eventTypes.js'
import { useEventRsvpSummaries } from '../../../lib/useEventRsvpSummaries.js'
import UserSearch from '../../../components/UserSearch.jsx'
import EventCard from './EventCard.jsx'

const GLOBAL_WINDOWS = [
  { id: 'all',   label: 'All upcoming' },
  { id: 'today', label: 'Today'        },
  { id: 'week',  label: 'This week'    },
  { id: 'month', label: 'This month'   },
]
const AUTHOR_WINDOWS = [
  { id: 'all',      label: 'All'      },
  { id: 'upcoming', label: 'Upcoming' },
  { id: 'past',     label: 'Past'     },
]

const TOP_TAG_LIMIT = 12

// ── Filter persistence ────────────────────────────────────────────────
// Mirrors marketplace SearchTab's pattern: per-pubkey localStorage so
// switching accounts on the same machine doesn't bleed filter state
// across users. Restored on mount via useMemo (synchronous, no flash);
// written on every change. Set is converted to array for JSON.
function filtersKey(pubkey) {
  return `mynostr_events_discover_filters_${pubkey || 'anon'}`
}
function loadSavedFilters(pubkey) {
  try {
    const raw = localStorage.getItem(filtersKey(pubkey))
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}
function saveFilters(pubkey, data) {
  try { localStorage.setItem(filtersKey(pubkey), JSON.stringify(data)) } catch {}
}

export default function EventsDiscover({ sessionUser }) {
  const sessionPubkey = sessionUser?.pubkey || null

  // Synchronous restore from localStorage on first mount — same-render
  // init avoids the flash of "default filters, then saved values pop in"
  // that a useEffect-based restore would cause.
  const saved = useMemo(() => loadSavedFilters(sessionPubkey) || {}, [sessionPubkey])

  // searchAuthor = null → global mode. Otherwise { pubkey, name, picture }
  // from UserSearch.onPickAuthor.
  const [searchAuthor, setSearchAuthor] = useState(saved.searchAuthor || null)
  const [events, setEvents] = useState([])
  const [loading, setLoading] = useState(true)
  const [windowFilter, setWindowFilter] = useState(saved.windowFilter || 'all')
  const [selectedTags, setSelectedTags] = useState(() => new Set(saved.selectedTags || []))
  // Free-text keyword filter — debounced, client-side match against
  // title, summary, content body, hashtags. Intentionally NOT persisted
  // to localStorage: if the user typed a person's name or anything
  // else they'd rather not have sitting on disk indefinitely, the
  // keyword resets on tab switch / refresh. Author-search and tag
  // selections are persisted because those are explicit "filter me"
  // intents; a free-text query is more search-history-shaped.
  const [keywordInput, setKeywordInput] = useState('')
  const [debouncedKeyword, setDebouncedKeyword] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setDebouncedKeyword(keywordInput.trim().toLowerCase()), 250)
    return () => clearTimeout(t)
  }, [keywordInput])

  // Skip the "reset on mode switch" effect on the very first run so
  // restored windowFilter / selectedTags survive mount. Subsequent
  // user-driven changes to searchAuthor still reset cleanly.
  const didMountRef = useRef(false)

  // Reset filter state on mode switch — pill ids overlap between modes
  // ('all' means different things in global vs author), so a stale
  // value would silently render the wrong slice. Tags also reset
  // since the chip set rebuilds against the new fetch result.
  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true
      return
    }
    setWindowFilter('all')
    setSelectedTags(new Set())
  }, [searchAuthor?.pubkey])

  // Debounced save (500ms) so a flurry of state changes — picking an
  // author, then a window, then toggling tags — coalesces into one
  // localStorage write instead of three. Per-pubkey key prevents one
  // user's filters bleeding into another's session on the same machine.
  // keyword is intentionally omitted; see comment on the state above.
  useEffect(() => {
    const id = setTimeout(() => {
      saveFilters(sessionPubkey, {
        searchAuthor,
        windowFilter,
        selectedTags: [...selectedTags],
      })
    }, 500)
    return () => clearTimeout(id)
  }, [sessionPubkey, searchAuthor, windowFilter, selectedTags])

  // ?tag=<name> seed — set by clicking a hashtag chip on EventDetail.
  // We add it to selectedTags then strip the param so re-renders or
  // share-back-and-forth don't keep re-seeding. Drops the global mode
  // forcibly: tag-on-author-page would silently filter against the
  // saved per-author search, which is rarely the intent.
  const [searchParams, setSearchParams] = useSearchParams()
  useEffect(() => {
    const tag = searchParams.get('tag')
    if (!tag) return
    const cleaned = tag.trim().toLowerCase()
    if (!cleaned) {
      setSearchParams({}, { replace: true })
      return
    }
    setSearchAuthor(null)
    setWindowFilter('all')
    setSelectedTags(prev => {
      const next = new Set(prev)
      next.add(cleaned)
      return next
    })
    setSearchParams({}, { replace: true })
    // searchParams is intentionally the only dep — we want this to fire
    // whenever the URL gets a fresh ?tag, including subsequent clicks.
  }, [searchParams, setSearchParams])

  // Optimistic drop after a kind-5 from the card menu.
  const handleDeleted = (deleted) => {
    setEvents(prev => prev.filter(p =>
      !(p.kind === deleted.kind && p.pubkey === deleted.pubkey && p.dTag === deleted.dTag)
    ))
  }

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setEvents([])
    const ndk = getNDK()
    ;(async () => {
      try {
        await connectAndWait(ndk, 3000)
        // Author-mode: pin to one author and pull more revisions per
        // dTag (latest-wins dedup below). 200 is generous for one
        // person's calendar and sized so a heavy organizer still gets
        // their full history.
        const filter = searchAuthor
          ? {
              kinds: [KIND_DATE_EVENT, KIND_TIME_EVENT],
              authors: [searchAuthor.pubkey],
              limit: 200,
            }
          : {
              kinds: [KIND_DATE_EVENT, KIND_TIME_EVENT],
              limit: 300,
            }
        const set = await ndk.fetchEvents(filter)
        if (cancelled) return
        const byCoord = new Map()
        for (const ev of set || []) {
          const d = ev.tags?.find(t => t[0] === 'd')?.[1]
          if (!d) continue
          const key = `${ev.kind}:${ev.pubkey}:${d}`
          const prev = byCoord.get(key)
          if (!prev || (ev.created_at || 0) > (prev.created_at || 0)) byCoord.set(key, ev)
        }
        const parsed = []
        for (const ev of byCoord.values()) {
          const p = parseCalendarEvent({
            id: ev.id, pubkey: ev.pubkey, kind: ev.kind,
            tags: ev.tags || [], content: ev.content || '', created_at: ev.created_at,
          })
          if (p) parsed.push(p)
        }
        setEvents(parsed)
      } catch {
        if (!cancelled) setEvents([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [searchAuthor?.pubkey])

  // Base list: in global mode, future-only sorted ascending. In author
  // mode, all events — past sorted most-recent-first underneath the
  // ascending future block, mirroring MyCreated's split.
  const baseList = useMemo(() => {
    const now = Math.floor(Date.now() / 1000)
    if (!searchAuthor) {
      return events
        .filter(p => isFutureEvent(p, now))
        .sort((a, b) => a.startUnix - b.startUnix)
    }
    const upcoming = events.filter(p => isFutureEvent(p, now))
                            .sort((a, b) => a.startUnix - b.startUnix)
    const past = events.filter(p => !isFutureEvent(p, now))
                       .sort((a, b) => b.startUnix - a.startUnix)
    return [...upcoming, ...past]
  }, [events, searchAuthor])

  const topHashtags = useMemo(() => {
    const counts = new Map()
    for (const p of baseList) {
      for (const t of p.hashtags || []) {
        counts.set(t, (counts.get(t) || 0) + 1)
      }
    }
    const sorted = [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, TOP_TAG_LIMIT)
    return sorted.map(([tag, count]) => ({ tag, count }))
  }, [baseList])

  // Reconcile selection when the chip set changes (relay roll, mode
  // switch). Same logic as before — drop tags no longer present so
  // the user can't be stuck filtering by an invisible tag.
  useEffect(() => {
    if (selectedTags.size === 0) return
    const present = new Set(topHashtags.map(t => t.tag))
    let changed = false
    const next = new Set()
    for (const t of selectedTags) {
      if (present.has(t)) next.add(t)
      else changed = true
    }
    if (changed) setSelectedTags(next)
  }, [topHashtags, selectedTags])

  const filtered = useMemo(() => {
    let out = baseList
    out = applyWindow(out, windowFilter, !!searchAuthor)
    if (selectedTags.size > 0) {
      out = out.filter(p => (p.hashtags || []).some(t => selectedTags.has(t)))
    }
    if (debouncedKeyword) {
      const q = debouncedKeyword
      out = out.filter(p => matchesKeyword(p, q))
    }
    return out
  }, [baseList, windowFilter, selectedTags, searchAuthor, debouncedKeyword])

  const { summaryFor } = useEventRsvpSummaries(filtered)

  function toggleTag(tag) {
    setSelectedTags(prev => {
      const next = new Set(prev)
      if (next.has(tag)) next.delete(tag)
      else next.add(tag)
      return next
    })
  }

  const pillSet = searchAuthor ? AUTHOR_WINDOWS : GLOBAL_WINDOWS

  return (
    <div className="max-w-2xl mx-auto px-4 py-4">
      {/* Search row sits above filters. UserSearch handles npub /
          nprofile / free-text → pubkey resolution; we capture the
          author and switch the fetch effect. Free text uses Primal's
          ranked user_search and surfaces results inline. */}
      <div className="mb-3">
        {searchAuthor ? (
          <ActiveAuthorChip
            author={searchAuthor}
            onClear={() => setSearchAuthor(null)}
          />
        ) : (
          <UserSearch
            placeholder="Search events by npub, nprofile, or name…"
            onPickAuthor={(a) => setSearchAuthor(a)}
            inputClassName="w-full bg-neutral-900 border border-neutral-700 rounded-md px-3 py-1.5 text-sm text-neutral-100 placeholder:text-neutral-500 focus:outline-none focus:border-purple-600"
          />
        )}
      </div>

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-16 rounded bg-neutral-900 animate-pulse" />
          ))}
        </div>
      ) : baseList.length === 0 ? (
        <EmptyState searchAuthor={searchAuthor} />
      ) : (
        <>
          <KeywordInput
            value={keywordInput}
            onChange={setKeywordInput}
            onClear={() => setKeywordInput('')}
          />
          <FilterStrip
            pillSet={pillSet}
            windowFilter={windowFilter}
            onWindowChange={setWindowFilter}
            topHashtags={topHashtags}
            selectedTags={selectedTags}
            onToggleTag={toggleTag}
            onClearTags={() => setSelectedTags(new Set())}
          />
          {filtered.length === 0 ? (
            <div className="px-2 py-12 text-center text-xs text-neutral-500">
              No events match the current filters.
            </div>
          ) : (
            filtered.map(p => (
              <EventCard
                key={p.naddr || p.id}
                parsed={p}
                summary={summaryFor(p)}
                sessionUser={sessionUser}
                onDeleted={handleDeleted}
              />
            ))
          )}
        </>
      )}
    </div>
  )
}

function ActiveAuthorChip({ author, onClear }) {
  const np = safeNpubEncode(nip19, author.pubkey, 'ActiveAuthorChip')
  const npubShort = np ? `${np.slice(0, 12)}…${np.slice(-4)}` : ''
  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-md border border-purple-900/50 bg-purple-950/20">
      {author.picture && isSafeUrl(author.picture) ? (
        <img src={author.picture} alt="" className="w-7 h-7 rounded-full object-cover flex-shrink-0"
          onError={e => { e.target.style.display = 'none' }} />
      ) : (
        <div className="w-7 h-7 rounded-full bg-neutral-800 flex-shrink-0" />
      )}
      <div className="flex-1 min-w-0">
        <div className="text-xs text-neutral-300">
          Showing events by <span className="text-neutral-100 font-medium">{author.name || 'Unknown author'}</span>
        </div>
        {npubShort && (
          <div className="text-[10px] text-neutral-500 font-mono truncate">{npubShort}</div>
        )}
      </div>
      <button
        type="button"
        onClick={onClear}
        className="flex-shrink-0 text-xs px-2 py-1 rounded border border-neutral-700 text-neutral-400 hover:text-neutral-100 hover:border-neutral-500 transition-colors"
      >
        ✕ Clear
      </button>
    </div>
  )
}

function EmptyState({ searchAuthor }) {
  if (searchAuthor) {
    return (
      <div className="px-6 py-12 text-center">
        <div className="text-3xl mb-2">📭</div>
        <div className="text-sm text-neutral-300">No events from this user</div>
        <div className="text-[11px] text-neutral-500 mt-1">
          The relays we tried didn't return any past or upcoming calendar events for this npub.
        </div>
      </div>
    )
  }
  return (
    <div className="px-6 py-12 text-center">
      <div className="text-3xl mb-2">🔭</div>
      <div className="text-sm text-neutral-300">No upcoming events found</div>
      <div className="text-[11px] text-neutral-500 mt-1">
        The relays we tried didn't return any future calendar events. Add a marketplace-friendly relay or two and try again.
      </div>
    </div>
  )
}

function KeywordInput({ value, onChange, onClear }) {
  return (
    <div className="mb-2 relative">
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search events by title, summary, description…"
        autoComplete="off"
        data-lpignore="true"
        data-1p-ignore="true"
        data-form-type="other"
        className="w-full bg-neutral-900 border border-neutral-700 rounded-md pl-3 pr-8 py-1.5 text-sm text-neutral-100 placeholder:text-neutral-500 focus:outline-none focus:border-purple-600"
      />
      {value && (
        <button
          type="button"
          onClick={onClear}
          aria-label="Clear search"
          className="absolute right-2 top-1/2 -translate-y-1/2 text-neutral-500 hover:text-neutral-200 text-xs"
        >
          ✕
        </button>
      )}
    </div>
  )
}

function FilterStrip({
  pillSet,
  windowFilter, onWindowChange,
  topHashtags, selectedTags, onToggleTag, onClearTags,
}) {
  const hasTags = topHashtags.length > 0
  return (
    <div className="mb-3 space-y-2">
      <div className="flex items-center gap-0 overflow-x-auto -mx-2 px-2">
        {pillSet.map(({ id, label }, i, arr) => {
          const isActive = windowFilter === id
          return (
            <button
              key={id}
              type="button"
              onClick={() => onWindowChange(id)}
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

      {hasTags && (
        <div className="flex items-center gap-1.5 overflow-x-auto -mx-2 px-2 pb-0.5">
          {topHashtags.map(({ tag, count }) => {
            const isActive = selectedTags.has(tag)
            return (
              <button
                key={tag}
                type="button"
                onClick={() => onToggleTag(tag)}
                className={`text-[11px] px-2 py-0.5 rounded-full border transition-colors flex-shrink-0 whitespace-nowrap
                  ${isActive
                    ? 'bg-purple-950/60 border-purple-700 text-purple-200'
                    : 'bg-neutral-900 border-neutral-800 text-neutral-400 hover:text-neutral-100 hover:border-neutral-600'}`}
              >
                #{tag}
                <span className={`ml-1 text-[9px] ${isActive ? 'text-purple-300/70' : 'text-neutral-600'}`}>
                  {count}
                </span>
              </button>
            )
          })}
          {selectedTags.size > 0 && (
            <button
              type="button"
              onClick={onClearTags}
              className="text-[11px] px-2 py-0.5 rounded-full border border-transparent text-neutral-500 hover:text-neutral-200 flex-shrink-0 whitespace-nowrap"
            >
              clear ✕
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// Lowercased substring match against the searchable surface area of
// a parsed event. Hashtags are matched without the leading # so a
// query of "bitcoin" surfaces #bitcoin events too.
function matchesKeyword(parsed, q) {
  if (!q) return true
  const haystack = [
    parsed.title,
    parsed.summary,
    parsed.content,
    parsed.location,
    ...(parsed.hashtags || []),
  ].filter(Boolean).join(' ').toLowerCase()
  return haystack.includes(q)
}

// ── Time-window helpers ───────────────────────────────────────────────

// Pill semantics differ by mode. In author mode the pills are simple
// future/past splits; in global mode they're calendar buckets.
function applyWindow(events, windowId, isAuthorMode) {
  if (windowId === 'all') return events
  const nowSec = Math.floor(Date.now() / 1000)

  if (isAuthorMode) {
    if (windowId === 'upcoming') return events.filter(p => isFutureEvent(p, nowSec))
    if (windowId === 'past')     return events.filter(p => !isFutureEvent(p, nowSec))
    return events
  }

  const now = new Date()
  let endSec
  if (windowId === 'today') {
    const end = new Date(now)
    end.setHours(23, 59, 59, 999)
    endSec = Math.floor(end.getTime() / 1000)
  } else if (windowId === 'week') {
    const end = new Date(now)
    end.setDate(end.getDate() + 7)
    end.setHours(23, 59, 59, 999)
    endSec = Math.floor(end.getTime() / 1000)
  } else if (windowId === 'month') {
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999)
    endSec = Math.floor(end.getTime() / 1000)
  } else {
    return events
  }
  return events.filter(p => p.startUnix <= endSec)
}
