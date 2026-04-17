import { useState } from 'react'
import { MODULES } from '../App.jsx'
import { truncateNpub, isSafeUrl } from '../lib/utils.js'
import { resetNDK } from '../lib/ndk.js'
import { useIsMobile } from '../hooks/useIsMobile.js'
import BoostModal from './BoostModal.jsx'
import HelpModal from '../modules/longform/components/HelpModal.jsx'
import MobileNavDrawer from './MobileNavDrawer.jsx'

/**
 * AppShell — persistent layout wrapping every module.
 * Desktop: logo · scrollable module tabs · user avatar + boost/help/logout.
 * Mobile: hamburger + active module label + avatar; nav lives in a slide-in drawer.
 * Full viewport below the bar is handed to the active module.
 */
export default function AppShell({ user, activeModule, onModuleChange, onLogout, children }) {
  const isMobile = useIsMobile()
  const [boostOpen, setBoostOpen]   = useState(false)
  const [helpOpen,  setHelpOpen]    = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const profile = user?.profile
  const activeMod = MODULES.find(m => m.id === activeModule)

  function handleLogout() {
    resetNDK()
    onLogout()
  }

  return (
    <div className="flex flex-col h-screen bg-neutral-950 text-neutral-100 font-mono overflow-hidden">

      {isMobile ? (
        /* ── Mobile top bar ────────────────────────────────────── */
        <header className="flex items-center justify-between gap-2 border-b border-neutral-800 bg-neutral-950 shrink-0 px-3 py-2">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <button
              onClick={() => setDrawerOpen(true)}
              className="text-neutral-300 hover:text-neutral-100 p-1.5 -ml-1 shrink-0"
              aria-label="Open menu"
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="3" y1="6" x2="21" y2="6" />
                <line x1="3" y1="12" x2="21" y2="12" />
                <line x1="3" y1="18" x2="21" y2="18" />
              </svg>
            </button>
            <span className="text-sm text-neutral-200 truncate flex items-center gap-1.5">
              <span>{activeMod?.icon}</span>
              <span>{activeMod?.label}</span>
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {user?.readOnly && (
              <span className="text-[10px] text-amber-500 border border-amber-900 rounded px-1.5 py-0.5">
                RO
              </span>
            )}
            <UserAvatar profile={profile} />
          </div>
        </header>
      ) : (
        /* ── Desktop top bar ───────────────────────────────────── */
        <header className="flex items-center gap-2 border-b border-neutral-800 bg-neutral-950 shrink-0 px-3">

          {/* Logo */}
          <img
            src="/mynostr.png"
            alt="MyNostr"
            className="h-7 shrink-0 mr-1"
          />

          {/* Module tabs — horizontally scrollable so nothing wraps or truncates */}
          <nav
            className="flex items-end flex-1 overflow-x-auto gap-0 scrollbar-none min-w-0"
            aria-label="Module navigation"
          >
            {MODULES.map(mod => (
              <Tab
                key={mod.id}
                mod={mod}
                active={activeModule === mod.id}
                onClick={() => onModuleChange(mod.id)}
              />
            ))}
          </nav>

          {/* Right: read-only badge · avatar · boost · logout */}
          <div className="flex items-center gap-2 shrink-0 pl-2">
            {user?.readOnly && (
              <span className="text-xs text-amber-500 border border-amber-900 rounded px-2 py-0.5">
                Read-only
              </span>
            )}

            <UserAvatar profile={profile} />

            <div className="leading-tight hidden sm:block">
              <p className="text-xs text-neutral-300">
                {profile?.displayName || profile?.name || 'Anonymous'}
              </p>
              <p className="text-xs text-neutral-600 font-mono">
                {truncateNpub(user?.npub || '')}
              </p>
            </div>

            <button
              onClick={() => setBoostOpen(true)}
              className="text-xs text-amber-600 hover:text-amber-400 transition-colors px-2 py-1 rounded border border-amber-900 hover:border-amber-700"
              aria-label="Boost MyNostr"
            >
              ⚡ Boost
            </button>

            {activeModule === 'longform' && (
              <button
                onClick={() => setHelpOpen(true)}
                className="text-xs text-neutral-600 hover:text-neutral-300 transition-colors px-2 py-1 rounded border border-neutral-800 hover:border-neutral-600"
                aria-label="Help"
              >
                ?
              </button>
            )}

            <button
              onClick={handleLogout}
              className="text-xs text-neutral-600 hover:text-neutral-300 transition-colors px-2 py-1 rounded border border-neutral-800 hover:border-neutral-600"
              aria-label="Logout"
            >
              Logout
            </button>
          </div>
        </header>
      )}

      {isMobile && (
        <MobileNavDrawer
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          user={user}
          activeModule={activeModule}
          onModuleChange={onModuleChange}
          onBoost={() => setBoostOpen(true)}
          onHelp={() => setHelpOpen(true)}
          onLogout={handleLogout}
          showHelp={activeModule === 'longform'}
        />
      )}

      {boostOpen && <BoostModal user={user} onClose={() => setBoostOpen(false)} readOnly={!!user?.readOnly} />}
      {helpOpen  && <HelpModal onClose={() => setHelpOpen(false)} />}

      {/* ── Module content ──────────────────────────────────────── */}
      <main className="flex-1 overflow-hidden flex flex-col">
        {children}
      </main>
    </div>
  )
}

/** Single tab button — active tab has a bottom border highlight, no bottom border on the bar */
function Tab({ mod, active, onClick }) {
  return (
    <button
      onClick={onClick}
      title={mod.description}
      aria-current={active ? 'page' : undefined}
      className={`flex items-center gap-1.5 px-3 py-3 text-xs whitespace-nowrap border-b-2 transition-colors ${
        active
          ? 'border-purple-500 text-purple-300'
          : 'border-transparent text-neutral-500 hover:text-neutral-200 hover:border-neutral-600'
      } ${mod.status === 'soon' ? 'opacity-50' : ''}`}
    >
      <span>{mod.icon}</span>
      <span>{mod.label}</span>
    </button>
  )
}

/** User avatar circle */
function UserAvatar({ profile }) {
  if (profile?.image && isSafeUrl(profile.image)) {
    return (
      <img
        src={profile.image}
        alt={profile.displayName || 'avatar'}
        className="w-6 h-6 rounded-full object-cover bg-neutral-800 shrink-0"
        onError={e => { e.target.style.display = 'none' }}
      />
    )
  }
  return (
    <div className="w-6 h-6 rounded-full bg-neutral-800 flex items-center justify-center text-neutral-500 text-xs shrink-0">
      ?
    </div>
  )
}
