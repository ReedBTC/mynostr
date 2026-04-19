/**
 * UserReactionsContext — exposes the session user's kind 7 "liked" set
 * to every NoteActionBar in the Notes module without prop-drilling.
 *
 * Hoisted at NotesModule so useUserReactions runs exactly once per
 * session. NoteActionBar derives its heart-icon state from the shared
 * set, so a like made on one card immediately reflects on any other
 * card showing the same note (relevant once replies/quotes land).
 */
import { createContext, useContext } from 'react'
import { useUserReactions } from '../../lib/useUserReactions.js'

const UserReactionsContext = createContext({
  likedIds: new Set(),
  markLiked: () => {},
  unmarkLiked: () => {},
  isLoaded: false,
})

export function UserReactionsProvider({ user, children }) {
  const value = useUserReactions(user)
  return <UserReactionsContext.Provider value={value}>{children}</UserReactionsContext.Provider>
}

export function useUserReactionsContext() {
  return useContext(UserReactionsContext)
}
