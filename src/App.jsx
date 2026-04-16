import { useState, lazy, Suspense } from 'react'
import LoginScreen from './components/LoginScreen.jsx'
import AppShell from './components/AppShell.jsx'

// Lazy-load each module so only the active tab's code is fetched
const LongformModule   = lazy(() => import('./modules/longform/LongformModule.jsx'))
const NotesModule      = lazy(() => import('./modules/notes/NotesModule.jsx'))
const EventsModule     = lazy(() => import('./modules/events/EventsModule.jsx'))
const MarketplaceModule = lazy(() => import('./modules/marketplace/MarketplaceModule.jsx'))
const StatsModule      = lazy(() => import('./modules/stats/StatsModule.jsx'))

/** All modules in display order. id must match the lazy import above. */
export const MODULES = [
  { id: 'notes',        label: 'Notes',        icon: '📝',  status: 'live',    description: 'Kind 1 short notes' },
  { id: 'longform',     label: 'Long Form',    icon: '✍️',  status: 'live',    description: 'Kind 30023 articles' },
  { id: 'events',       label: 'Events',       icon: '📅',  status: 'soon',    description: 'Kind 31923 events' },
  { id: 'marketplace',  label: 'Marketplace',  icon: '🛒',  status: 'soon',    description: 'Kind 30402 listings' },
  { id: 'stats',        label: 'Stats',        icon: '📊',  status: 'soon',    description: 'Your Nostr analytics' },
]

/** Map module id → lazy component */
const MODULE_COMPONENTS = {
  longform:    LongformModule,
  notes:       NotesModule,
  events:      EventsModule,
  marketplace: MarketplaceModule,
  stats:       StatsModule,
}

export default function App() {
  const [user, setUser]           = useState(null)
  const [activeModule, setActiveModule] = useState('notes')

  function handleLogout() {
    // Clear any persisted drafts before losing the pubkey reference
    if (user?.pubkey) {
      try { localStorage.removeItem(`mynostr_draft_${user.pubkey}`) } catch {}
    }
    setUser(null)
    setActiveModule('notes')
  }

  if (!user) {
    return <LoginScreen onLogin={setUser} />
  }

  const ActiveComponent = MODULE_COMPONENTS[activeModule]

  return (
    <AppShell
      user={user}
      activeModule={activeModule}
      onModuleChange={setActiveModule}
      onLogout={handleLogout}
    >
      <Suspense fallback={<ModuleLoader />}>
        <ActiveComponent user={user} />
      </Suspense>
    </AppShell>
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
