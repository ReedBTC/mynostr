import { useState, lazy, Suspense } from 'react'
import LoginScreen from './components/LoginScreen.jsx'
import AppShell from './components/AppShell.jsx'

// Lazy-load each module so only the active tab's code is fetched
const LongformModule   = lazy(() => import('./modules/longform/LongformModule.jsx'))
const RecipesModule    = lazy(() => import('./modules/recipes/RecipesModule.jsx'))
const NotesModule      = lazy(() => import('./modules/notes/NotesModule.jsx'))
const EventsModule     = lazy(() => import('./modules/events/EventsModule.jsx'))
const ProfileModule    = lazy(() => import('./modules/profile/ProfileModule.jsx'))
const MarketplaceModule = lazy(() => import('./modules/marketplace/MarketplaceModule.jsx'))
const BrowseModule     = lazy(() => import('./modules/browse/BrowseModule.jsx'))
const SearchModule     = lazy(() => import('./modules/search/SearchModule.jsx'))
const StatsModule      = lazy(() => import('./modules/stats/StatsModule.jsx'))
const WotModule        = lazy(() => import('./modules/wot/WotModule.jsx'))

/** All modules in display order. id must match the lazy import above. */
export const MODULES = [
  { id: 'longform',     label: 'Long Form',    icon: '✍️',  status: 'live',    description: 'Kind 30023 articles' },
  { id: 'recipes',      label: 'Recipes',      icon: '🍳',  status: 'soon',    description: 'Kind 30023 · #recipe' },
  { id: 'notes',        label: 'Notes',        icon: '📝',  status: 'soon',    description: 'Kind 1 short notes' },
  { id: 'events',       label: 'Events',       icon: '📅',  status: 'soon',    description: 'Kind 31923 events' },
  { id: 'profile',      label: 'Profile',      icon: '👤',  status: 'soon',    description: 'Kind 0 profile editor' },
  { id: 'marketplace',  label: 'Marketplace',  icon: '🛒',  status: 'soon',    description: 'Kind 30402 listings' },
  { id: 'browse',       label: 'Browse',       icon: '🗂️',  status: 'soon',    description: 'Curated note kinds' },
  { id: 'search',       label: 'Search',       icon: '🔍',  status: 'soon',    description: 'Full-text search' },
  { id: 'stats',        label: 'Stats',        icon: '📊',  status: 'soon',    description: 'Your Nostr analytics' },
  { id: 'wot',          label: 'Web of Trust', icon: '🌐',  status: 'soon',    description: 'WoT score & graph' },
]

/** Map module id → lazy component */
const MODULE_COMPONENTS = {
  longform:    LongformModule,
  recipes:     RecipesModule,
  notes:       NotesModule,
  events:      EventsModule,
  profile:     ProfileModule,
  marketplace: MarketplaceModule,
  browse:      BrowseModule,
  search:      SearchModule,
  stats:       StatsModule,
  wot:         WotModule,
}

export default function App() {
  const [user, setUser]           = useState(null)
  const [activeModule, setActiveModule] = useState('longform')

  function handleLogout() {
    setUser(null)
    setActiveModule('longform')
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
