import { useState, useEffect } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { MODULES } from '../App.jsx'
import { isSafeUrl } from '../lib/utils.js'
import { resetNDK, getLastOutboxWarning, clearLastOutboxWarning, OUTBOX_WARNING_EVENT } from '../lib/ndk.js'
import { useIsMobile } from '../hooks/useIsMobile.js'
import { useOwnerContext } from '../lib/ownerContext.jsx'
import BoostModal from './BoostModal.jsx'
import HelpModal from '../modules/articles/components/HelpModal.jsx'
import MobileNavDrawer from './MobileNavDrawer.jsx'
import ShareButton from './ShareButton.jsx'

/**
 * AppShell — persistent layout wrapping every module.
 * Desktop: vertical sidebar on the left (logo/boost at top · module tabs in
 *   the middle · viewer badge + profile + share + login-or-logout at bottom)
 *   with the module content filling the rest of the viewport.
 * Mobile: hamburger + active module label + avatar; nav lives in a slide-in
 *   drawer. Unchanged from before — the vertical rail is desktop-only.
 *
 * `user` here is the *viewed* user (whose page is on screen). Session identity
 * (used for gating editor UI) comes from OwnerContext.
 */
export default function AppShell({ user, sessionUser, activeModule, onModuleChange, onLogout, children }) {
  const isMobile = useIsMobile()
  const navigate = useNavigate()
  const { subtab } = useParams()
  const { isOwner, isReadOnly } = useOwnerContext()
  const [boostOpen, setBoostOpen]   = useState(false)
  const [helpOpen,  setHelpOpen]    = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const profile = user?.profile
  const activeMod = MODULES.find(m => m.id === activeModule)
  // Write + Search surfaces aren't publicly shareable — Write has no URL
  // worth sharing; Search is owner-only and redirects visitors out.
  const shareable = subtab !== 'write' && subtab !== 'search'

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
  // read-only (npub-login) sessions on their own page. Skipped on the
  // public homepage (no viewed user → nothing to badge against).
  const viewerBadgeText = user && isReadOnly
    ? (sessionUser ? (sessionUser.pubkey === user?.pubkey ? 'Read-only' : 'Viewing') : 'Viewing')
    : null

  return (
    <div className="flex h-screen bg-neutral-950 text-neutral-100 font-mono overflow-hidden">

      {/* ── Desktop sidebar (vertical rail) ─────────────────────────── */}
      {!isMobile && (
        <aside className="w-60 shrink-0 flex flex-col border-r border-neutral-800 bg-neutral-950">

          {/* Top: brand + Boost. The logo fills the full rail width and acts
              as the home link; no separate wordmark. Help for articles is on
              the module itself, not here. */}
          <div className="shrink-0 px-3 pt-3 pb-3 flex flex-col gap-2 border-b border-neutral-800">
            <Link to="/" aria-label="MyNostr home" className="block">
              <img src="/mynostr.png" alt="MyNostr" className="w-full h-auto" />
            </Link>
            <button
              onClick={() => setBoostOpen(true)}
              className="text-xs text-amber-500 hover:text-amber-300 transition-colors px-2 py-1.5 rounded border border-amber-900 hover:border-amber-700"
              aria-label="Boost MyNostr"
            >
              Boost MyNostr
            </button>
          </div>

          {/* Middle: module tabs. "Stats & Relays" is a sidebar alias for the
              profile module — some users look for relay/stats under a
              dedicated heading; both this entry and the identity footer
              route to /profile. */}
          <nav
            className="flex-1 overflow-y-auto py-2 px-2 flex flex-col gap-0.5"
            aria-label="Module navigation"
          >
            <SideTab
              mod={{ id: 'profile', label: 'Stats & Relays', icon: '📊', description: 'Profile stats and relays', status: 'live' }}
              active={activeModule === 'profile'}
              onClick={() => onModuleChange('profile')}
            />
            {MODULES.filter(m => m.id !== 'profile').map(mod => (
              <SideTab
                key={mod.id}
                mod={mod}
                active={activeModule === mod.id}
                onClick={() => onModuleChange(mod.id)}
              />
            ))}
          </nav>

          {/* Bottom: user identity + session actions. Share lives on each
              module's own header now — not globally on the shell. Order is
              viewer-badge → session action (Login/Logout) → profile identity
              so the account-level controls cluster above the pfp row. When
              logged out the Login button sits next to the "Viewing" badge. */}
          <div className="shrink-0 border-t border-neutral-800 px-3 py-3 flex flex-col gap-2">
            <div className="flex items-center gap-2 flex-wrap">
              {viewerBadgeText && (
                <span className="text-[11px] text-amber-500 border border-amber-900 rounded px-2 py-0.5">
                  {viewerBadgeText}
                </span>
              )}
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
            {/* The pfp tab shows the VIEWED user's profile on module pages.
                On the homepage there's no viewed user — fall back to the
                session user's profile (if logged in) so they have a
                one-click path back to their own page. The click handler
                navigates directly rather than going through
                onModuleChange, so this works even on the homepage where
                that handler focuses the search input. */}
            {(user || sessionUser) && (
              <ProfileIdentityTab
                profile={(user || sessionUser)?.profile}
                active={activeModule === 'profile'}
                onClick={() => {
                  const target = user?.npub || sessionUser?.npub
                  if (target) navigate(`/${target}/profile`)
                }}
              />
            )}
          </div>
        </aside>
      )}

      {/* ── Right column: mobile header (if mobile) + main content ──── */}
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">

        {isMobile && (
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
                {activeMod ? (
                  <>
                    <span>{activeMod.icon}</span>
                    <span>{activeMod.label}</span>
                  </>
                ) : (
                  <span>MyNostr</span>
                )}
              </span>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {sessionUser && <SessionAvatar sessionUser={sessionUser} />}
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
              {shareable && <ShareButton variant="icon" />}
            </div>
          </header>
        )}

        <main className="flex-1 overflow-hidden flex flex-col">
          {sessionUser && <OutboxWarningBanner sessionPubkey={sessionUser.pubkey} />}
          {children}
        </main>
      </div>

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
          showHelp={activeModule === 'articles'}
        />
      )}

      {/* BoostModal uses `user` for the "boost as" identity — that's the session
          user, not whoever's page we're on. */}
      {boostOpen && <BoostModal user={sessionUser} onClose={() => setBoostOpen(false)} readOnly={!isOwner} />}
      {helpOpen  && <HelpModal onClose={() => setHelpOpen(false)} />}
    </div>
  )
}

/**
 * Listens for `mynostr:outbox-warning` events dispatched by
 * ensureUserWriteRelays when a user's NIP-65 write relays can't be
 * resolved. Renders a dismissible strip so the user knows their
 * publishes are falling back to the fallback relay pool — otherwise the
 * outbox migration's whole point (writes landing on the right relays)
 * can silently fail after a bad network moment at login.
 *
 * Only renders for the current session's pubkey so a leftover event
 * from a previous account can't linger. Dismissal is session-scoped
 * (not persisted) — a new login re-opens the warning if it recurs.
 */
function OutboxWarningBanner({ sessionPubkey }) {
  const [visible, setVisible] = useState(false)
  const [reason, setReason]   = useState('')
  // Reset the banner whenever the session pubkey changes (login/logout/
  // account-switch). Also check the module-level buffer on mount — the
  // warning may have been dispatched during login/restore BEFORE this
  // component mounted, in which case addEventListener-only would miss it.
  // Read the buffer first and call setVisible once so pubkey changes cause
  // a single render instead of a false→true flicker.
  useEffect(() => {
    if (!sessionPubkey) {
      setVisible(false)
      return
    }
    const last = getLastOutboxWarning()
    if (last && last.pubkey === sessionPubkey) {
      setReason(last.reason || '')
      setVisible(true)
    } else {
      setVisible(false)
    }
  }, [sessionPubkey])
  useEffect(() => {
    if (!sessionPubkey) return
    function handler(e) {
      if (e?.detail?.pubkey && e.detail.pubkey !== sessionPubkey) return
      setReason(e?.detail?.reason || '')
      setVisible(true)
    }
    window.addEventListener(OUTBOX_WARNING_EVENT, handler)
    return () => window.removeEventListener(OUTBOX_WARNING_EVENT, handler)
  }, [sessionPubkey])
  function dismiss() {
    setVisible(false)
    clearLastOutboxWarning()
  }
  if (!visible) return null
  return (
    <div
      role="status"
      className="shrink-0 bg-amber-950/40 border-b border-amber-900/50 px-3 py-1.5 flex items-center gap-2 text-[11px] text-amber-200"
      title={reason ? `Detail: ${reason}` : undefined}
    >
      <span>⚠️</span>
      <span className="flex-1 truncate">
        Couldn't read your write relays — publishes may only reach fallback relays. Check Profile → Relays.
      </span>
      <button
        onClick={dismiss}
        aria-label="Dismiss"
        className="text-amber-300 hover:text-amber-100 px-1.5"
      >
        ✕
      </button>
    </div>
  )
}

/** Small circular pfp for the mobile top bar — shows who's signed in, to
 *  the left of the Logout button. Falls back to a "?" glyph when the image
 *  is missing or doesn't pass the URL safety check. */
function SessionAvatar({ sessionUser }) {
  const img = sessionUser?.profile?.image
  const label = sessionUser?.profile?.displayName || sessionUser?.profile?.name || 'Signed in'
  if (img && isSafeUrl(img)) {
    return (
      <img
        src={img}
        alt={label}
        title={label}
        className="w-6 h-6 rounded-full object-cover bg-neutral-800 shrink-0"
        onError={e => { e.target.style.display = 'none' }}
      />
    )
  }
  return (
    <span
      title={label}
      className="w-6 h-6 rounded-full bg-neutral-800 flex items-center justify-center text-[10px] text-neutral-500 shrink-0"
    >
      ?
    </span>
  )
}

/** Vertical side-rail tab. Active state is a bg tint + purple accent on the
 *  left edge — the horizontal `border-b` underline doesn't translate; a left
 *  bar reads as "you are here" in a column layout. */
function SideTab({ mod, active, onClick }) {
  return (
    <button
      onClick={onClick}
      title={mod.description}
      aria-current={active ? 'page' : undefined}
      className={`relative flex items-center gap-2 px-3 py-2 text-sm rounded-md transition-colors text-left ${
        active
          ? 'bg-purple-950/40 text-purple-300'
          : 'text-neutral-400 hover:text-neutral-200 hover:bg-neutral-900'
      } ${mod.status === 'soon' ? 'opacity-50' : ''}`}
    >
      {active && (
        <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-r bg-purple-400" aria-hidden="true" />
      )}
      <span className="w-5 text-center shrink-0">{mod.icon}</span>
      <span className="truncate">{mod.label}</span>
    </button>
  )
}

/** Profile identity button — lives at the bottom of the rail instead of
 *  inline with the module tabs. Shows the viewed user's pfp + displayName so
 *  it reads as "this is whose page you're on." Clicking it navigates to the
 *  profile module (same as the old Profile tab did). */
function ProfileIdentityTab({ profile, active, onClick }) {
  const displayName = profile?.displayName || profile?.name || 'Profile'
  return (
    <button
      onClick={onClick}
      title={displayName}
      aria-current={active ? 'page' : undefined}
      className={`relative flex items-center gap-2 px-2 py-1.5 rounded-md transition-colors text-left ${
        active
          ? 'bg-purple-950/40 text-purple-300'
          : 'text-neutral-300 hover:text-neutral-100 hover:bg-neutral-900'
      }`}
    >
      {active && (
        <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-r bg-purple-400" aria-hidden="true" />
      )}
      {profile?.image && isSafeUrl(profile.image) ? (
        <img
          src={profile.image}
          alt=""
          className="w-7 h-7 rounded-full object-cover bg-neutral-800 shrink-0"
          onError={e => { e.target.style.display = 'none' }}
        />
      ) : (
        <span className="w-7 h-7 rounded-full bg-neutral-800 flex items-center justify-center text-[11px] text-neutral-500 shrink-0">
          ?
        </span>
      )}
      <span className="text-sm truncate flex-1 min-w-0">{displayName}</span>
    </button>
  )
}

