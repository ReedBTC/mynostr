/**
 * NotesNavigationContext — lets any NoteCard in the Notes module hand a
 * pubkey back to SearchTab so clicking an author's pfp/name opens their
 * feed, matching the Longform Discover behavior.
 *
 * Only the owner gets a non-null callback. Visitors don't have a Search
 * tab, so NoteCard renders the header as a plain div instead of a button
 * when `openAuthorInSearch` is null.
 */
import { createContext, useContext } from 'react'

const NotesNavigationContext = createContext({
  openAuthorInSearch: null,
})

export function NotesNavigationProvider({ openAuthorInSearch, children }) {
  return (
    <NotesNavigationContext.Provider value={{ openAuthorInSearch }}>
      {children}
    </NotesNavigationContext.Provider>
  )
}

export function useNotesNavigationContext() {
  return useContext(NotesNavigationContext)
}
