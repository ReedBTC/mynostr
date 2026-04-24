import { useState, lazy, Suspense, useEffect, useRef, useCallback } from 'react'
import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  Link,
  useParams,
  useNavigate,
} from 'react-router-dom'
import AppShell from './components/AppShell.jsx'
import HomeScreen from './components/HomeScreen.jsx'
import { LoginModalProvider } from './components/LoginModalContext.jsx'
import {
  OwnerProvider,
  decodeNpubParam,
  useViewedUser,
  clearViewedUserCache,
} from './lib/ownerContext.jsx'
import { connectAndWait, getNDK, resetNDK } from './lib/ndk.js'
import { loadSession, clearSession, restoreSession } from './lib/sessionPersistence.js'

// Lazy-load each module so only the active tab's code is fetched
const ProfileModule     = lazy(() => import('./modules/profile/ProfileModule.jsx'))
const ArticlesModule    = lazy(() => import('./modules/articles/ArticlesModule.jsx'))
const NotesModule       = lazy(() => import('./modules/notes/NotesModule.jsx'))
const EventsModule      = lazy(() => import('./modules/events/EventsModule.jsx'))
const MarketplaceModule = lazy(() => import('./modules/marketplace/MarketplaceModule.jsx'))

/** All modules in display order. id must match the lazy import above.
 *  The `profile` tab renders specially in the top bar — its label slot is
 *  swapped for the viewed user's pfp + display name, so `icon`/`label` here
 *  are only fallbacks used by code paths that don't special-case it. */
export const MODULES = [
  { id: 'profile',     label: 'Profile',     icon: '👤', status: 'live', description: 'Kind 0 profile' },
  { id: 'notes',       label: 'Notes',       icon: '📝', status: 'live', description: 'Kind 1 short notes' },
  { id: 'articles',    label: 'Articles',    icon: '✍️', status: 'live', description: 'Kind 30023 articles' },
  { id: 'events',      label: 'Events',      icon: '📅', status: 'soon', description: 'Kind 31923 events' },
  { id: 'marketplace', label: 'Marketplace', icon: '🛒', status: 'soon', description: 'Kind 30402 listings' },
]

const MODULE_COMPONENTS = {
  profile:     ProfileModule,
  notes:       NotesModule,
  articles:    ArticlesModule,
  events:      EventsModule,
  marketplace: MarketplaceModule,
}

const DEFAULT_MODULE = 'notes'

// Modules with a Write surface that owners should land on when they click
// the sidebar nav — mirrors the old pre-URL-routing default. Visitors
// (and owners clicking into someone else's page) get the bare feed URL
// so the deep link is shareable and doesn't flash the composer.
const MODULES_WITH_WRITE = new Set(['notes', 'articles'])

export default function App() {
  const [sessionUser, setSessionUser] = useState(null)
  // `restoring` covers the async auto-resume on boot. Render a spinner during
  // it rather than flashing the homepage — otherwise a signed-in user might
  // see the landing page for 100–3000ms before auto-login completes.
  const [restoring, setRestoring] = useState(() => !!loadSession())

  useEffect(() => {
    if (!restoring) return
    let cancelled = false
    ;(async () => {
      const record = loadSession()
      if (!record) { if (!cancelled) setRestoring(false); return }
      try {
        const user = await restoreSession(record)
        if (cancelled) return
        if (user) setSessionUser(user)
        else clearSession()
      } catch {
        if (!cancelled) clearSession()
      } finally {
        if (!cancelled) setRestoring(false)
      }
    })()
    return () => { cancelled = true }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  function handleLogout() {
    // Centralized logout — called from every surface (sidebar, mobile
    // drawer, homepage). Tears down NDK signer state first so no
    // post-logout fetches run under the departing identity, then purges
    // localStorage residue, then clears session state.
    //
    // Purge every mynostr_* localStorage entry that the departing session
    // touched. Two categories:
    //   (a) session-scoped keys ending in the session pubkey (drafts, etc.)
    //   (b) browsing-residue keys keyed by the *viewed* user's pubkey
    //       (mynostr_last_author_*, mynostr_last_article_*,
    //        mynostr_reading_lists:*) — these reveal what pages the session
    //       visited and are cleared regardless of which pubkey is embedded.
    resetNDK()
    const pk = sessionUser?.pubkey
    try {
      const suffix      = pk ? `_${pk}` : null
      const colonSuffix = pk ? `:${pk}` : null
      const toRemove = []
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)
        if (!key || !key.startsWith('mynostr_')) continue
        if (
          key.startsWith('mynostr_last_author_')  ||
          key.startsWith('mynostr_last_article_') ||
          key.startsWith('mynostr_reading_lists:')
        ) { toRemove.push(key); continue }
        if (pk && (key.endsWith(suffix) || key.endsWith(colonSuffix))) toRemove.push(key)
      }
      for (const key of toRemove) localStorage.removeItem(key)
    } catch {}
    clearSession()
    clearViewedUserCache()
    setSessionUser(null)
  }

  if (restoring) return <FullscreenSpinner />

  return (
    <BrowserRouter>
      <LoginModalProvider onLogin={setSessionUser}>
        <Routes>
          {/* Legacy /login URL — modal replaces the dedicated route. Old
              bookmarks land on the homepage; from there the Login button
              opens the modal. */}
          <Route path="/login" element={<Navigate to="/" replace />} />
          <Route
            path="/"
            element={<RootRoute sessionUser={sessionUser} onLogout={handleLogout} />}
          />
          <Route
            path="/:npub"
            element={<NpubRootRoute />}
          />
          {/* Legacy /longform → /articles. Covers both /:npub/longform and
              /:npub/longform/<subtab> so old bookmarked URLs keep working. */}
          <Route path="/:npub/longform" element={<LongformLegacyRedirect />} />
          <Route path="/:npub/longform/:subtab" element={<LongformLegacyRedirect />} />
          <Route
            path="/:npub/:module"
            element={
              <ModuleRoute sessionUser={sessionUser} onLogout={handleLogout} />
            }
          />
          <Route
            path="/:npub/:module/:subtab"
            element={
              <ModuleRoute sessionUser={sessionUser} onLogout={handleLogout} />
            }
          />
          <Route path="*" element={<NotFoundRoute />} />
        </Routes>
      </LoginModalProvider>
    </BrowserRouter>
  )
}

function LongformLegacyRedirect() {
  const { npub, subtab } = useParams()
  const dest = subtab ? `/${npub}/articles/${subtab}` : `/${npub}/articles`
  return <Navigate to={dest} replace />
}

// ── Route components ─────────────────────────────────────────────────────────

function RootRoute({ sessionUser, onLogout }) {
  // `/` always renders the homepage — logged-in users should be able to
  // view it too (e.g. clicking the logo to return here). The pfp tab in
  // the sidebar gives them a one-click path back to their own page.
  return <HomeRoute sessionUser={sessionUser} onLogout={onLogout} />
}

function HomeRoute({ sessionUser, onLogout }) {
  const searchInputRef = useRef(null)
  const navigate = useNavigate()

  // Sidebar module click handler. Two behaviors based on login state:
  //   - Logged out: focus the search input. There's no npub to navigate
  //     under, so visitors have to pick a user first.
  //   - Logged in: navigate into the corresponding module on the session
  //     user's own page. Mirrors the handleModuleChange logic in
  //     ModuleRoute so notes/articles land on the Write surface (the
  //     owner's default for those modules).
  // The pfp tab (ProfileIdentityTab) skips this handler entirely and
  // navigates straight to /:npub/profile — see AppShell.
  const handleModuleClick = useCallback((id) => {
    if (!sessionUser?.npub) {
      searchInputRef.current?.focus()
      return
    }
    const npub = sessionUser.npub
    if (MODULES_WITH_WRITE.has(id)) {
      navigate(`/${npub}/${id}/write`)
      return
    }
    navigate(`/${npub}/${id}`)
  }, [sessionUser?.npub, navigate])

  return (
    <AppShell
      user={null}
      sessionUser={sessionUser}
      activeModule={null}
      onModuleChange={handleModuleClick}
      onLogout={onLogout}
    >
      <HomeScreen
        searchInputRef={searchInputRef}
        sessionUser={sessionUser}
        onLogout={onLogout}
      />
    </AppShell>
  )
}

// /:npub resolves to the user's landing page. Until the Profile module exists,
// we redirect to the default module. When Profile ships, this route will
// render ProfileModule directly.
function NpubRootRoute() {
  const { npub } = useParams()
  if (!decodeNpubParam(npub)) return <InvalidNpubScreen />
  return <Navigate to={`/${npub}/${DEFAULT_MODULE}`} replace />
}

function ModuleRoute({ sessionUser, onLogout }) {
  const { npub, module: moduleId, subtab } = useParams()
  const navigate = useNavigate()
  const { viewedUser, loading } = useViewedUser(npub, sessionUser)

  // Kick off relay connections early so modules that hit NDK don't stall.
  // Safe to call repeatedly — connectAndWait is a fast no-op when connected.
  useEffect(() => {
    connectAndWait(getNDK()).catch(() => {})
  }, [])

  // Hooks must run before any early returns below, otherwise the second
  // render (once viewedUser resolves) calls more hooks than the first
  // (spinner) render and React throws. Neither callback depends on
  // viewedUser so it's safe to derive them up here.
  const viewingOwnPage = sessionUser?.npub && sessionUser.npub === npub

  const handleModuleChange = useCallback((id) => {
    if (viewingOwnPage && MODULES_WITH_WRITE.has(id)) {
      navigate(`/${npub}/${id}/write`)
      return
    }
    navigate(`/${npub}/${id}`)
  }, [viewingOwnPage, npub, navigate])

  const handleLogoutAndLeave = useCallback(() => {
    onLogout()
    // Land on the homepage after logout — staying on the current page
    // would leave the user viewing an owner-gated URL they no longer
    // have permission for, and there's no /login page to fall back to.
    navigate('/', { replace: true })
  }, [onLogout, navigate])

  // Invalid npub in URL.
  if (!decodeNpubParam(npub)) return <InvalidNpubScreen />

  // Unknown module — bounce to the default on that npub.
  if (!MODULE_COMPONENTS[moduleId]) {
    return <Navigate to={`/${npub}/${DEFAULT_MODULE}`} replace />
  }

  // Still resolving the viewed user's profile — show a spinner rather than
  // flashing an empty shell.
  if (loading && !viewedUser) return <FullscreenSpinner />
  if (!viewedUser) return <FullscreenSpinner />

  const ActiveComponent = MODULE_COMPONENTS[moduleId]

  return (
    <OwnerProvider sessionUser={sessionUser} viewedUser={viewedUser}>
      <AppShell
        user={viewedUser}
        sessionUser={sessionUser}
        activeModule={moduleId}
        onModuleChange={handleModuleChange}
        onLogout={handleLogoutAndLeave}
      >
        <Suspense fallback={<ModuleLoader />}>
          <ActiveComponent user={viewedUser} sessionUser={sessionUser} subtab={subtab} />
        </Suspense>
      </AppShell>
    </OwnerProvider>
  )
}

function NotFoundRoute() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-neutral-950 text-neutral-400 p-6 font-mono">
      <p className="text-lg mb-2">Page not found</p>
      <Link to="/" className="text-purple-400 hover:text-purple-300 text-sm">Go home</Link>
    </div>
  )
}

function InvalidNpubScreen() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-neutral-950 text-neutral-400 p-6 font-mono">
      <p className="text-lg mb-2">Invalid npub</p>
      <p className="text-sm text-neutral-500 mb-4 text-center max-w-md">
        That URL doesn't look like a valid Nostr public key.
      </p>
      <Link to="/" className="text-purple-400 hover:text-purple-300 text-sm">Go home</Link>
    </div>
  )
}

function FullscreenSpinner() {
  return (
    <div className="flex items-center justify-center min-h-screen bg-neutral-950">
      <div className="w-8 h-8 border-2 border-purple-600 border-t-transparent rounded-full animate-spin" />
    </div>
  )
}

/** Simple centered spinner shown while a module chunk loads */
function ModuleLoader() {
  return (
    <div className="flex items-center justify-center flex-1 h-full">
      <div className="w-6 h-6 border-2 border-purple-600 border-t-transparent rounded-full animate-spin" />
    </div>
  )
}
