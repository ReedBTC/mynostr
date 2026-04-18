import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { MODULES } from '../App.jsx'
import { truncateNpub, isSafeUrl } from '../lib/utils.js'
import { resetNDK } from '../lib/ndk.js'
import { useIsMobile } from '../hooks/useIsMobile.js'
import { useOwnerContext } from '../lib/ownerContext.jsx'
import BoostModal from './BoostModal.jsx'
import HelpModal from '../modules/longform/components/HelpModal.jsx'
import MobileNavDrawer from './MobileNavDrawer.jsx'
import ShareButton from './ShareButton.jsx'

/**
 * AppShell — persistent layout wrapping every module.
 * Desktop: logo · scrollable module tabs · (share) avatar + boost/help/login-or-logout.
 * Mobile: hamburger + active module label + avatar; nav lives in a slide-in drawer.
 *
 * `user` here is the *viewed* user (whose page is on screen). Session identity
 * (used for gating editor UI) comes from OwnerContext.
 */
export default function AppShell({ user, sessionUser, activeModule, onModuleChange, onLogout, children }) {
  const isMobile = useIsMobile()
  const navigate = useNavigate()
  const { isOwner, isReadOnly } = useOwnerContext()
  const [boostOpen, setBoostOpen]   = useState(false)
  const [helpOpen,  setHelpOpen]    = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const profile = user?.profile
  const activeMod = MODULES.find(m => m.id === activeModule)

  function handleLogout() {
    resetNDK()
    onLogout()
  }

  function handleLoginClick() {
    // Pass the current page as "from" so LoginRoute can bring an owner
    // straight back to it instead of bouncing to the default module.
    const from = user?.npub ? `/${user.npub}/${activeModule}` : null
    navigate('/login', from ? { state: { from } } : undefined)
  }

  // Visitor badge — shown whenever the user isn't editing their own page.
  // Covers logged-out visitors, signed-in users viewing someone else, and
  // read-only (npub-login) sessions on their own page.
  const viewerBadgeText = isReadOnly
    ? (sessionUser ? (sessionUser.pubkey === user?.pubkey ? 'Read-only' : 'Viewing') : 'Viewing')
    : null

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
            {sessionUser ? (
              <button
                onClick={handleLogout}
                aria-label="Logout"
                className="text-[10px] text-neutral-400 hover:text-neutral-100 border border-neutral-700 hover:border-neutral-500 rounded px-1.5 py-0.5 transition-colors"
              >
                Logout
              </button>
            ) : (
              <button
                onClick={handleLoginClick}
                aria-label="Login"
                className="text-[10px] text-purple-300 hover:text-purple-100 border border-purple-800 hover:border-purple-600 rounded px-1.5 py-0.5 transition-colors"
              >
                Login
              </button>
            )}
            <ShareButton variant="icon" />
            <UserAvatar profile={profile} />
          </div>
        </header>
      ) : (
        /* ── Desktop top bar ───────────────────────────────────── */
        <header className="flex items-center gap-2 border-b border-neutral-800 bg-neutral-950 shrink-0 px-3">

          {/* Logo — always links home */}
          <Link to="/" aria-label="MyNostr home" className="shrink-0 mr-1">
            <img src="/mynostr.png" alt="MyNostr" className="h-7" />
          </Link>

          {/* Boost MyNostr — anchored next to the logo so it reads as a
              tip-the-site action rather than tipping the viewed author. */}
          <button
            onClick={() => setBoostOpen(true)}
            className="shrink-0 flex items-center gap-1.5 text-xs text-amber-500 hover:text-amber-300 transition-colors px-2 py-1 rounded border border-amber-900 hover:border-amber-700"
            aria-label="Boost MyNostr"
          >
            <img src="/mynostr.png" alt="" className="h-4 w-4" aria-hidden="true" />
            <span>Boost MyNostr</span>
          </button>

          {/* Help — lives on the left next to Boost so it's grouped with the
              site-level actions, not per-user controls. Only shown for modules
              that currently have a help modal (longform). */}
          {activeModule === 'longform' && (
            <button
              onClick={() => setHelpOpen(true)}
              className="shrink-0 text-xs text-neutral-600 hover:text-neutral-300 transition-colors px-2 py-1 rounded border border-neutral-800 hover:border-neutral-600 mr-2"
              aria-label="Help"
            >
              ?
            </button>
          )}

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

          {/* Right: viewer badge · share · avatar · login/logout */}
          <div className="flex items-center gap-2 shrink-0 pl-2">
            {viewerBadgeText && (
              <span className="text-xs text-amber-500 border border-amber-900 rounded px-2 py-0.5">
                {viewerBadgeText}
              </span>
            )}

            <ShareButton variant="button" />

            <UserAvatar profile={profile} />

            <div className="leading-tight hidden sm:block">
              <p className="text-xs text-neutral-300">
                {profile?.displayName || profile?.name || 'Anonymous'}
              </p>
              <p className="text-xs text-neutral-600 font-mono">
                {truncateNpub(user?.npub || '')}
              </p>
            </div>

            {sessionUser ? (
              <button
                onClick={handleLogout}
                className="text-xs text-neutral-600 hover:text-neutral-300 transition-colors px-2 py-1 rounded border border-neutral-800 hover:border-neutral-600"
                aria-label="Logout"
              >
                Logout
              </button>
            ) : (
              <button
                onClick={handleLoginClick}
                className="text-xs text-purple-400 hover:text-purple-300 transition-colors px-2 py-1 rounded border border-purple-900 hover:border-purple-700"
                aria-label="Login"
              >
                Login
              </button>
            )}
          </div>
        </header>
      )}

      {isMobile && (
        <MobileNavDrawer
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          user={user}
          sessionUser={sessionUser}
          activeModule={activeModule}
          onModuleChange={onModuleChange}
          onBoost={() => setBoostOpen(true)}
          onHelp={() => setHelpOpen(true)}
          onLogout={handleLogout}
          onLogin={handleLoginClick}
          showHelp={activeModule === 'longform'}
        />
      )}

      {/* BoostModal uses `user` for the "boost as" identity — that's the session
          user, not whoever's page we're on. */}
      {boostOpen && <BoostModal user={sessionUser} onClose={() => setBoostOpen(false)} readOnly={!isOwner} />}
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
