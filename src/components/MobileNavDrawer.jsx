import { useNavigate } from 'react-router-dom'
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
  onReportBug,
  onKnownIssues,
  onHelp,
  onLogout,
  onLogin,
  showHelp,
  walletStatus,
  canUseWallet,
  onConnectWallet,
  onDisconnectWallet,
}) {
  const profile = user?.profile
  const navigate = useNavigate()
  const viewingOther =
    sessionUser?.pubkey && user?.pubkey && sessionUser.pubkey !== user.pubkey

  function selectModule(id) {
    onModuleChange(id)
    onClose()
  }

  // Switch from the viewed user back to the session user's profile.
  // Drawer closes so the page change is visible immediately.
  function switchToSelf() {
    if (!sessionUser?.npub) return
    navigate(`/${sessionUser.npub}/profile`)
    onClose()
  }

  // Dismiss the drawer and navigate — used by the session-pfp row.
  function goToSessionProfile() {
    if (!sessionUser?.npub) return
    navigate(`/${sessionUser.npub}/profile`)
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
        {/* Header. Three layouts mirror the desktop rail:
              - Logged in AND viewing someone else: two rows — session
                ("You") on top, viewed ("Viewing") below with an X that
                swaps back to the session user's profile.
              - Otherwise (logged out OR viewing self): single user row.
              - Public homepage (no user at all): MyNostr wordmark.
            The drawer-level close button (top-right) is separate from
            the per-row X, so the two buttons don't collide visually. */}
        <div className="flex items-start justify-between gap-2 p-4 border-b border-neutral-800">
          {viewingOther ? (
            <div className="flex flex-col gap-2 min-w-0 flex-1">
              {/* Viewed user on top (with × to dismiss), session on the
                  bottom — matches the desktop rail, and keeps the "your
                  identity" anchor in the same slot it occupies when
                  viewing your own page. */}
              <UserRow
                profile={profile}
                npub={user?.npub}
                badge="Viewing"
                onClick={() => { selectModule('profile') }}
                onClose={switchToSelf}
                closeTitle="Close and return to your profile"
              />
              <UserRow
                profile={sessionUser.profile}
                npub={sessionUser.npub}
                badge={sessionUser.readOnly ? 'Read-only' : 'You'}
                onClick={goToSessionProfile}
              />
            </div>
          ) : user ? (
            <UserRow
              profile={profile}
              npub={user?.npub}
              badge={sessionUser?.readOnly && sessionUser.pubkey === user.pubkey ? 'Read-only' : null}
            />
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
            "open this person's profile." A "Home" entry sits at the top
            of the nav as the mobile counterpart to the desktop sidebar's
            MyNostr-logo home link. */}
        <nav className="flex-1 overflow-y-auto py-2" aria-label="Module navigation">
          <button
            onClick={() => { navigate('/'); onClose() }}
            className="w-full flex items-center gap-3 px-4 py-3 text-left text-sm text-neutral-400 hover:bg-neutral-900 hover:text-neutral-100 transition-colors border-l-2 border-transparent"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 12l9-9 9 9" />
              <path d="M5 10v10a1 1 0 001 1h4v-6h4v6h4a1 1 0 001-1V10" />
            </svg>
            <span>Home</span>
          </button>
          {MODULES.map(mod => {
            const active = activeModule === mod.id
            const isProfile = mod.id === 'profile'
            // Identity pfp falls back to the session user when there's
            // no viewedUser (homepage = `user` is null) so a logged-in
            // visitor opening the drawer from / sees their own pfp
            // instead of a "?". The profile entry's onClick navigates
            // to the session user's profile in that case anyway, so
            // the icon matches the destination.
            const identityProfile = profile || sessionUser?.profile
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
                    {identityProfile?.image && isSafeUrl(identityProfile.image) ? (
                      <img
                        src={identityProfile.image}
                        alt=""
                        className="w-6 h-6 rounded-full object-cover bg-neutral-800 shrink-0"
                        onError={e => { e.target.style.display = 'none' }}
                      />
                    ) : (
                      <span className="w-6 h-6 rounded-full bg-neutral-800 flex items-center justify-center text-[10px] text-neutral-500 shrink-0">
                        ?
                      </span>
                    )}
                    <span className="truncate">Stats &amp; Relays</span>
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
          {canUseWallet && (
            walletStatus?.connected ? (
              <div className="w-full flex items-center gap-2 px-3 py-2.5 text-sm text-neutral-300">
                <span className="inline-block w-2 h-2 rounded-full bg-green-500 shrink-0" aria-hidden="true" />
                <span className="text-neutral-500 shrink-0">{walletStatus.kind === 'webln' ? 'WebLN:' : 'NWC:'}</span>
                <span className="truncate flex-1">{walletStatus.alias || 'Connected'}</span>
                <button
                  onClick={() => { onDisconnectWallet?.(); }}
                  className="text-xs text-neutral-500 hover:text-red-300 transition-colors shrink-0"
                  aria-label="Disconnect wallet"
                >
                  Disconnect
                </button>
              </div>
            ) : walletStatus?.probing ? (
              <div className="w-full flex items-center gap-2 px-3 py-2.5 text-sm text-neutral-400">
                <span className="inline-block w-2 h-2 rounded-full bg-amber-500 animate-pulse shrink-0" aria-hidden="true" />
                <span className="truncate flex-1">Checking wallet…</span>
              </div>
            ) : (
              <button
                onClick={() => { onConnectWallet?.(); onClose() }}
                className="w-full flex items-center gap-3 px-3 py-2.5 text-left text-sm text-purple-300 hover:bg-neutral-900 rounded transition-colors"
              >
                <span>⚡</span>
                <span>Connect Wallet</span>
              </button>
            )
          )}
          <button
            onClick={() => { onBoost(); onClose() }}
            className="w-full flex items-center gap-3 px-3 py-2.5 text-left text-sm text-amber-500 hover:bg-neutral-900 rounded transition-colors"
          >
            <span>⚡</span>
            <span>Boost MyNostr</span>
          </button>
          <button
            onClick={() => { onReportBug?.(); onClose() }}
            title="Apologies — alpha testing in progress"
            className="w-full flex items-center gap-3 px-3 py-2.5 text-left text-sm text-green-500 hover:bg-neutral-900 rounded transition-colors"
          >
            <span>🐛</span>
            <span>Report a Bug</span>
          </button>
          <button
            onClick={() => { onKnownIssues?.(); onClose() }}
            title="Things we already know are broken"
            className="w-full flex items-center gap-3 px-3 py-2.5 text-left text-sm text-neutral-300 hover:bg-neutral-900 rounded transition-colors"
          >
            <span>📋</span>
            <span>Known Issues</span>
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

/**
 * UserRow — pfp + name + npub (+ optional badge + optional ×) row for the
 * drawer header. Used alone for the single-user case and stacked twice
 * for the session ≠ viewed case. Main area is a real button when onClick
 * is provided so tapping the row acts as "open this profile."
 */
function UserRow({ profile, npub, badge, onClick, onClose, closeTitle }) {
  const displayName = profile?.displayName || profile?.name || 'Anonymous'
  const Content = (
    <>
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
      <div className="leading-tight min-w-0 text-left">
        <p className="text-sm text-neutral-200 truncate">{displayName}</p>
        <p className="text-xs text-neutral-600 font-mono truncate">
          {truncateNpub(npub || '')}
        </p>
        {badge && (
          <span className="inline-block mt-1 text-xs text-amber-500 border border-amber-900 rounded px-1.5 py-0.5">
            {badge}
          </span>
        )}
      </div>
    </>
  )
  return (
    <div className="flex items-center gap-3 min-w-0">
      {onClick ? (
        <button
          type="button"
          onClick={onClick}
          className="flex items-center gap-3 min-w-0 flex-1 text-left bg-transparent hover:bg-neutral-900/50 rounded -m-1 p-1 transition-colors"
        >
          {Content}
        </button>
      ) : (
        <div className="flex items-center gap-3 min-w-0 flex-1">{Content}</div>
      )}
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          title={closeTitle || 'Close'}
          aria-label={closeTitle || 'Close'}
          className="shrink-0 text-neutral-500 hover:text-neutral-200 p-1 rounded transition-colors"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="6" y1="6" x2="18" y2="18" />
            <line x1="18" y1="6" x2="6" y2="18" />
          </svg>
        </button>
      )}
    </div>
  )
}
