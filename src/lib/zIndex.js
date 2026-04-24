/**
 * Z-INDEX LADDER
 *
 * All fixed/absolute overlay layers across the app read from this file
 * rather than inlining `z-[NN]` Tailwind values. Benefits:
 *   - one place to see the stacking order
 *   - changing a layer's position doesn't require grepping the codebase
 *   - new modals/popovers can't accidentally sandwich themselves
 *     between an existing modal and its nested confirm
 *
 * Layers are numbered in steps of 10 so intermediate values remain free
 * for future additions without disturbing existing callers.
 *
 * Usage:
 *   import { Z } from '../../lib/zIndex.js'
 *   <div className={`fixed ... ${Z.modal}`}>...</div>
 *
 * Tailwind's JIT scans the source for class literals, so the values below
 * are pre-committed as string templates. If you add a new layer, write it
 * as a literal `z-[NN]` string — NOT a computed concatenation — or Tailwind
 * will skip it at build time.
 */

export const Z = {
  // Per-card / per-row absolute-positioned dropdowns that live inside
  // the normal page flow and should sit above page content but below
  // any modal surface.
  inlineDropdown: 'z-20',

  // Bookmarks-submenu, notes menus etc. rendered inside the main layout
  // (no portal). One level above the inline dropdowns so a dropdown
  // opening inside a menu appears in front of its siblings.
  inlineMenu:     'z-30',

  // ── Portaled surfaces. These render to document.body so they escape
  //    overflow/stacking-context boundaries. Ordered shallowest → deepest. ──

  // Top-level modals (login, relay discovery, help, boost).
  modal:          'z-[50]',
  modalContent:   'z-[51]',
  modalCloseBtn:  'z-[52]',

  // Portaled menus from NoteActionsMenu / ArticleActionsMenu. Sit above
  // the modal layer so a three-dot menu opened inside a modal reads
  // on top of the modal chrome.
  portaledMenu:   'z-[60]',

  // Nested confirmation dialogs launched from inside a modal (e.g.
  // AddRelayConfirm from inside RelayDiscoveryModal).
  nestedConfirm:  'z-[60]',

  // Login modal layers. Login is the one modal that must open over
  // any other surface — triggered from anywhere, never gets sandwiched.
  loginOverlay:   'z-[70]',
  loginContent:   'z-[71]',
  loginCloseBtn:  'z-[72]',

  // InfoDot popovers — topmost so they're readable from INSIDE any
  // other modal (including login). Keep this above every other layer.
  infoPopover:    'z-[80]',
}
