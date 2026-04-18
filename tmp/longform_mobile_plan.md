# Longform module — mobile-friendly pass

## Context

mynostr.app is desktop-first by design (power-user tool), but the site is live and mobile users currently get a **broken Longform Write experience**: the Write tab's side-by-side layout (editor column + `w-80` metadata sidebar) leaves ~55px usable width on a 375px phone. Inside the editor column, `@uiw/react-md-editor` further splits `w-1/2` raw markdown + `w-1/2` custom preview. On mobile this is unusable.

This plan is a **small-to-medium retrofit** (additive CSS + conditional wrappers at breakpoints, desktop ≥ md untouched) — not a rewrite. Originally scoped on 2026-04-16; refreshed today against the current codebase.

## What's changed since original scoping (2026-04-16 → 2026-04-18)

- **Phase 1 Step 1 is done.** `src/hooks/useIsMobile.js` now exists as a shared hook. It's already used by `src/AppShell.jsx`, `src/components/LoginScreen.jsx`, `src/components/MobileNavDrawer.jsx`, and `src/modules/notes/NotesModule.jsx`.
- **Longform file paths moved into subdirectories.** Affected files for this plan:
  - `src/modules/longform/LongformModule.jsx` (unchanged location, 237 lines) — still has the `flex flex-1` Write tab with `w-80` sidebar
  - `src/modules/longform/components/Editor.jsx` (370 lines) — was `src/modules/longform/Editor.jsx`
  - `src/modules/longform/components/MetadataForm.jsx` (160 lines)
  - `src/modules/longform/components/PublishButton.jsx` (207 lines)
  - `src/modules/longform/components/discover/DiscoverView.jsx` (904 lines) — was `src/modules/longform/DiscoverView.jsx`
  - `src/modules/longform/components/discover/ArticleReadPanel.jsx` (711 lines) — same relocation
- **Zero responsive Tailwind classes across the entire longform module tree.** Mobile work on Longform genuinely hasn't started.

(Memory file `memory/project_longform_mobile_plan.md` still has the old paths and should be updated when this work resumes.)

## Interaction with "Your Web Page" roadmap

The sibling roadmap (`tmp/mynostr_roadmap.md`) introduces routing + owner-vs-visitor mode. Impact on this plan:

- **Phase 1 (Write mode mobile) is orthogonal.** The Editor, MetadataForm, PublishButton are internal components the shell pivot doesn't touch. Safe to do before or after.
- **Phase 2 (DiscoverView mobile) overlaps.** Under the roadmap, `DiscoverView` changes role — it becomes the way you view *any* author's articles via their `/:npub/longform` URL. Mobile-polishing it before that reshape risks rework. **Recommendation: defer Phase 2 until after the shell pivot.**
- **Phase 3 (PWA) is independent** and can happen anywhere on the timeline.

## Phase 1 — Write mode responsive (1–2 hours, near-zero risk)

1. ~~Extract `useIsMobile` into `src/hooks/useIsMobile.js`.~~ **Done.**
2. `src/modules/longform/LongformModule.jsx:152-210`: change the Write tab's `flex flex-1` → `flex flex-col md:flex-row flex-1`. The `w-80` sidebar at line 177 becomes `w-full md:w-80`. Below `md:`, wrap the sidebar in a bottom-sheet drawer triggered by a new "Metadata" button in the editor header. Drawer closes on publish.
3. `src/modules/longform/components/Editor.jsx`: the internal `w-1/2 | w-1/2` raw/preview split becomes `w-full md:w-1/2` each. Add a mobile-only tab in the editor header (alongside existing Upload/Write tabs) that toggles between edit and preview on small screens. Desktop keeps side-by-side.
4. PublishButton stays inside the drawer. Mobile flow becomes: tap Metadata → fill title → Publish.

## Phase 2 — Discover + reader (2–4 hours, low risk) — **defer until after shell pivot**

1. `src/modules/longform/components/discover/DiscoverView.jsx`: below `md:`, show article-list OR reader (not both) with a back button. Right sidebar (280px) becomes a drawer triggered by a "Lists" button. Hide resize divider on mobile.
2. `src/modules/longform/components/discover/ArticleReadPanel.jsx`: verify prose classes are mobile-friendly; tweak line-height/spacing if needed.

## Phase 3 — PWA-ify (optional, ~2 hours, independent)

- Add `manifest.json` with icons, theme color, `display: standalone`
- Minimal service worker caching app shell + recently-read articles for offline
- Adds `rel="manifest"` to `index.html`
- Unlocks "install to home screen" on iOS/Android

## Explicitly ruled out

- **True Obsidian-style inline live preview** (CodeMirror decorations / Milkdown / Tiptap). Would require replacing `@uiw/react-md-editor` — weeks of work, risks regressing image paste/drop, toolbar, Blossom uploads. The mobile Edit/Preview tab is the pragmatic substitute.
- Touching Notes or any other module in this pass. Longform only; ship, iterate.
- Any large-scale CSS refactor. Changes stay targeted to ~3–4 files.
- Modifying the desktop 3-column layout.

## Confidence estimates (refreshed)

- Phase 1 — Write mode responsive: **~90%**
- Phase 1 — Editor preview as mobile tab: **~85%**
- Phase 2 — DiscoverView mobile: **~70%** (largest surface; deferred)
- Phase 2 — Article reader mobile: **~85%**
- Overall not breaking desktop: **~85%** (changes are additive at breakpoints, desktop ≥ md untouched)

## Verification

After Phase 1:
- On a 375px viewport: Write tab stacks vertically. Editor occupies full width. "Metadata" button opens bottom-sheet drawer with MetadataForm + OriginalSourceField + PublishButton. Editor's raw/preview split collapses to a toggle tab; user can flip between writing and previewing.
- Desktop ≥ md unchanged: side-by-side editor + `w-80` sidebar, no toggle tab visible, no drawer button.
- Publish flow still works end-to-end on both.

After Phase 2 (when unblocked):
- On mobile: DiscoverView shows list OR reader, not both. Back button on reader returns to list. "Lists" button opens right-sidebar content as a drawer. Resize divider hidden.
- Desktop unchanged.

After Phase 3:
- Lighthouse PWA audit passes. "Add to Home Screen" prompt available on mobile. App shell loads offline.

## Rough total scope

~150–250 lines of JSX/CSS changes across `LongformModule.jsx`, `components/Editor.jsx`, `components/discover/DiscoverView.jsx`, plus minor reader tweaks. ~1–2 focused days end-to-end if all three phases ship. Phase 1 alone is a single PR, previewable on phone, ~1–2 hours.
