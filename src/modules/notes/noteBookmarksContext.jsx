/**
 * NoteBookmarksContext — makes the current user's categorized note
 * bookmarks available to every NoteCard inside the Notes module without
 * prop-drilling through AuthorNotesPane / BookmarksTab / SearchTab.
 *
 * Hoisted at NotesModule so useNoteBookmarks runs exactly once per session
 * (the underlying NDK relay subscription for kinds 10003 + 30003 is
 * session-long — redoing it per tab switch would be wasted work).
 *
 * Consumers:
 *   - NoteCard reads `categories` + mutating fns to render the "Add to
 *     bookmarks" submenu in its three-dot actions menu.
 *   - BookmarksTab reads `categories` as the source of truth for which
 *     notes to show in the feed.
 */
import { createContext, useContext } from 'react'
import { useNoteBookmarks } from '../../lib/useNoteBookmarks.js'

const NoteBookmarksContext = createContext({
  categories: [],
  loading: false,
  privateDecryptFailed: 0,
  createCategory: async () => null,
  addNote: async () => {},
  removeNote: async () => {},
  movePrivacy: async () => {},
  bulkMovePrivacy: async () => {},
  deleteCategory: async () => {},
  renameCategory: async () => {},
  hiddenIdsByView: { public: new Set(), private: new Set() },
  hideCategory: () => {},
  unhideCategory: () => {},
  canEdit: false,
})

export function NoteBookmarksProvider({ user, children }) {
  const hook = useNoteBookmarks(user)
  const canEdit = !!user?.pubkey && !user?.readOnly
  const value = { ...hook, canEdit }
  return <NoteBookmarksContext.Provider value={value}>{children}</NoteBookmarksContext.Provider>
}

export function useNoteBookmarksContext() {
  return useContext(NoteBookmarksContext)
}
