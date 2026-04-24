/**
 * ArticleBookmarksContext — session-scoped reading lists for the Articles
 * module. Mirrors NoteBookmarksContext.
 *
 * The provider is deliberately dumb: it just passes a `value` through to
 * the React context. The session's `useReadingLists` call lives in
 * ArticlesModule so that the module can also reuse the same hook output
 * to render the owner's own Collection display — keeping writes and the
 * display on one state source. If the provider owned the hook, it would
 * create a second instance for the same pubkey whenever the module also
 * called `useReadingLists(user)` on its own page, and a bookmark written
 * through the context would fail to appear in the display until the
 * second instance refetched on reload. That divergence was the original
 * "bookmark silently fails" bug.
 */
import { createContext, useContext } from 'react'

const ArticleBookmarksContext = createContext({
  myLists: [],
  loading: false,
  addArticle: async () => false,
  addArticlesBulk: async () => false,
  createList: async () => null,
  removeArticle: async () => false,
  canBookmark: false,
})

export function ArticleBookmarksProvider({ value, children }) {
  return <ArticleBookmarksContext.Provider value={value}>{children}</ArticleBookmarksContext.Provider>
}

export function useArticleBookmarksContext() {
  return useContext(ArticleBookmarksContext)
}
