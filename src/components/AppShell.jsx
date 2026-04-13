import { useState } from 'react'
import { MODULES } from '../App.jsx'
import { truncateNpub } from '../lib/utils.js'
import { resetNDK } from '../lib/ndk.js'
import BoostModal from './BoostModal.jsx'

/**
 * AppShell — persistent layout wrapping every module.
 * Top tab bar: logo · scrollable module tabs · user avatar + logout.
 * Full viewport below the bar is handed to the active module.
 */
export default function AppShell({ user, activeModule, onModuleChange, onLogout, children }) {
  const [boostOpen, setBoostOpen] = useState(false)
  const profile = user?.profile

  function handleLogout() {
    resetNDK()
    onLogout()
  }

  return (
    <div className="flex flex-col h-screen bg-neutral-950 text-neutral-100 font-mono overflow-hidden">

      {/* ── Top bar ─────────────────────────────────────────────── */}
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
            aria-label="Send a lightning boost to support MyNostr"
          >
            ⚡
          </button>

          <button
            onClick={handleLogout}
            className="text-xs text-neutral-600 hover:text-neutral-300 transition-colors px-2 py-1 rounded border border-neutral-800 hover:border-neutral-600"
            aria-label="Logout"
          >
            Logout
          </button>
        </div>
      </header>

      {boostOpen && <BoostModal user={user} onClose={() => setBoostOpen(false)} readOnly={!!user?.readOnly} />}

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
  if (profile?.image) {
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
