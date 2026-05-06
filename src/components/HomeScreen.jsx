/**
 * HomeScreen — public landing page at `/` for logged-out visitors.
 *
 * The pitch of MyNostr is "your Nostr profile is your web page," so the
 * root domain can't be a login wall. This page explains what MyNostr is,
 * lets anyone search for a user to view their public pages without an
 * account, and surfaces a handful of example profiles that show off the
 * app's shareable deep links.
 *
 * Rendered inside AppShell (with no `user` / `sessionUser`). The sidebar
 * tabs are wired by HomeRoute to focus this page's search input instead
 * of navigating — a user can't visit /notes, /articles, etc. without
 * first picking an npub.
 */
import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { nip19 } from 'nostr-tools'
import UserSearch from './UserSearch.jsx'
import { fetchProfiles } from '../lib/primal.js'
import { isSafeUrl } from '../lib/utils.js'
import { useLoginModal } from './LoginModalContext.jsx'
import { useIsMobile } from '../hooks/useIsMobile.js'
import BookmarkIcon from './BookmarkIcon.jsx'

const REED_NPUB = 'npub1xgyjasdztryl9sg6nfdm2wcj0j3qjs03sq7a0an32pg0lr5l6yaqxhgu7s'
// Safe-decode at module load — if the npub is ever mistyped, the homepage
// still renders (pfp just won't load) instead of throwing at import time
// and breaking the entire landing page.
const REED_PUBKEY = (() => {
  try { return nip19.decode(REED_NPUB).data } catch { return null }
})()

// Hand-picked deep links that showcase different surfaces of mynostr.
// Each card wears a personal title ("Gigi's Articles", "Seth's Recipes",
// etc.) so visitors see real people on real surfaces rather than
// abstract module names. Ordering follows a variety arc: reading →
// buying → cooking → meeting → curating → configuring.
//
// Most cards use an emoji as the surface icon; utxo's bookmarks card
// uses the in-app BookmarkIcon SVG so it visually matches the
// bookmark ribbon used on every Save / Saved button across the app.
const FEATURED = [
  {
    npub:  'npub1dergggklka99wwrs92yz8wdjs952h2ux2ha2ed598ngwu9w7a6fsh9xzpc',
    href:  '/npub1dergggklka99wwrs92yz8wdjs952h2ux2ha2ed598ngwu9w7a6fsh9xzpc/articles',
    title: "Gigi's Articles",
    blurb: 'Long-form Bitcoin writing',
    icon:  '✍️',
  },
  {
    npub:  'npub1xgyjasdztryl9sg6nfdm2wcj0j3qjs03sq7a0an32pg0lr5l6yaqxhgu7s',
    href:  '/npub1xgyjasdztryl9sg6nfdm2wcj0j3qjs03sq7a0an32pg0lr5l6yaqxhgu7s/marketplace',
    title: "Reed's Marketplace",
    blurb: 'Things for sale on Nostr',
    icon:  '🛒',
  },
  {
    npub:  'npub15u3cqhx6vuj3rywg0ph5mfv009lxja6cyvqn2jagaydukq6zmjwqex05rq',
    href:  '/npub15u3cqhx6vuj3rywg0ph5mfv009lxja6cyvqn2jagaydukq6zmjwqex05rq/articles?type=recipes',
    title: "Seth's Recipes",
    blurb: 'Recipes on Nostr',
    icon:  '🍳',
  },
  {
    npub:  'npub1ynn5qnnc95qaqjejrtyazfdgutlxvme3djywe6s9wg76k68s37sqsl2qfd',
    href:  '/npub1ynn5qnnc95qaqjejrtyazfdgutlxvme3djywe6s9wg76k68s37sqsl2qfd/events',
    title: 'Western Mass Bitcoin Meetup',
    blurb: 'Local meetups + events',
    icon:  '📅',
  },
  {
    npub:     'npub1utx00neqgqln72j22kej3ux7803c2k986henvvha4thuwfkper4s7r50e8',
    href:     '/npub1utx00neqgqln72j22kej3ux7803c2k986henvvha4thuwfkper4s7r50e8/notes/bookmarks',
    title:    "utxo's Public Bookmarks",
    blurb:    'Curated bookmark lists',
    iconType: 'bookmark',
  },
  {
    npub:  'npub1xtscya34g58tk0z605fvr788k263gsu6cy9x0mhnm87echrgufzsevkk5s',
    href:  '/npub1xtscya34g58tk0z605fvr788k263gsu6cy9x0mhnm87echrgufzsevkk5s/profile/relays',
    title: "jb55's Relays",
    blurb: 'Shareable relay lists',
    icon:  '📡',
  },
]

// Pre-decode FEATURED npubs to hex pubkeys at module load — same safety
// pattern as REED_PUBKEY above. Profile fetch happens once on mount.
const FEATURED_PUBKEYS = FEATURED.map(f => {
  try { return nip19.decode(f.npub).data } catch { return null }
}).filter(Boolean)

export default function HomeScreen({ searchInputRef, sessionUser, onLogout }) {
  const navigate = useNavigate()
  const { openLogin } = useLoginModal()
  // Skip autoFocus on mobile so the OS keyboard doesn't pop up the
  // moment the homepage loads — pleasant on desktop, intrusive on phones.
  const isMobile = useIsMobile()

  // Reed's pfp for the footer byline. Fetched from Primal on mount so it
  // tracks any profile update without needing a redeploy. Shows nothing
  // while loading or if the fetch fails — "@Reed" still reads fine alone.
  const [reedPfp, setReedPfp] = useState(null)
  // Featured-card profiles: { hexPubkey → { picture, displayName } }.
  // One Primal call covers all six. Pfps + display-name override the
  // hard-coded ownerLabel when available, so cards feel like real
  // user introductions rather than generic links.
  const [featuredProfiles, setFeaturedProfiles] = useState({})
  useEffect(() => {
    let cancelled = false
    const targets = [REED_PUBKEY, ...FEATURED_PUBKEYS].filter(Boolean)
    fetchProfiles(targets).then(map => {
      if (cancelled || !map) return
      // Reed's footer pfp
      const reed = map.get?.(REED_PUBKEY)
      if (reed?.picture && isSafeUrl(reed.picture)) setReedPfp(reed.picture)
      // Featured cards
      const next = {}
      for (const pk of FEATURED_PUBKEYS) {
        const p = map.get?.(pk)
        if (!p) continue
        next[pk] = {
          picture:     (p.picture && isSafeUrl(p.picture)) ? p.picture : null,
          displayName: p.display_name || p.displayName || p.name || null,
        }
      }
      setFeaturedProfiles(next)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [])

  function handlePickAuthor({ pubkey }) {
    try {
      const npub = nip19.npubEncode(pubkey)
      navigate(`/${npub}/profile`)
    } catch {}
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-xl mx-auto px-4 py-8 sm:py-12 space-y-10">

        {/* ── Pitch ────────────────────────────────────────────────── */}
        <div className="flex flex-col items-center text-center">
          <img src="/mynostr.png" alt="MyNostr" className="w-full mb-4" />
          <h1 className="text-base sm:text-lg text-neutral-200 font-medium max-w-md">
            Built for creators and curators
          </h1>
          <p className="text-sm text-neutral-400 max-w-md mt-2">
            Save note templates. Write and export longform articles.
            Curate public collections. Organize private bookmarks.
          </p>
        </div>

        {/* ── User search ──────────────────────────────────────────── */}
        <div className="space-y-2">
          <label className="block text-[11px] uppercase tracking-wide text-neutral-500">
            Find someone on MyNostr
          </label>
          <UserSearch
            inputRef={searchInputRef}
            onPickAuthor={handlePickAuthor}
            placeholder="Search by name, npub, or nprofile…"
            autoFocus={!isMobile}
          />
          <p className="text-[11px] text-neutral-600">
            No account needed to browse — pick any user to see their public pages.
          </p>
        </div>

        {/* ── Showcase grid: real users on real surfaces ───────────────
             Each card wears its own category label so a visitor sees
             the spread of what mynostr can be — Articles, Marketplace,
             Recipes, Events, Bookmarks, Relays — without the homepage
             having to lecture about modules. */}
        {FEATURED.length > 0 && (
          <div className="space-y-3">
            <div className="space-y-1">
              <h2 className="text-[11px] uppercase tracking-wide text-neutral-500">
                Take a tour
              </h2>
              <p className="text-[11px] text-neutral-600">
                A handful of real Nostr accounts — different surfaces, different vibes.
              </p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              {FEATURED.map((entry, i) => {
                const pk = (() => {
                  try { return nip19.decode(entry.npub).data } catch { return null }
                })()
                const profile = pk ? featuredProfiles[pk] : null
                const pfp = profile?.picture
                const surfaceIcon = entry.iconType === 'bookmark'
                  ? <BookmarkIcon filled size={14} className="text-blue-400" />
                  : <span className="text-base leading-none" aria-hidden>{entry.icon}</span>
                return (
                  <Link
                    key={i}
                    to={entry.href}
                    className="group block rounded-lg border border-neutral-800 hover:border-purple-700/80 bg-neutral-900/40 hover:bg-neutral-900 px-3 py-2.5 transition-colors"
                  >
                    <div className="flex items-center gap-2.5">
                      {pfp ? (
                        <img
                          src={pfp}
                          alt=""
                          className="w-9 h-9 rounded-full object-cover bg-neutral-800 shrink-0"
                          referrerPolicy="no-referrer"
                          onError={e => { e.target.style.display = 'none' }}
                        />
                      ) : (
                        <div className="w-9 h-9 rounded-full bg-neutral-800 shrink-0" aria-hidden />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start gap-1.5">
                          <span className="text-[13px] leading-snug text-neutral-200 flex-1">{entry.title}</span>
                          <span className="shrink-0 inline-flex items-center mt-0.5">{surfaceIcon}</span>
                          <span
                            className="text-neutral-700 group-hover:text-purple-400 transition-colors shrink-0 mt-0.5"
                            aria-hidden
                          >→</span>
                        </div>
                        <div className="text-[11px] text-neutral-500 leading-snug mt-0.5 truncate">
                          {entry.blurb}
                        </div>
                      </div>
                    </div>
                  </Link>
                )
              })}
            </div>
            {!sessionUser && (
              <p className="text-center text-[11px] text-neutral-500 pt-1">
                <button
                  type="button"
                  onClick={openLogin}
                  className="text-purple-400 hover:text-purple-300 transition-colors"
                >
                  Log in
                </button>
                {' '}to create and manage your notes and events
              </p>
            )}
          </div>
        )}

        {/* ── Session CTA ──────────────────────────────────────────── */}
        <div className="border-t border-neutral-800 pt-6">
          <div className="flex flex-wrap items-center gap-2">
            {sessionUser ? (
              <button
                type="button"
                onClick={onLogout}
                className="text-xs text-neutral-400 hover:text-neutral-200 border border-neutral-800 hover:border-neutral-600 rounded px-3 py-1.5 transition-colors"
              >
                Log out
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={openLogin}
                  className="text-xs text-purple-300 hover:text-purple-100 border border-purple-800 hover:border-purple-600 rounded px-3 py-1.5 transition-colors"
                >
                  Log in
                </button>
                <span className="text-[11px] text-neutral-600">
                  Extension, nsec, bunker, or generate a new key.
                </span>
              </>
            )}
          </div>
        </div>

        {/* ── Footer ───────────────────────────────────────────────── */}
        <footer className="border-t border-neutral-800 pt-6 text-[11px] text-neutral-600 space-y-2">
          <div>
            <a
              href="https://github.com/ReedBTC/mynostr"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-neutral-400 transition-colors"
            >
              GitHub
            </a>
          </div>
          <div className="flex items-center justify-center gap-1.5">
            <span>Made with 💜 by</span>
            {reedPfp && (
              <img
                src={reedPfp}
                alt=""
                className="w-4 h-4 rounded-full object-cover bg-neutral-800"
                onError={e => { e.target.style.display = 'none' }}
              />
            )}
            <Link
              to={`/${REED_NPUB}/profile`}
              className="text-purple-400 hover:text-purple-300 transition-colors"
            >
              @Reed
            </Link>
          </div>
        </footer>

      </div>
    </div>
  )
}
