import { MODULES } from '../App.jsx'
import { truncateNpub, isSafeUrl } from '../lib/utils.js'

/**
 * Mobile-only slide-in navigation drawer.
 * Always mounted (on mobile) so `open`/`close` transitions animate both directions;
 * pointer-events disabled when closed so it doesn't capture taps.
 */
export default function MobileNavDrawer({
  open,
  onClose,
  user,
  sessionUser,
  activeModule,
  onModuleChange,
  onBoost,
  onHelp,
  onLogout,
  onLogin,
  showHelp,
}) {
  const profile = user?.profile

  function selectModule(id) {
    onModuleChange(id)
    onClose()
  }

  return (
    <div
      className={`fixed inset-0 z-50 ${open ? '' : 'pointer-events-none'}`}
      aria-hidden={!open}
    >
      {/* Backdrop */}
      <div
        onClick={onClose}
        className={`absolute inset-0 bg-black/60 transition-opacity duration-200 ${open ? 'opacity-100' : 'opacity-0'}`}
      />

      {/* Drawer */}
      <aside
        className={`absolute left-0 top-0 bottom-0 w-72 max-w-[85vw] bg-neutral-950 border-r border-neutral-800 transition-transform duration-200 flex flex-col ${open ? 'translate-x-0' : '-translate-x-full'}`}
        role="dialog"
        aria-label="Navigation menu"
      >
        {/* Header. On the public homepage (no viewed user) we show the
            MyNostr wordmark instead of a person, so the drawer doesn't
            confuse visitors with an "Anonymous" row. */}
        <div className="flex items-start justify-between gap-2 p-4 border-b border-neutral-800">
          {user ? (
            <div className="flex items-center gap-3 min-w-0">
              {profile?.image && isSafeUrl(profile.image) ? (
                <img
                  src={profile.image}
                  alt=""
                  className="w-10 h-10 rounded-full object-cover bg-neutral-800 shrink-0"
                  onError={e => { e.target.style.display = 'none' }}
                />
              ) : (
                <div className="w-10 h-10 rounded-full bg-neutral-800 flex items-center justify-center text-neutral-500 text-xs shrink-0">
                  ?
                </div>
              )}
              <div className="leading-tight min-w-0">
                <p className="text-sm text-neutral-200 truncate">
                  {profile?.displayName || profile?.name || 'Anonymous'}
                </p>
                <p className="text-xs text-neutral-600 font-mono truncate">
                  {truncateNpub(user?.npub || '')}
                </p>
                {sessionUser && sessionUser.pubkey !== user?.pubkey && (
                  <span className="inline-block mt-1 text-xs text-amber-500 border border-amber-900 rounded px-1.5 py-0.5">
                    Viewing
                  </span>
                )}
                {sessionUser && sessionUser.pubkey === user?.pubkey && sessionUser.readOnly && (
                  <span className="inline-block mt-1 text-xs text-amber-500 border border-amber-900 rounded px-1.5 py-0.5">
                    Read-only
                  </span>
                )}
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-3 min-w-0">
              <p className="text-sm text-neutral-200 truncate font-semibold">MyNostr</p>
            </div>
          )}
          <button
            onClick={onClose}
            className="text-neutral-500 hover:text-neutral-200 text-2xl leading-none px-2 shrink-0"
            aria-label="Close menu"
          >
            ×
          </button>
        </div>

        {/* Module list — the `profile` row renders the viewed user's pfp +
            display name in place of the generic icon/label so it reads as
            "open this person's profile." */}
        <nav className="flex-1 overflow-y-auto py-2" aria-label="Module navigation">
          {MODULES.map(mod => {
            const active = activeModule === mod.id
            const isProfile = mod.id === 'profile'
            const displayName = profile?.displayName || profile?.name || 'Profile'
            return (
              <button
                key={mod.id}
                onClick={() => selectModule(mod.id)}
                className={`w-full flex items-center gap-3 px-4 py-3 text-left text-sm transition-colors border-l-2 ${
                  active
                    ? 'bg-neutral-900 text-purple-300 border-purple-500'
                    : 'text-neutral-400 hover:bg-neutral-900 hover:text-neutral-100 border-transparent'
                } ${mod.status === 'soon' ? 'opacity-50' : ''}`}
                aria-current={active ? 'page' : undefined}
              >
                {isProfile ? (
                  <>
                    {profile?.image && isSafeUrl(profile.image) ? (
                      <img
                        src={profile.image}
                        alt=""
                        className="w-6 h-6 rounded-full object-cover bg-neutral-800 shrink-0"
                        onError={e => { e.target.style.display = 'none' }}
                      />
                    ) : (
                      <span className="w-6 h-6 rounded-full bg-neutral-800 flex items-center justify-center text-[10px] text-neutral-500 shrink-0">
                        ?
                      </span>
                    )}
                    <span className="truncate">{displayName}</span>
                  </>
                ) : (
                  <>
                    <span className="text-base">{mod.icon}</span>
                    <span>{mod.label}</span>
                  </>
                )}
                {mod.status === 'soon' && (
                  <span className="ml-auto text-xs text-neutral-600">soon</span>
                )}
              </button>
            )
          })}
        </nav>

        {/* Bottom actions */}
        <div className="border-t border-neutral-800 p-2 space-y-1">
          <button
            onClick={() => { onBoost(); onClose() }}
            className="w-full flex items-center gap-3 px-3 py-2.5 text-left text-sm text-amber-500 hover:bg-neutral-900 rounded transition-colors"
          >
            <span>⚡</span>
            <span>Boost MyNostr</span>
          </button>
          {showHelp && (
            <button
              onClick={() => { onHelp(); onClose() }}
              className="w-full flex items-center gap-3 px-3 py-2.5 text-left text-sm text-neutral-400 hover:bg-neutral-900 rounded transition-colors"
            >
              <span>?</span>
              <span>Help</span>
            </button>
          )}
          {sessionUser ? (
            <button
              onClick={() => { onLogout(); onClose() }}
              className="w-full flex items-center gap-3 px-3 py-2.5 text-left text-sm text-neutral-400 hover:bg-neutral-900 rounded transition-colors"
            >
              <span>↩</span>
              <span>Logout</span>
            </button>
          ) : (
            <button
              onClick={() => { onLogin?.(); onClose() }}
              className="w-full flex items-center gap-3 px-3 py-2.5 text-left text-sm text-purple-300 hover:bg-neutral-900 rounded transition-colors"
            >
              <span>→</span>
              <span>Login</span>
            </button>
          )}
        </div>
      </aside>
    </div>
  )
}
