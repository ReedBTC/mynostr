import { useState } from 'react'
import { MODULES } from '../App.jsx'
import { truncateNpub } from '../lib/utils.js'
import { resetNDK } from '../lib/ndk.js'

/**
 * AppShell — persistent layout wrapping every module.
 * Contains the collapsible sidebar nav and the top header bar.
 * All module content is rendered in the main area via children.
 */
export default function AppShell({ user, activeModule, onModuleChange, onLogout, children }) {
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const profile = user?.profile

  function handleLogout() {
    resetNDK()
    onLogout()
  }

  return (
    <div className="flex h-screen bg-neutral-950 text-neutral-100 font-mono overflow-hidden">

      {/* ── Sidebar ─────────────────────────────────────────────── */}
      <aside
        className={`flex flex-col border-r border-neutral-800 bg-neutral-950 transition-all duration-200 ${
          sidebarOpen ? 'w-52' : 'w-14'
        }`}
      >
        {/* Logo / collapse toggle */}
        <div className="flex items-center justify-between px-3 py-4 border-b border-neutral-800">
          {sidebarOpen && (
            <span className="text-sm font-semibold text-neutral-100 tracking-tight">MyNostr</span>
          )}
          <button
            onClick={() => setSidebarOpen(v => !v)}
            className="text-neutral-500 hover:text-neutral-300 transition-colors ml-auto"
            aria-label={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
          >
            {sidebarOpen ? '◀' : '▶'}
          </button>
        </div>

        {/* Module nav */}
        <nav className="flex-1 overflow-y-auto py-2 space-y-0.5">
          {MODULES.map(mod => (
            <NavItem
              key={mod.id}
              mod={mod}
              active={activeModule === mod.id}
              collapsed={!sidebarOpen}
              onClick={() => onModuleChange(mod.id)}
            />
          ))}
        </nav>

        {/* User info at bottom */}
        <div className="border-t border-neutral-800 p-3">
          {sidebarOpen ? (
            <div className="flex items-center gap-2">
              <UserAvatar profile={profile} size={6} />
              <div className="min-w-0 flex-1">
                <p className="text-xs text-neutral-200 truncate">
                  {profile?.displayName || profile?.name || 'Anonymous'}
                </p>
                <p className="text-xs text-neutral-600 truncate font-mono">
                  {truncateNpub(user?.npub || '')}
                </p>
              </div>
              <button
                onClick={handleLogout}
                className="text-xs text-neutral-600 hover:text-neutral-400 transition-colors ml-auto shrink-0"
                aria-label="Logout"
              >
                ↩
              </button>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2">
              <UserAvatar profile={profile} size={6} />
              <button
                onClick={handleLogout}
                className="text-xs text-neutral-600 hover:text-neutral-400 transition-colors"
                aria-label="Logout"
              >
                ↩
              </button>
            </div>
          )}
        </div>
      </aside>

      {/* ── Main content area ───────────────────────────────────── */}
      <div className="flex flex-col flex-1 overflow-hidden">
        {/* Top bar */}
        <header className="flex items-center justify-between px-5 py-3 border-b border-neutral-800 bg-neutral-950 shrink-0">
          <div>
            <h1 className="text-sm font-medium text-neutral-100">
              {MODULES.find(m => m.id === activeModule)?.label}
            </h1>
            <p className="text-xs text-neutral-600">
              {MODULES.find(m => m.id === activeModule)?.description}
            </p>
          </div>
          {user?.readOnly && (
            <span className="text-xs text-amber-500 border border-amber-900 rounded px-2 py-0.5">
              Read-only
            </span>
          )}
        </header>

        {/* Module content */}
        <main className="flex-1 overflow-hidden flex flex-col">
          {children}
        </main>
      </div>
    </div>
  )
}

/** Single sidebar nav item */
function NavItem({ mod, active, collapsed, onClick }) {
  return (
    <button
      onClick={onClick}
      title={collapsed ? `${mod.label} — ${mod.description}` : undefined}
      className={`w-full flex items-center gap-3 px-3 py-2 text-left transition-colors text-sm ${
        active
          ? 'bg-purple-900/40 text-purple-300 border-r-2 border-purple-500'
          : 'text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800/60'
      } ${mod.status === 'soon' ? 'opacity-60' : ''}`}
      aria-current={active ? 'page' : undefined}
    >
      <span className="text-base shrink-0">{mod.icon}</span>
      {!collapsed && (
        <span className="truncate">
          {mod.label}
          {mod.status === 'soon' && (
            <span className="ml-1.5 text-xs text-neutral-700">soon</span>
          )}
        </span>
      )}
    </button>
  )
}

/** User avatar or placeholder */
function UserAvatar({ profile, size = 8 }) {
  const cls = `w-${size} h-${size} rounded-full object-cover bg-neutral-800`
  if (profile?.image) {
    return (
      <img
        src={profile.image}
        alt={profile.displayName || 'avatar'}
        className={cls}
        onError={e => { e.target.style.display = 'none' }}
      />
    )
  }
  return (
    <div className={`${cls} flex items-center justify-center text-neutral-500 text-xs`}>
      ?
    </div>
  )
}
