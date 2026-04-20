import { useState, lazy, Suspense, useEffect } from 'react'
import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  Link,
  useParams,
  useNavigate,
  useLocation,
} from 'react-router-dom'
import LoginScreen from './components/LoginScreen.jsx'
import AppShell from './components/AppShell.jsx'
import {
  OwnerProvider,
  decodeNpubParam,
  useViewedUser,
  clearViewedUserCache,
} from './lib/ownerContext.jsx'
import { connectAndWait, getNDK } from './lib/ndk.js'
import { loadSession, clearSession, restoreSession } from './lib/sessionPersistence.js'

// Lazy-load each module so only the active tab's code is fetched
const LongformModule    = lazy(() => import('./modules/longform/LongformModule.jsx'))
const NotesModule       = lazy(() => import('./modules/notes/NotesModule.jsx'))
const EventsModule      = lazy(() => import('./modules/events/EventsModule.jsx'))
const MarketplaceModule = lazy(() => import('./modules/marketplace/MarketplaceModule.jsx'))
const StatsModule       = lazy(() => import('./modules/stats/StatsModule.jsx'))

/** All modules in display order. id must match the lazy import above. */
export const MODULES = [
  { id: 'notes',       label: 'Notes',       icon: '📝', status: 'live', description: 'Kind 1 short notes' },
  { id: 'longform',    label: 'Long Form',   icon: '✍️', status: 'live', description: 'Kind 30023 articles' },
  { id: 'events',      label: 'Events',      icon: '📅', status: 'soon', description: 'Kind 31923 events' },
  { id: 'marketplace', label: 'Marketplace', icon: '🛒', status: 'soon', description: 'Kind 30402 listings' },
  { id: 'stats',       label: 'Stats',       icon: '📊', status: 'soon', description: 'Your Nostr analytics' },
]

const MODULE_COMPONENTS = {
  notes:       NotesModule,
  longform:    LongformModule,
  events:      EventsModule,
  marketplace: MarketplaceModule,
  stats:       StatsModule,
}

const DEFAULT_MODULE = 'notes'

export default function App() {
  const [sessionUser, setSessionUser] = useState(null)
  // `restoring` covers the async auto-resume on boot. Render a spinner during
  // it rather than flashing the login screen — otherwise a signed-in user
  // sees LoginScreen for 100–3000ms before auto-login completes.
  //
  // Skip restore when the URL is /login: a user who hits that route is
  // explicitly asking to switch accounts; blocking them behind a spinner
  // until a possibly-stale bunker connection resolves is hostile.
  const [restoring, setRestoring] = useState(() => {
    if (typeof window !== 'undefined' && window.location?.pathname === '/login') return false
    return !!loadSession()
  })

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
    // Purge every mynostr_* localStorage entry that the departing session
    // touched. Two categories:
    //   (a) session-scoped keys ending in the session pubkey (drafts, etc.)
    //   (b) browsing-residue keys keyed by the *viewed* user's pubkey
    //       (mynostr_last_author_*, mynostr_last_article_*,
    //        mynostr_reading_lists:*) — these reveal what pages the session
    //       visited and are cleared regardless of which pubkey is embedded.
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
      <Routes>
        <Route
          path="/login"
          element={<LoginRoute sessionUser={sessionUser} onLogin={setSessionUser} />}
        />
        <Route
          path="/"
          element={<RootRoute sessionUser={sessionUser} />}
        />
        <Route
          path="/:npub"
          element={<NpubRootRoute />}
        />
        <Route
          path="/:npub/:module"
          element={
            <ModuleRoute sessionUser={sessionUser} onLogout={handleLogout} />
          }
        />
        <Route path="*" element={<NotFoundRoute />} />
      </Routes>
    </BrowserRouter>
  )
}

// ── Route components ─────────────────────────────────────────────────────────

function RootRoute({ sessionUser }) {
  if (sessionUser?.npub) {
    return <Navigate to={`/${sessionUser.npub}`} replace />
  }
  return <Navigate to="/login" replace />
}

function LoginRoute({ sessionUser, onLogin }) {
  const navigate = useNavigate()
  const location = useLocation()
  const from = location.state?.from || null

  // Navigate away from /login once a session exists. Runs both on mount
  // (already-logged-in user hit /login) and when setSessionUser fires from
  // LoginScreen — we rely on the render triggered by the state change rather
  // than calling navigate() synchronously inside the login handler, so
  // LoginScreen's async flows can unwind cleanly before unmount.
  useEffect(() => {
    if (!sessionUser?.npub) return
    let dest = `/${sessionUser.npub}`
    if (from) {
      const fromNpub = from.split('/').filter(Boolean)[0]
      if (fromNpub === sessionUser.npub) dest = from
    }
    navigate(dest, { replace: true })
  }, [sessionUser, from, navigate])

  return <LoginScreen onLogin={onLogin} />
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
  const { npub, module: moduleId } = useParams()
  const navigate = useNavigate()
  const { viewedUser, loading } = useViewedUser(npub, sessionUser)

  // Kick off relay connections early so modules that hit NDK don't stall.
  // Safe to call repeatedly — connectAndWait is a fast no-op when connected.
  useEffect(() => {
    connectAndWait(getNDK()).catch(() => {})
  }, [])

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

  function handleModuleChange(id) {
    navigate(`/${npub}/${id}`)
  }

  function handleLogoutAndLeave() {
    onLogout()
    navigate('/login', { replace: true })
  }

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
          <ActiveComponent user={viewedUser} sessionUser={sessionUser} />
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
