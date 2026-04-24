import { useState, useEffect, useCallback, useRef } from 'react'
import { nip19 } from 'nostr-tools'
import { copyToClipboard, isSafeUrl, truncateNpub, formatCount, createLRU } from '../../lib/utils.js'
import { useOwnerContext, OwnerProvider } from '../../lib/ownerContext.jsx'
import { fetchAggregateUserStats } from '../../lib/userStats.js'
import { fetchUserContentCounts } from '../../lib/userContentCounts.js'
import { fetchUserBookmarkCounts } from '../../lib/userBookmarkCounts.js'
import { fetchProfiles, fetchUserZapAggregates, fetchAuthorPostingCadence } from '../../lib/primal.js'
import UserSearch from '../../components/UserSearch.jsx'
import ShareButton from '../../components/ShareButton.jsx'
import ProfileEditor from './ProfileEditor.jsx'
import ProfileStatsCard from './ProfileStatsCard.jsx'
import ProfileActivityCard from './ProfileActivityCard.jsx'
import PostingCadenceCard from './PostingCadenceCard.jsx'
import RelayCard from './RelayCard.jsx'
import DmRelayCard from './DmRelayCard.jsx'

/**
 * ProfileModule — read view of the viewed user's kind 0 profile, plus an
 * Edit toggle for the owner that swaps in ProfileEditor. After a successful
 * publish we overlay the new content onto the session user's profile
 * object (mutating in place so every other consumer that holds the same
 * reference sees the fresh data) and bump a render counter to repaint.
 *
 * Preview mode: picking a user from the in-module UserSearch switches what's
 * rendered to that user's profile *without changing the URL* — same idea as
 * Longform's author-preview. A local OwnerProvider override ensures every
 * descendant (including RelayCard/DmRelayCard) sees isOwner=false while
 * previewing, so no Edit buttons appear on the other user's cards. A Back
 * bar at the top clears the preview and returns to your own profile.
 *
 * Stats (note/reply/follower counts from Primal) and content counts
 * (articles/events/listings from relays) are fetched once at the module
 * level and passed down.
 */

// Module-level caches so switching tabs away and back doesn't re-hammer
// the network for rarely-changing aggregate counts. Bounded LRU so viewing
// many profiles in one session doesn't grow these indefinitely.
const STATS_CACHE           = createLRU(50)
const COUNTS_CACHE          = createLRU(50)
const BOOKMARK_COUNTS_CACHE = createLRU(50)
const ZAP_AGGREGATES_CACHE  = createLRU(50)
const CADENCE_CACHE         = createLRU(50)

export default function ProfileModule({ user, subtab }) {
  const { isOwner: ownerOfUrl, sessionUser } = useOwnerContext()
  const [mode, setMode] = useState('view')   // 'view' | 'edit'
  // When the URL is /:npub/profile/relays, scroll the relay section into
  // view once it's rendered. This is a shareable "check out my relays"
  // anchor — the rest of the profile stays visible above it.
  const relaysRef = useRef(null)
  const [, forceRender] = useState(0)
  // Transient banner shown on the view after a save that only landed on
  // fallback relays. Cleared on edit-entry or manual dismiss.
  const [saveNotice, setSaveNotice] = useState(null)

  // Preview overlay — local-only view of some other user's profile. Doesn't
  // change the URL or OwnerContext at the app level; we fork the context
  // below so children render in read-only mode while preview is active.
  const [previewUser, setPreviewUser] = useState(null)

  // Effective user to render. URL user by default; the preview when active.
  const viewingUser   = previewUser || user
  const viewingPubkey = viewingUser?.pubkey

  // Only treat the session as the owner when *not* previewing — even if the
  // previewed user happens to be the session user, we still hide edit
  // affordances so the preview path has one clear surface.
  const effectiveIsOwner = ownerOfUrl && !previewUser

  const [stats, setStats] = useState(() => (viewingPubkey ? STATS_CACHE.get(viewingPubkey) : null) || null)
  const [contentCounts, setContentCounts] = useState(() => (viewingPubkey ? COUNTS_CACHE.get(viewingPubkey) : null) || null)
  const [bookmarkCounts, setBookmarkCounts] = useState(() => (viewingPubkey ? BOOKMARK_COUNTS_CACHE.get(viewingPubkey) : null) || null)
  const [zapAggregates, setZapAggregates] = useState(() => (viewingPubkey ? ZAP_AGGREGATES_CACHE.get(viewingPubkey) : null) || null)
  const [cadence, setCadence] = useState(() => (viewingPubkey ? CADENCE_CACHE.get(viewingPubkey) : null) || null)
  const [loading, setLoading] = useState(!stats || !contentCounts || !bookmarkCounts)
  const [zapLoading, setZapLoading] = useState(!zapAggregates)
  const [cadenceLoading, setCadenceLoading] = useState(!cadence)

  // Scroll to relays section when URL is /:npub/profile/relays. Waits for
  // initial stats to finish so the cards above have settled heights before
  // scrolling — otherwise the target ends up above the viewport as later
  // cards lay out. A ref prevents re-firing if the user scrolls away after.
  const scrolledForSubtabRef = useRef(null)
  useEffect(() => {
    if (subtab !== 'relays') { scrolledForSubtabRef.current = null; return }
    if (loading) return
    if (scrolledForSubtabRef.current === subtab) return
    const el = relaysRef.current
    if (!el) return
    scrolledForSubtabRef.current = subtab
    // One rAF for layout, a second for paint — gives the cards above a
    // chance to finalize their height.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      })
    })
  }, [subtab, loading])
  // Bumped by PostingCadenceCard's refresh button. Forces the cadence fetch
  // effect to re-run without also re-running the stats/zaps fetches above,
  // which are on a separate useEffect. Primal's paginated kind-1 fetch
  // occasionally returns early (missing weeks), so the card needs a way
  // to refetch without a full page reload.
  const [cadenceNonce, setCadenceNonce] = useState(0)
  // Activity card (stats + zap aggregates) shares a nonce so its refresh
  // button can force a re-run of the same effect without touching cadence.
  const [activityNonce, setActivityNonce] = useState(0)

  // When the preview target changes, seed the per-user state from cache
  // immediately — otherwise we'd show the previous user's numbers for a
  // beat while the new fetch runs.
  useEffect(() => {
    if (!viewingPubkey) return
    setStats(STATS_CACHE.get(viewingPubkey) || null)
    setContentCounts(COUNTS_CACHE.get(viewingPubkey) || null)
    setBookmarkCounts(BOOKMARK_COUNTS_CACHE.get(viewingPubkey) || null)
    setZapAggregates(ZAP_AGGREGATES_CACHE.get(viewingPubkey) || null)
    setCadence(CADENCE_CACHE.get(viewingPubkey) || null)
  }, [viewingPubkey])

  useEffect(() => {
    if (!viewingPubkey) return
    let cancelled = false
    setLoading(true)
    setZapLoading(true)
    ;(async () => {
      const startedAt = Date.now()
      const [s, c, b] = await Promise.all([
        fetchAggregateUserStats(viewingPubkey),
        fetchUserContentCounts(viewingPubkey),
        fetchUserBookmarkCounts(viewingPubkey),
      ])
      if (cancelled) return
      // Minimum 500ms loading so the refresh button has perceptible
      // feedback even when Primal returned fast (matches cadence pattern).
      const elapsed = Date.now() - startedAt
      if (elapsed < 500) await new Promise(r => setTimeout(r, 500 - elapsed))
      if (cancelled) return
      if (s) { STATS_CACHE.set(viewingPubkey, s);  setStats(s) }
      if (c) { COUNTS_CACHE.set(viewingPubkey, c); setContentCounts(c) }
      if (b) { BOOKMARK_COUNTS_CACHE.set(viewingPubkey, b); setBookmarkCounts(b) }
      setLoading(false)
    })()
    // Zap aggregates run independently — they're slower (fetch up to 1k
    // zap events per direction) and we don't want them blocking the
    // faster stats/counts from rendering.
    ;(async () => {
      const startedAt = Date.now()
      const z = await fetchUserZapAggregates(viewingPubkey).catch(() => null)
      if (cancelled) return
      const elapsed = Date.now() - startedAt
      if (elapsed < 500) await new Promise(r => setTimeout(r, 500 - elapsed))
      if (cancelled) return
      // Guard: an all-zero response almost always means Primal dedupe'd a
      // concurrent REQ and gave us empty EOSE. Never let that overwrite a
      // previously good result — and never cache a truncated fetch, since
      // a later visit would pin bad data in place.
      const hasData = z && z.receivedSample > 0 && !z.truncated
      if (hasData) { ZAP_AGGREGATES_CACHE.set(viewingPubkey, z); setZapAggregates(z) }
      else if (z && z.receivedSample > 0) { setZapAggregates(z) } // show but don't cache
      setZapLoading(false)
    })()
    return () => { cancelled = true }
  }, [viewingPubkey, activityNonce])

  // Posting cadence — separate effect so the refresh button can force a
  // refetch by bumping cadenceNonce without also re-running stats/zaps.
  // Slower path (paginates up to 5 pages of kind 1 events).
  useEffect(() => {
    if (!viewingPubkey) return
    let cancelled = false
    setCadenceLoading(true)
    ;(async () => {
      const startedAt = Date.now()
      const c = await fetchAuthorPostingCadence(viewingPubkey).catch(() => null)
      if (cancelled) return
      // Keep the skeleton visible for at least 500ms so the refresh button
      // has perceptible feedback even when Primal served a deduped/cached
      // response and returned in a few dozen ms. Without this the chart
      // just re-renders the same pixels and looks like nothing happened.
      const elapsed = Date.now() - startedAt
      if (elapsed < 500) await new Promise(r => setTimeout(r, 500 - elapsed))
      if (cancelled) return
      if (c && c.buckets && c.buckets.size > 0) {
        // Show it either way so the user sees something, but only persist to
        // cache when the fetch didn't bail mid-stream — otherwise a truncated
        // run would stick around and mask real activity on later visits.
        if (!c.truncated) CADENCE_CACHE.set(viewingPubkey, c)
        setCadence(c)
      } else if (c) {
        // Zero posts in window is a valid result, but only save it if we
        // didn't already have a better cached value (same dedup-safety
        // philosophy as the zap aggregates guard above) AND the fetch
        // actually completed.
        if (!c.truncated && !CADENCE_CACHE.has(viewingPubkey)) {
          CADENCE_CACHE.set(viewingPubkey, c)
          setCadence(c)
        }
      }
      setCadenceLoading(false)
    })()
    return () => { cancelled = true }
  }, [viewingPubkey, cadenceNonce])

  const refreshActivity = useCallback(() => {
    if (!viewingPubkey) return
    // Drop the cached values for everything the Activity card consumes and
    // flip loading flags synchronously so the card's skeleton renders on the
    // same tick as the click — same pattern as refreshCadence.
    STATS_CACHE.delete(viewingPubkey)
    ZAP_AGGREGATES_CACHE.delete(viewingPubkey)
    setStats(null)
    setZapAggregates(null)
    setLoading(true)
    setZapLoading(true)
    setActivityNonce(n => n + 1)
  }, [viewingPubkey])

  const refreshCadence = useCallback(() => {
    if (!viewingPubkey) return
    // Drop the cached value and clear the in-memory chart so the card routes
    // through the skeleton branch (same visual as first open). Flip loading
    // on synchronously — the effect's own setCadenceLoading(true) only runs
    // post-render, which caused a one-frame "not loading" flash otherwise.
    CADENCE_CACHE.delete(viewingPubkey)
    setCadence(null)
    setCadenceLoading(true)
    setCadenceNonce(n => n + 1)
  }, [viewingPubkey])

  function handleSaved(content, meta) {
    // Save path only reachable for the URL-owner with no preview active;
    // mutate the app-level `user.profile` so every consumer sees the update.
    if (user) {
      user.profile = {
        ...(user.profile || {}),
        name:        content.name,
        displayName: content.display_name || content.displayName,
        image:       content.picture || content.image,
        picture:     content.picture || content.image,
        about:       content.about,
        nip05:       content.nip05,
        lud06:       content.lud06,
        lud16:       content.lud16,
        website:     content.website,
        banner:      content.banner,
      }
    }
    setSaveNotice(meta?.warning || null)
    setMode('view')
    forceRender(n => n + 1)
  }

  function handlePickAuthor(author) {
    if (!author?.pubkey) return
    // Picking yourself from search = back out of any preview, no overlay.
    if (author.pubkey === user?.pubkey) { setPreviewUser(null); return }

    // Force view mode — edit is URL-owner-only, so a preview would be stuck
    // behind it otherwise.
    setMode('view')

    // Show a minimal shell instantly using the search-result metadata so
    // the header doesn't flash empty while we fetch the full kind 0.
    const shellUser = {
      pubkey: author.pubkey,
      npub: nip19.npubEncode(author.pubkey),
      profile: {
        name: author.name,
        displayName: author.name,
        image: author.picture,
        picture: author.picture,
      },
      readOnly: true,
    }
    setPreviewUser(shellUser)

    // Background-fetch the full kind 0 and merge in banner/about/website/etc.
    // Guard against races: only apply if the preview is still this target.
    fetchProfiles([author.pubkey]).then(map => {
      const raw = map.get(author.pubkey)
      if (!raw) return
      setPreviewUser(prev => {
        if (!prev || prev.pubkey !== author.pubkey) return prev
        return {
          ...prev,
          profile: {
            name:        raw.name,
            displayName: raw.display_name || raw.displayName,
            image:       raw.picture || raw.image,
            picture:     raw.picture || raw.image,
            about:       raw.about,
            nip05:       raw.nip05,
            lud06:       raw.lud06,
            lud16:       raw.lud16,
            website:     raw.website,
            banner:      raw.banner,
          },
        }
      })
    }).catch(() => {})
  }

  function closePreview() {
    setPreviewUser(null)
  }

  if (mode === 'edit' && effectiveIsOwner) {
    return (
      <ProfileEditor
        user={user}
        onCancel={() => setMode('view')}
        onSaved={handleSaved}
      />
    )
  }

  const view = (
    <ProfileView
      user={viewingUser}
      isOwner={effectiveIsOwner}
      loggedIn={!!sessionUser}
      previewing={!!previewUser}
      onEdit={() => { setSaveNotice(null); setMode('edit') }}
      onPickAuthor={handlePickAuthor}
      onClosePreview={closePreview}
      saveNotice={saveNotice}
      onDismissSaveNotice={() => setSaveNotice(null)}
      stats={stats}
      contentCounts={contentCounts}
      bookmarkCounts={bookmarkCounts}
      zapAggregates={zapAggregates}
      zapLoading={zapLoading}
      onRefreshActivity={refreshActivity}
      cadence={cadence}
      cadenceLoading={cadenceLoading}
      onRefreshCadence={refreshCadence}
      loading={loading}
      relaysRef={relaysRef}
    />
  )

  // When previewing, fork OwnerContext so descendants (RelayCard etc.) see
  // the previewed user as the viewedUser and isOwner=false. Non-preview
  // path passes through unchanged — the app-level provider already has the
  // right values.
  if (previewUser) {
    return (
      <OwnerProvider sessionUser={sessionUser} viewedUser={previewUser}>
        {view}
      </OwnerProvider>
    )
  }
  return view
}

function ProfileView({ user, isOwner, loggedIn, previewing, onEdit, onPickAuthor, onClosePreview, saveNotice, onDismissSaveNotice, stats, contentCounts, bookmarkCounts, zapAggregates, zapLoading, onRefreshActivity, cadence, cadenceLoading, onRefreshCadence, loading, relaysRef }) {
  const profile = user?.profile || {}
  const displayName = profile.displayName || profile.name || 'Anonymous'
  const handle = profile.nip05 || (profile.name ? `@${profile.name}` : null)
  const bannerOk = profile.banner && isSafeUrl(profile.banner)
  const imageOk = profile.image && isSafeUrl(profile.image)
  const websiteOk = profile.website && isSafeUrl(profile.website)

  const [copied, setCopied] = useState(false)
  async function handleCopyNpub() {
    if (!user?.npub) return
    const ok = await copyToClipboard(user.npub)
    if (ok) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    }
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-xl mx-auto w-full px-4 py-4 space-y-4">

        {loggedIn && (
          <UserSearch
            onPickAuthor={onPickAuthor}
            placeholder="Find another user…"
          />
        )}

        {previewing && (
          <button
            type="button"
            onClick={onClosePreview}
            className="w-full flex items-center gap-2 px-3 py-2 border border-neutral-800 bg-neutral-950 hover:bg-neutral-900 rounded-lg text-xs text-neutral-300 transition-colors focus:outline-none focus:ring-1 focus:ring-purple-600"
            title="Close this profile and return to your own"
          >
            <span className="text-neutral-500">←</span>
            <span>Back to your profile</span>
            <span className="ml-auto text-[10px] text-neutral-500 truncate">
              viewing {displayName}
            </span>
          </button>
        )}

        {saveNotice && (
          <div className="flex items-start gap-2 border border-amber-900/60 bg-amber-950/30 rounded-lg px-3 py-2 text-xs text-amber-200">
            <span className="leading-5 flex-1">{saveNotice}</span>
            <button
              onClick={onDismissSaveNotice}
              title="Dismiss"
              className="text-amber-400 hover:text-amber-200 px-1 leading-5"
            >
              ✕
            </button>
          </div>
        )}

        {/* Profile card — banner + identity framed together. Additional cards
            (activity, stats, etc.) will stack below this one via the parent's
            space-y-4. */}
        <div className="border border-neutral-800 rounded-lg overflow-hidden bg-neutral-950">

        {/* Banner */}
        <div className="relative w-full h-40 bg-neutral-900">
          {bannerOk && (
            <img
              src={profile.banner}
              alt=""
              className="w-full h-full object-cover"
              onError={e => { e.target.style.display = 'none' }}
            />
          )}

          {/* Avatar overlaps the banner's bottom edge */}
          <div className="absolute -bottom-12 left-4">
            {imageOk ? (
              <img
                src={profile.image}
                alt={displayName}
                className="w-24 h-24 rounded-full object-cover bg-neutral-800 ring-4 ring-neutral-950"
                onError={e => { e.target.style.display = 'none' }}
              />
            ) : (
              <div className="w-24 h-24 rounded-full bg-neutral-800 ring-4 ring-neutral-950 flex items-center justify-center text-neutral-500 text-2xl">
                ?
              </div>
            )}
          </div>
        </div>

        {/* Identity block — padded to clear the overlapping avatar. Edit
            button sits top-right at the avatar's vertical level, mirroring
            the Twitter / Bluesky convention; Following/Followers sit right
            beneath it on the same edge so they share the cluster. */}
        <div className="relative pt-14 px-4 pb-6">
          <div className="absolute top-3 right-4 flex flex-col items-end gap-2">
            <div className="flex items-center gap-2">
              <ShareButton variant="button" />
              {isOwner && (
                <button
                  onClick={onEdit}
                  className="text-xs text-neutral-200 border border-neutral-700 hover:border-neutral-500 hover:text-neutral-100 rounded px-3 py-1.5 transition-colors"
                >
                  Edit
                </button>
              )}
            </div>
            <div className="flex items-center gap-3 text-xs text-neutral-400 whitespace-nowrap">
              <FollowStat label="Following" value={stats?.follows_count}   loading={loading && stats == null} />
              <FollowStat label="Followers" value={stats?.followers_count} loading={loading && stats == null} />
            </div>
          </div>
          <h1 className="text-xl text-neutral-100 font-semibold break-words">
            {displayName}
          </h1>
          {handle && (
            <p className="text-sm text-neutral-400 mt-0.5 break-all">{handle}</p>
          )}
          <button
            onClick={handleCopyNpub}
            title="Copy npub"
            className="mt-2 text-xs text-neutral-500 hover:text-neutral-300 font-mono inline-flex items-center gap-1.5"
          >
            <span>{truncateNpub(user?.npub || '')}</span>
            <span className="text-neutral-600">
              {copied ? '✓ copied' : '⧉'}
            </span>
          </button>

          {profile.about && (
            <p className="mt-4 text-sm text-neutral-300 whitespace-pre-wrap break-words">
              {profile.about}
            </p>
          )}

          {/* Secondary fields */}
          {(websiteOk || profile.lud16) && (
            <div className="mt-4 space-y-1.5 text-sm">
              {websiteOk && (
                <div className="flex items-center gap-2 text-neutral-400">
                  <span className="text-neutral-600 w-4 text-center">🌐</span>
                  <a
                    href={profile.website}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-purple-400 hover:text-purple-300 break-all"
                  >
                    {profile.website.replace(/^https?:\/\//, '')}
                  </a>
                </div>
              )}
              {profile.lud16 && (
                <div className="flex items-center gap-2 text-neutral-400">
                  <span className="text-neutral-600 w-4 text-center">⚡</span>
                  <span className="text-amber-400 break-all">{profile.lud16}</span>
                </div>
              )}
            </div>
          )}

          {!profile.about && !websiteOk && !profile.lud16 && !handle && (
            <p className="mt-4 text-sm text-neutral-600 italic">
              No profile info set yet.
            </p>
          )}
        </div>

        </div>

        {/* Stats card — counts pulled from Primal + relays. Notes/Articles
            cells deep-link to those modules; others are display-only until
            the Events/Marketplace modules ship. */}
        <ProfileStatsCard
          user={user}
          stats={stats}
          contentCounts={contentCounts}
          bookmarkCounts={bookmarkCounts}
          loading={loading}
        />

        <ProfileActivityCard
          stats={stats}
          zapAggregates={zapAggregates}
          loading={loading}
          zapLoading={zapLoading}
          onRefresh={onRefreshActivity}
        />

        <PostingCadenceCard
          cadence={cadence}
          loading={cadenceLoading}
          onRefresh={onRefreshCadence}
        />

        <div ref={relaysRef} className="space-y-4">
          <RelayCard pubkey={user?.pubkey} />
          <DmRelayCard pubkey={user?.pubkey} />
        </div>
      </div>
    </div>
  )
}

function FollowStat({ label, value, loading }) {
  return (
    <span className="inline-flex items-baseline gap-1">
      <span className="text-neutral-200 font-semibold">
        {loading ? (
          <span className="inline-block w-5 h-3 bg-neutral-800 rounded animate-pulse" />
        ) : (
          formatCount(value)
        )}
      </span>
      <span>{label}</span>
    </span>
  )
}
