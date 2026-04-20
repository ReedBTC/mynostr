import { useState, useEffect } from 'react'
import { copyToClipboard, isSafeUrl, truncateNpub, formatCount, createLRU } from '../../lib/utils.js'
import { useOwnerContext } from '../../lib/ownerContext.jsx'
import { fetchAggregateUserStats } from '../../lib/userStats.js'
import { fetchUserContentCounts } from '../../lib/userContentCounts.js'
import { fetchUserBookmarkCounts } from '../../lib/userBookmarkCounts.js'
import { fetchUserZapAggregates, fetchAuthorPostingCadence } from '../../lib/primal.js'
import ProfileEditor from './ProfileEditor.jsx'
import ProfileStatsCard from './ProfileStatsCard.jsx'
import ProfileActivityCard from './ProfileActivityCard.jsx'
import PostingCadenceCard from './PostingCadenceCard.jsx'

/**
 * ProfileModule — read view of the viewed user's kind 0 profile, plus an
 * Edit toggle for the owner that swaps in ProfileEditor. After a successful
 * publish we overlay the new content onto the session user's profile
 * object (mutating in place so every other consumer that holds the same
 * reference sees the fresh data) and bump a render counter to repaint.
 *
 * Stats (note/reply/follower counts from Primal) and content counts
 * (articles/events/listings from relays) are fetched once at the module
 * level and passed down — the profile card renders follower/following
 * inline, the stats card renders the rest.
 */

// Module-level caches so switching tabs away and back doesn't re-hammer
// the network for rarely-changing aggregate counts. Bounded LRU so viewing
// many profiles in one session doesn't grow these indefinitely.
const STATS_CACHE           = createLRU(50)
const COUNTS_CACHE          = createLRU(50)
const BOOKMARK_COUNTS_CACHE = createLRU(50)
const ZAP_AGGREGATES_CACHE  = createLRU(50)
const CADENCE_CACHE         = createLRU(50)

export default function ProfileModule({ user }) {
  const { isOwner } = useOwnerContext()
  const [mode, setMode] = useState('view')   // 'view' | 'edit'
  const [, forceRender] = useState(0)
  // Transient banner shown on the view after a save that only landed on
  // fallback relays. Cleared on edit-entry or manual dismiss.
  const [saveNotice, setSaveNotice] = useState(null)

  const pubkey = user?.pubkey

  const [stats, setStats] = useState(() => (pubkey ? STATS_CACHE.get(pubkey) : null) || null)
  const [contentCounts, setContentCounts] = useState(() => (pubkey ? COUNTS_CACHE.get(pubkey) : null) || null)
  const [bookmarkCounts, setBookmarkCounts] = useState(() => (pubkey ? BOOKMARK_COUNTS_CACHE.get(pubkey) : null) || null)
  const [zapAggregates, setZapAggregates] = useState(() => (pubkey ? ZAP_AGGREGATES_CACHE.get(pubkey) : null) || null)
  const [cadence, setCadence] = useState(() => (pubkey ? CADENCE_CACHE.get(pubkey) : null) || null)
  const [loading, setLoading] = useState(!stats || !contentCounts || !bookmarkCounts)
  const [zapLoading, setZapLoading] = useState(!zapAggregates)
  const [cadenceLoading, setCadenceLoading] = useState(!cadence)

  useEffect(() => {
    if (!pubkey) return
    let cancelled = false
    setLoading(true)
    setZapLoading(true)
    setCadenceLoading(true)
    ;(async () => {
      const [s, c, b] = await Promise.all([
        fetchAggregateUserStats(pubkey),
        fetchUserContentCounts(pubkey),
        fetchUserBookmarkCounts(pubkey),
      ])
      if (cancelled) return
      if (s) { STATS_CACHE.set(pubkey, s);  setStats(s) }
      if (c) { COUNTS_CACHE.set(pubkey, c); setContentCounts(c) }
      if (b) { BOOKMARK_COUNTS_CACHE.set(pubkey, b); setBookmarkCounts(b) }
      setLoading(false)
    })()
    // Zap aggregates run independently — they're slower (fetch up to 1k
    // zap events per direction) and we don't want them blocking the
    // faster stats/counts from rendering.
    ;(async () => {
      const z = await fetchUserZapAggregates(pubkey).catch(() => null)
      if (cancelled) return
      // Guard: an all-zero response almost always means Primal dedupe'd a
      // concurrent REQ and gave us empty EOSE. Never let that overwrite a
      // previously good result (either in memory or in cache).
      const hasData = z && z.receivedSample > 0
      if (hasData) { ZAP_AGGREGATES_CACHE.set(pubkey, z); setZapAggregates(z) }
      setZapLoading(false)
    })()
    // Posting cadence — also slower (paginates up to 5 pages of kind 1
    // events). Runs independently from stats/zaps for the same reason.
    ;(async () => {
      const c = await fetchAuthorPostingCadence(pubkey).catch(() => null)
      if (cancelled) return
      if (c && c.buckets && c.buckets.size > 0) {
        CADENCE_CACHE.set(pubkey, c)
        setCadence(c)
      } else if (c) {
        // Zero posts in window is a valid result, but only save it if we
        // didn't already have a better cached value (same dedup-safety
        // philosophy as the zap aggregates guard above).
        if (!CADENCE_CACHE.has(pubkey)) {
          CADENCE_CACHE.set(pubkey, c)
          setCadence(c)
        }
      }
      setCadenceLoading(false)
    })()
    return () => { cancelled = true }
  }, [pubkey])

  function handleSaved(content, meta) {
    // content is the raw NIP-01 kind 0 content JSON we just published.
    // Normalize into our in-memory camelCase shape and merge over the
    // existing profile so downstream readers see the update.
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

  if (mode === 'edit' && isOwner) {
    return (
      <ProfileEditor
        user={user}
        onCancel={() => setMode('view')}
        onSaved={handleSaved}
      />
    )
  }

  return (
    <ProfileView
      user={user}
      isOwner={isOwner}
      onEdit={() => { setSaveNotice(null); setMode('edit') }}
      saveNotice={saveNotice}
      onDismissSaveNotice={() => setSaveNotice(null)}
      stats={stats}
      contentCounts={contentCounts}
      bookmarkCounts={bookmarkCounts}
      zapAggregates={zapAggregates}
      zapLoading={zapLoading}
      cadence={cadence}
      cadenceLoading={cadenceLoading}
      loading={loading}
    />
  )
}

function ProfileView({ user, isOwner, onEdit, saveNotice, onDismissSaveNotice, stats, contentCounts, bookmarkCounts, zapAggregates, zapLoading, cadence, cadenceLoading, loading }) {
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
            {isOwner && (
              <button
                onClick={onEdit}
                className="text-xs text-neutral-200 border border-neutral-700 hover:border-neutral-500 hover:text-neutral-100 rounded px-3 py-1.5 transition-colors"
              >
                Edit
              </button>
            )}
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
        />

        <PostingCadenceCard
          cadence={cadence}
          loading={cadenceLoading}
        />
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

