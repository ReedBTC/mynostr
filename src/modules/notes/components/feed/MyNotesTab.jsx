/**
 * MyNotesTab — "My Notes" (owner) or "Notes by …" (visitor) pane.
 * Thin wrapper around AuthorNotesPane pinned to the viewed user's pubkey.
 */
import AuthorNotesPane from './AuthorNotesPane.jsx'

export default function MyNotesTab({ user, isOwner }) {
  const pubkey = user?.pubkey
  const displayName = user?.profile?.displayName || user?.profile?.name || 'this user'
  const empty = isOwner
    ? 'You haven\u2019t published any short notes yet.'
    : `${displayName} hasn\u2019t published any short notes yet.`

  if (!pubkey) {
    return (
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-xl mx-auto px-4 py-10 text-center">
          <p className="text-xs text-neutral-500">No user loaded.</p>
        </div>
      </div>
    )
  }

  return <AuthorNotesPane pubkey={pubkey} emptyMessage={empty} />
}
