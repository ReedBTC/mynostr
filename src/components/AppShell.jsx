import { useState, useEffect } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { MODULES } from '../App.jsx'
import { isSafeUrl } from '../lib/utils.js'
import { getLastOutboxWarning, clearLastOutboxWarning, OUTBOX_WARNING_EVENT } from '../lib/ndk.js'
import { useIsMobile } from '../hooks/useIsMobile.js'
import { useOwnerContext } from '../lib/ownerContext.jsx'
import { useLoginModal } from './LoginModalContext.jsx'
import BoostModal from './BoostModal.jsx'
import BugReportModal from './BugReportModal.jsx'
import HelpModal from '../modules/articles/components/HelpModal.jsx'
import MobileNavDrawer from './MobileNavDrawer.jsx'
import ShareButton from './ShareButton.jsx'
import WalletConnectModal from './WalletConnectModal.jsx'
import { useWalletStatus } from '../lib/useWalletStatus.js'
import * as nwc from '../lib/nwc.js'
import * as webln from '../lib/webln.js'

// Dispatch disconnect to whichever adapter is currently active.
// `pubkey` is the currently-signed-in user — webln scopes its persisted
// "previously authorized" flag per-pubkey, so disconnect needs to know
// whose flag to clear. Both calls are safe no-ops if their adapter
// isn't connected.
function disconnectActiveWallet(pubkey) {
  if (nwc.isReady())   nwc.disconnect()
  if (webln.isReady()) webln.disconnect({ pubkey })
}

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
  const { openLogin } = useLoginModal()
  const [boostOpen, setBoostOpen]   = useState(false)
  const [helpOpen,  setHelpOpen]    = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [walletOpen, setWalletOpen] = useState(false)
  const [bugOpen,    setBugOpen]    = useState(false)
  const walletStatus = useWalletStatus()
  // Hide the wallet row entirely for logged-out and read-only sessions —
  // NWC encryption needs a signer, and a connect attempt would just error.
  const canUseWallet = !!sessionUser && !sessionUser.readOnly
  const profile = user?.profile
  const activeMod = MODULES.find(m => m.id === activeModule)
  // Write + Search surfaces aren't publicly shareable — Write has no URL
  // worth sharing; Search is owner-only and redirects visitors out.
  const shareable = subtab !== 'write' && subtab !== 'search'

  // onLogout is now centralized at the App level — it tears down NDK and
  // clears session state itself. No local wrapping needed; buttons below
  // call it directly.

  function handleLoginClick() {
    // Login is a modal now — opens over the current page so browsing
    // state (scroll, feed, filters) survives. No navigation.
    openLogin()
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
            <button
              onClick={() => {
                if (sessionUser?.pubkey && !sessionUser.readOnly) setBugOpen(true)
                else openLogin()
              }}
              className="text-xs text-green-500 hover:text-green-300 transition-colors px-2 py-1.5 rounded border border-green-900 hover:border-green-700 inline-flex items-center justify-center gap-1.5"
              aria-label="Report a bug"
            >
              <span aria-hidden>🐛</span>
              <span>Report a Bug</span>
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

          {/* Profile identity — sits above the divider, grouped with the
              module nav since it IS a module (the viewed user's profile).
              Three layouts based on session/viewing state:
                - Logged in AND viewing someone else → dual pfps: session
                  pfp on top (click → /yourNpub/profile), viewed pfp
                  below with × (click × or pfp → /yourNpub/profile or
                  /viewedNpub/profile respectively).
                - Otherwise (logged out OR viewing self) → single pfp
                  showing whichever identity is available.
              All clicks go to /npub/profile — "go home" means the
              profile landing, not whatever module you were on. */}
          {(() => {
            const viewingOther =
              sessionUser?.pubkey && user?.pubkey && sessionUser.pubkey !== user.pubkey
            if (viewingOther) {
              // Viewed user goes on top (with × to dismiss), session on
              // the bottom — same slot the session pfp occupies in the
              // normal single-pfp case, so the "your identity" anchor
              // stays put no matter whose page you're browsing.
              return (
                <div className="shrink-0 px-3 pb-2 space-y-1">
                  <ProfileIdentityTab
                    profile={user.profile}
                    active={activeModule === 'profile'}
                    onClick={() => navigate(`/${user.npub}/profile`)}
                    onClose={() => navigate(`/${sessionUser.npub}/profile`)}
                    closeTitle="Close and return to your profile"
                  />
                  <ProfileIdentityTab
                    profile={sessionUser.profile}
                    active={false}
                    onClick={() => navigate(`/${sessionUser.npub}/profile`)}
                  />
                </div>
              )
            }
            const singleProfile = user?.profile || sessionUser?.profile
            const singleNpub = user?.npub || sessionUser?.npub
            if (!singleProfile && !singleNpub) return null
            return (
              <div className="shrink-0 px-3 pb-2">
                <ProfileIdentityTab
                  profile={singleProfile}
                  active={activeModule === 'profile'}
                  onClick={() => {
                    if (singleNpub) navigate(`/${singleNpub}/profile`)
                  }}
                />
              </div>
            )
          })()}

          {/* Session controls — below the divider, cleanly separated from
              navigation. Wallet row (if applicable) + viewer badge +
              Login/Logout. Wallet row is hidden for read-only and
              logged-out sessions since NWC needs a signer. */}
          <div className="shrink-0 border-t border-neutral-800 px-3 py-3 space-y-2">
            {canUseWallet && (
              <SidebarWalletRow
                status={walletStatus}
                onConnect={() => setWalletOpen(true)}
              />
            )}
            <div className="flex items-center gap-2 flex-wrap">
              {viewerBadgeText && (
                <span className="text-[11px] text-amber-500 border border-amber-900 rounded px-2 py-0.5">
                  {viewerBadgeText}
                </span>
              )}
              {sessionUser ? (
                <button
                  onClick={onLogout}
                  className="text-xs text-neutral-600 hover:text-neutral-300 transition-colors px-2 py-1 rounded border border-neutral-800 hover:border-neutral-600"
                  aria-label="Logout"
                >
                  Logout
                </button>
              ) : null}
              {canUseWallet && walletStatus?.connected && (
                <button
                  onClick={() => disconnectActiveWallet(sessionUser?.pubkey)}
                  className="text-xs text-neutral-600 hover:text-red-300 transition-colors px-2 py-1 rounded border border-neutral-800 hover:border-red-900"
                  aria-label="Disconnect wallet"
                >
                  Disconnect Wallet
                </button>
              )}
              {!sessionUser && (
                <button
                  onClick={handleLoginClick}
                  className="text-xs text-purple-400 hover:text-purple-300 transition-colors px-2 py-1 rounded border border-purple-900 hover:border-purple-700"
                  aria-label="Login"
                >
                  Login
                </button>
              )}
            </div>
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
                  onClick={onLogout}
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
          onReportBug={() => {
            if (sessionUser?.pubkey && !sessionUser.readOnly) setBugOpen(true)
            else openLogin()
          }}
          onHelp={() => setHelpOpen(true)}
          onLogout={onLogout}
          onLogin={handleLoginClick}
          showHelp={activeModule === 'articles'}
          walletStatus={walletStatus}
          canUseWallet={canUseWallet}
          onConnectWallet={() => setWalletOpen(true)}
          onDisconnectWallet={() => disconnectActiveWallet(sessionUser?.pubkey)}
        />
      )}

      {/* BoostModal uses `user` for the "boost as" identity — that's the session
          user, not whoever's page we're on. */}
      {boostOpen  && <BoostModal user={sessionUser} onClose={() => setBoostOpen(false)} readOnly={!isOwner} />}
      {helpOpen   && <HelpModal onClose={() => setHelpOpen(false)} />}
      {walletOpen && (
        <WalletConnectModal
          user={sessionUser}
          onClose={() => setWalletOpen(false)}
        />
      )}
      {bugOpen && <BugReportModal user={sessionUser} onClose={() => setBugOpen(false)} />}
    </div>
  )
}

/**
 * Compact wallet row for the desktop sidebar foot. Two states:
 *   - connected: green dot + protocol label + alias (or "Connected").
 *     Disconnect lives next to Logout in the row below.
 *   - not connected: full-width "Connect Wallet" button (purple, matches login)
 */
function SidebarWalletRow({ status, onConnect }) {
  if (status?.connected) {
    return (
      <div className="flex items-center gap-1.5 text-[11px] text-neutral-300">
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" aria-hidden="true" />
        <span className="text-neutral-500 shrink-0">{status.kind === 'webln' ? 'WebLN:' : 'NWC:'}</span>
        <span className="truncate">{status.alias || 'Connected'}</span>
      </div>
    )
  }
  if (status?.probing) {
    return (
      <div className="flex items-center gap-1.5 text-[11px] text-neutral-400">
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse shrink-0" aria-hidden="true" />
        <span className="truncate">Checking wallet…</span>
      </div>
    )
  }
  return (
    <button
      type="button"
      onClick={onConnect}
      className="w-full text-xs text-purple-300 hover:text-purple-200 transition-colors px-2 py-1.5 rounded border border-purple-900 hover:border-purple-700 inline-flex items-center justify-center gap-1.5"
      aria-label="Connect Lightning Wallet"
    >
      <span aria-hidden="true">⚡</span>
      <span>Connect Wallet</span>
    </button>
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

/** Profile identity tab — pfp + displayName row that sits above the
 *  divider, grouped with the module nav.
 *
 *  When sessionUser !== viewedUser, AppShell renders TWO of these:
 *    - Session pfp (you) on top — click to go to /yourNpub/profile
 *    - Viewed pfp (them) below with a ×  — click pfp to go to their
 *      profile, click × to "close" and return to your profile
 *
 *  The × is an optional inline button; pass onClose to show it. We use
 *  a div (not button) as the outer element so the × can be a nested
 *  real button — nesting <button> inside <button> is invalid HTML. */
function ProfileIdentityTab({ profile, active, onClick, onClose, closeTitle }) {
  const displayName = profile?.displayName || profile?.name || 'Profile'
  const baseClass = `relative flex items-center gap-2 px-2 py-1.5 rounded-md transition-colors text-left w-full ${
    active
      ? 'bg-purple-950/40 text-purple-300'
      : 'text-neutral-300 hover:text-neutral-100 hover:bg-neutral-900'
  }`
  return (
    <div className={baseClass} role="group">
      {active && (
        <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-r bg-purple-400" aria-hidden="true" />
      )}
      <button
        type="button"
        onClick={onClick}
        title={displayName}
        aria-current={active ? 'page' : undefined}
        className="flex items-center gap-2 min-w-0 flex-1 text-left bg-transparent"
      >
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
        <span className="text-sm truncate min-w-0">{displayName}</span>
      </button>
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          title={closeTitle || 'Close'}
          aria-label={closeTitle || 'Close'}
          className="shrink-0 text-neutral-500 hover:text-neutral-200 p-0.5 rounded transition-colors"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="6" y1="6" x2="18" y2="18" />
            <line x1="18" y1="6" x2="6" y2="18" />
          </svg>
        </button>
      )}
    </div>
  )
}

