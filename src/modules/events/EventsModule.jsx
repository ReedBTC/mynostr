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
 *
 * New Event tab structure (desktop): drafts tray on the left, composer
 * on the right. Mobile: composer fills the panel; a "Drafts (N)" chip
 * in the composer top action row opens the tray as a bottom sheet.
 * The tab is always mounted (hidden via CSS) so the drafts tray's
 * autosaved state survives a detour through other tabs.
 */
import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useOwnerContext } from '../../lib/ownerContext.jsx'
import { useIsMobile } from '../../hooks/useIsMobile.js'
import { useEventDrafts } from '../../lib/useEventDrafts.js'
import {
  emptyEventForm,
  eventToForm,
  fetchEventForLoader,
  formToEventTemplate,
  isEventFormMeaningful,
} from '../../lib/eventForm.js'
import { titleToSlug } from '../../lib/utils.js'
import ErrorBoundary from '../../components/ErrorBoundary.jsx'
import EventComposer from './components/EventComposer.jsx'
import EventDraftsTray from './components/EventDraftsTray.jsx'
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
  const isMobile = useIsMobile()
  const npub = user?.npub
  const ownerPubkey = isOwner ? sessionUser?.pubkey : null

  // Multi-draft store. Hook is a no-op (returns one empty draft seed)
  // when ownerPubkey is null. Called unconditionally for hook-rule
  // compliance even though visitors don't see the New Event tab.
  const drafts = useEventDrafts(ownerPubkey)

  const [draftsMobileOpen, setDraftsMobileOpen] = useState(false)

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

  // ── Drafts → composer wiring ────────────────────────────────────────
  // Most handlers are thin pass-throughs; import / export / load-from-
  // Nostr live here because they touch the file system and NDK.

  const handleImportDrafts = useCallback(async (files) => {
    // Capture whether the first draft was empty before this run so we
    // can drop it after importing — saves users from N+1 drafts when
    // they import into a fresh tray with the seeded blank.
    const seedDraft = drafts.drafts[0]
    const seedWasEmpty = seedDraft && !isEventFormMeaningful(seedDraft.snapshot)

    const result = { imported: 0, errors: [] }
    for (const f of files) {
      const name = f.name || 'file'
      // 1 MB cap matches the Notes / marketplace import path.
      if (f.size > 1_000_000) {
        result.errors.push(`${name}: over 1 MB`)
        continue
      }
      try {
        const text = await f.text()
        const ev = JSON.parse(text)
        if (!ev || typeof ev !== 'object') throw new Error('not a JSON object')
        const snapshot = eventToForm(ev)
        if (!snapshot) throw new Error('not a kind 31922/31923 event')
        // Strip dTag — JSON import is "use this as a template for a
        // new event." Carrying the dTag forward through a template /
        // duplicate-edit workflow causes every imported draft to publish
        // to the same coordinate, overwriting each other. Edit-existing
        // is the explicit Load-from-Nostr / picker path, which preserves
        // the dTag deliberately.
        snapshot.dTag = ''
        snapshot.linkedEventTitle = ''
        drafts.createDraft({ snapshot })
        result.imported++
      } catch (e) {
        result.errors.push(`${name}: ${e?.message || 'invalid JSON'}`)
      }
    }

    if (result.imported > 0 && seedWasEmpty) {
      drafts.deleteDraft(seedDraft.id)
    }
    return result
  }, [drafts])

  const handleExportAllDrafts = useCallback(() => {
    const eligible = drafts.drafts.filter(d => d.snapshot?.title?.trim())
    const result = { exported: 0, skipped: drafts.drafts.length - eligible.length }
    eligible.forEach((d, idx) => {
      try {
        const ev = formToEventTemplate(d.snapshot, { pubkey: ownerPubkey || '' })
        const blob = new Blob([JSON.stringify(ev, null, 2)], { type: 'application/json' })
        const url  = URL.createObjectURL(blob)
        const slug = titleToSlug(d.snapshot.title) || `event-${idx + 1}`
        const a = document.createElement('a')
        a.href = url
        a.download = `${slug}.json`
        // Stagger so the browser's "allow multiple downloads" prompt
        // fires once instead of per-file.
        setTimeout(() => { a.click(); URL.revokeObjectURL(url) }, idx * 150)
        result.exported++
      } catch {
        // Skip individual encode failures rather than aborting the batch.
        // formToEventTemplate throws on missing required fields (no
        // start date, etc.) — the user gets a "skipped" count instead
        // of a hard error.
      }
    })
    return result
  }, [drafts.drafts, ownerPubkey])

  // ── Per-current-draft actions ──────────────────────────────────────
  // Single import / naddr load both REPLACE the current draft's
  // snapshot — same semantics the marketplace composer uses. The
  // draft id is preserved; only the snapshot swaps.

  const handleSingleImport = useCallback(async (file) => {
    if (!drafts.currentDraft) return { ok: false, error: 'No draft selected.' }
    if (!file.name.endsWith('.json') && file.type !== 'application/json') {
      return { ok: false, error: 'Please pick a .json file.' }
    }
    if (file.size > 1_000_000) {
      return { ok: false, error: 'File too large — 1 MB max.' }
    }
    try {
      const text = await file.text()
      const ev = JSON.parse(text)
      const snapshot = eventToForm(ev)
      if (!snapshot) return { ok: false, error: 'Not a kind 31922/31923 event.' }
      // Strip dTag — see handleImportDrafts above for why.
      snapshot.dTag = ''
      snapshot.linkedEventTitle = ''
      drafts.replaceSnapshot(drafts.currentDraft.id, snapshot)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: `Invalid JSON: ${e?.message || 'parse failed'}` }
    }
  }, [drafts])

  const handleSingleExport = useCallback(() => {
    const d = drafts.currentDraft
    if (!d?.snapshot?.title?.trim()) return
    try {
      const ev   = formToEventTemplate(d.snapshot, { pubkey: ownerPubkey || '' })
      const blob = new Blob([JSON.stringify(ev, null, 2)], { type: 'application/json' })
      const url  = URL.createObjectURL(blob)
      const slug = titleToSlug(d.snapshot.title) || 'event'
      const a = document.createElement('a')
      a.href = url
      a.download = `${slug}.json`
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      // formToEventTemplate can throw on a half-empty form (e.g. no
      // start date). Swallow rather than blow up the editor on a freak
      // input — Export is disabled in the UI when title/start are missing.
    }
  }, [drafts.currentDraft, ownerPubkey])

  const handleLoadFromNostr = useCallback(async (input) => {
    if (!drafts.currentDraft) return { ok: false, error: 'No draft selected.' }
    const r = await fetchEventForLoader(input)
    if (!r.ok) return r
    let snapshot = r.snapshot
    // Cross-author import → strip dTag + linkedEventTitle so the
    // PublishIdentityBanner shows "Will publish as new event" instead
    // of misleading "Will Replace Event" copy. See marketplace's
    // handleLoadFromNostr for the longer rationale (dTag collision
    // would silently overwrite the user's own event with the imported
    // draft on publish).
    const myPubkey = sessionUser?.pubkey
    if (r.importedFromPubkey && myPubkey && r.importedFromPubkey !== myPubkey) {
      snapshot = { ...snapshot, dTag: '', linkedEventTitle: '' }
    }
    drafts.replaceSnapshot(drafts.currentDraft.id, snapshot)
    return { ok: true }
  }, [drafts, sessionUser?.pubkey])

  // ── Render ──────────────────────────────────────────────────────────

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

      {/* New Event tab is always mounted (hidden via CSS) so the drafts
          tray's autosaved state survives a detour through other tabs.
          Mirrors the marketplace Sell tab pattern. */}
      <div className={`flex-1 min-h-0 overflow-hidden ${moduleTab === 'write' && isOwner ? 'flex flex-row' : 'hidden'}`}>
        {isOwner && (
          <ErrorBoundary label="EventComposer">
            <EventDraftsTray
              drafts={drafts.drafts}
              currentDraftId={drafts.currentDraftId}
              onSelectDraft={drafts.setCurrentDraftId}
              onCreateDraft={() => drafts.createDraft()}
              onDeleteDraft={drafts.deleteDraft}
              onDeleteAllDrafts={drafts.deleteAllDrafts}
              onImportDrafts={handleImportDrafts}
              onExportAllDrafts={handleExportAllDrafts}
              onPublishAll={drafts.publishAll}
              onMoveDraft={drafts.moveDraft}
              onFindDuplicateDTags={drafts.findDuplicateDTags}
              onRegenerateDTags={drafts.regenerateDTags}
              isMobile={isMobile}
              isMobileOpen={draftsMobileOpen}
              onMobileClose={() => setDraftsMobileOpen(false)}
            />
            <div className="flex-1 flex flex-col overflow-hidden">
              <EventComposer
                sessionUser={sessionUser}
                draft={drafts.currentDraft}
                onUpdateDraft={drafts.updateDraftWith}
                onDeleteDraft={drafts.deleteDraft}
                onPublish={drafts.publishOne}
                onSingleImport={handleSingleImport}
                onSingleExport={handleSingleExport}
                onLoadFromNostr={handleLoadFromNostr}
                onOpenMobileDrafts={isMobile ? () => setDraftsMobileOpen(true) : null}
                draftsCount={drafts.drafts.length}
              />
            </div>
          </ErrorBoundary>
        )}
      </div>

      {/* Other tabs render in a separate wrapper that's hidden when
          New Event is active — keeps each tab's state isolated. */}
      <div className={`flex-1 min-h-0 overflow-y-auto ${moduleTab !== 'write' ? 'flex flex-col' : 'hidden'}`}>
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
