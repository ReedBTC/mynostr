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

const REED_NPUB = 'npub1xgyjasdztryl9sg6nfdm2wcj0j3qjs03sq7a0an32pg0lr5l6yaqxhgu7s'
// Safe-decode at module load — if the npub is ever mistyped, the homepage
// still renders (pfp just won't load) instead of throwing at import time
// and breaking the entire landing page.
const REED_PUBKEY = (() => {
  try { return nip19.decode(REED_NPUB).data } catch { return null }
})()

// TODO(reed): swap placeholders for real npubs + deep-link targets.
// Each entry renders as "<Blurb> →" and links to a specific surface
// (profile, articles, bookmarks, relay list, etc.) that showcases a
// high-value part of the app. Keeping this list short (4-6 entries)
// avoids turning the homepage into a directory.
const FEATURED = [
  // { blurb: "Check out Gigi's articles",            href: '/npub1.../articles' },
  // { blurb: "See Reed's public bookmarks",          href: '/npub1.../notes/bookmarks' },
  // { blurb: "Beejay's recipe collection",           href: '/npub1.../articles/collection' },
  // { blurb: "Derek's relay list",                   href: '/npub1.../profile/relays' },
]

export default function HomeScreen({ searchInputRef, sessionUser, onLogout }) {
  const navigate = useNavigate()
  const { openLogin } = useLoginModal()

  // Reed's pfp for the footer byline. Fetched from Primal on mount so it
  // tracks any profile update without needing a redeploy. Shows nothing
  // while loading or if the fetch fails — "@Reed" still reads fine alone.
  const [reedPfp, setReedPfp] = useState(null)
  useEffect(() => {
    if (!REED_PUBKEY) return
    let cancelled = false
    fetchProfiles([REED_PUBKEY]).then(map => {
      if (cancelled) return
      const p = map?.get?.(REED_PUBKEY)
      const url = p?.picture
      if (url && isSafeUrl(url)) setReedPfp(url)
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
            autoFocus
          />
          <p className="text-[11px] text-neutral-600">
            No account needed to browse — pick any user to see their public pages.
          </p>
        </div>

        {/* ── Featured links (placeholder until Reed picks real npubs) ─ */}
        {FEATURED.length > 0 && (
          <div className="space-y-3">
            <h2 className="text-[11px] uppercase tracking-wide text-neutral-500">
              Explore MyNostr
            </h2>
            <ul className="space-y-1.5">
              {FEATURED.map((entry, i) => (
                <li key={i}>
                  <Link
                    to={entry.href}
                    className="inline-flex items-center gap-1.5 text-sm text-purple-400 hover:text-purple-300 transition-colors"
                  >
                    <span>{entry.blurb}</span>
                    <span aria-hidden>→</span>
                  </Link>
                </li>
              ))}
            </ul>
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
