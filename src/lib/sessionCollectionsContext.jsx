/**
 * SessionCollectionsContext — single source of truth for the SESSION
 * user's kind 30405 collections.
 *
 * Why this exists: every product card on the feed renders a watchlist
 * toggle / save-to-collection picker. Without a shared cache, each
 * card's hooks fire their own ndk.fetchEvents call for the user's
 * collections — N cards × 1 fetch each = a fetch storm that thrashes
 * relays and blows past the 8s timeout in NDK. Hoisting one
 * useCollections call to MarketplaceModule and exposing it via context
 * gives every consumer the same already-loaded data.
 *
 * The provider is mounted once in MarketplaceModule with the session
 * user's pubkey. Consumers (WatchlistButton, ProductActionsMenu's
 * picker, AddToCollectionModal) read from context rather than firing
 * their own useCollections call.
 *
 * VIEWING someone else's collections (CollectionsTab on a visitor's
 * profile) still uses useCollections directly with the viewed user's
 * pubkey — that's a different data set and shouldn't share the cache.
 */
import { createContext, useContext } from 'react'

export const SessionCollectionsContext = createContext(null)

/**
 * Returns the session user's collections hook output.
 * Returns null when not signed in or when the marketplace module
 * hasn't mounted (e.g., this hook is called outside the provider).
 * Callers should handle null gracefully — typically by hiding their
 * collection-mutation UI when the session has no signer anyway.
 */
export function useSessionCollections() {
  return useContext(SessionCollectionsContext)
}
