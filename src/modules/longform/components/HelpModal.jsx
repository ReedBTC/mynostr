import { useEffect } from 'react'

export default function HelpModal({ onClose }) {
  useEffect(() => {
    function handleKey(e) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onClose])

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/70 z-20"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Modal */}
      <div
        className="fixed inset-0 z-30 flex items-center justify-center p-6"
        role="dialog"
        aria-label="How to use NostrMD"
      >
        <div className="bg-neutral-900 border border-neutral-800 rounded-lg w-full max-w-2xl max-h-[80vh] flex flex-col">

          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-800">
            <h2 className="text-sm font-semibold text-neutral-200">How to Use NostrMD</h2>
            <button
              onClick={onClose}
              className="text-neutral-500 hover:text-neutral-300 transition-colors text-lg leading-none"
              aria-label="Close help"
            >
              ✕
            </button>
          </div>

          {/* Scrollable content */}
          <div className="overflow-y-auto px-6 py-5 space-y-6 text-sm text-neutral-400 leading-relaxed">

            <section className="space-y-2">
              <h3 className="text-neutral-200 font-semibold">What is NostrMD?</h3>
              <p>
                NostrMD is a single-purpose tool for publishing long-form articles to Nostr (NIP-23 Kind 30023 events).
                It's designed for writers migrating content from other platforms — Substack, Medium, personal blogs — with
                accurate metadata, original source attribution, and proper backdating.
              </p>
            </section>

            <section className="space-y-2">
              <h3 className="text-neutral-200 font-semibold">Logging In</h3>
              <p>
                <span className="text-neutral-300">Login with Extension</span> — uses your Nostr browser extension (Alby, nos2x, Nostore).
                Your private key never leaves the extension.
              </p>
              <p>
                <span className="text-neutral-300">Login with Key</span> — paste your <code className="text-purple-400">nsec1...</code> key directly.
                It is held in memory only and is never written to storage. It clears when you log out or refresh the page.
              </p>
              <p>
                <span className="text-neutral-300">Login with npub</span> — paste your <code className="text-purple-400">npub1...</code> public key for
                read-only access. You can browse your published long-form notes via <span className="text-neutral-300">My Articles</span>, preview them,
                and download them as <code className="text-purple-400">.md</code> files. Publishing is disabled.
              </p>
            </section>

            <section className="space-y-2">
              <h3 className="text-neutral-200 font-semibold">The Editor</h3>
              <p>
                <span className="text-neutral-300">Upload .md file</span> — click to open a file picker and load a markdown file into the editor.
                If the file has YAML frontmatter (from a previous NostrMD export), all metadata fields will be auto-populated.
              </p>
              <p>
                <span className="text-neutral-300">Write / Paste</span> — switch to a blank editor to write or paste content directly.
              </p>
              <p>
                The right pane shows a live preview including your cover image, title, subtitle, attribution line, and rendered markdown body.
              </p>
              <p>
                <span className="text-neutral-300">Export .md</span> — downloads your current article as a <code className="text-purple-400">.md</code> file
                with all metadata saved as YAML frontmatter at the top. Use this to keep local backups of your Nostr articles.
              </p>
              <p>
                <span className="text-neutral-300">Clear</span> — resets the editor and all metadata fields to a blank slate.
              </p>
            </section>

            <section className="space-y-2">
              <h3 className="text-neutral-200 font-semibold">Article Metadata</h3>
              <p><span className="text-neutral-300">Title</span> — required. Maps to the NIP-23 <code className="text-purple-400">title</code> tag.</p>
              <p><span className="text-neutral-300">Summary / Subtitle</span> — optional. Maps to the <code className="text-purple-400">summary</code> tag.</p>
              <p><span className="text-neutral-300">Cover Image URL</span> — paste any image URL. Renders as a 16:9 preview in real time.</p>
              <p><span className="text-neutral-300">Tags</span> — comma-separated hashtags. The <code className="text-purple-400">#</code> is optional.</p>
            </section>

            <section className="space-y-2">
              <h3 className="text-neutral-200 font-semibold">Original Source</h3>
              <p>
                Use this section when publishing an article that was originally written somewhere else.
              </p>
              <p>
                <span className="text-neutral-300">Original Platform / Source Name</span> — e.g. "Substack", "Medium", "My Blog".
              </p>
              <p>
                <span className="text-neutral-300">Original URL</span> — optional link back to the original post.
              </p>
              <p>
                <span className="text-neutral-300">Original Publication Date</span> — sets the <code className="text-purple-400">published_at</code> tag,
                which is the date displayed by NIP-23 clients like Habla and Highlighter. Leave blank to use today's date.
              </p>
              <p>
                When a source name is provided, NostrMD automatically prepends an italicized attribution line to your content before signing:
                <span className="block mt-1 italic text-neutral-500 pl-3 border-l border-neutral-700">
                  Originally published at [Platform] on Month Day, Year
                </span>
              </p>
            </section>

            <section className="space-y-2">
              <h3 className="text-neutral-200 font-semibold">Publishing</h3>
              <p>
                Click <span className="text-neutral-300">Publish to Nostr</span> to sign and broadcast your article.
                NostrMD reads your Kind 10002 relay list and publishes to your write relays. If none are found, it falls
                back to a curated set of long-form friendly relays.
              </p>
              <p>
                After publishing, you'll see a confirmation with the relays that acknowledged your event, a link to view
                it on njump.me, and a <span className="text-neutral-300">Copy naddr</span> button that copies the permanent
                address for your article — useful for linking to it from other notes.
              </p>
            </section>

            <section className="space-y-2">
              <h3 className="text-neutral-200 font-semibold">My Articles</h3>
              <p>
                Click <span className="text-neutral-300">My Articles</span> in the header to load all of your previously
                published long-form notes from your relays. Click any article to load it back into the editor with all
                metadata restored — ready to edit and re-publish.
              </p>
              <p>
                Re-publishing an article with the same title replaces the original on relays that support replaceable events
                (NIP-23 Kind 30023 uses the title slug as the <code className="text-purple-400">d</code> tag identifier).
              </p>
            </section>

            <section className="space-y-2">
              <h3 className="text-neutral-200 font-semibold">Backing Up Your Articles</h3>
              <p>
                Use <span className="text-neutral-300">My Articles</span> to load a note, then <span className="text-neutral-300">Export .md</span> to
                save it locally. The exported file contains all metadata in YAML frontmatter — title, date, tags, source, cover image.
                Uploading it back into NostrMD restores everything exactly as it was.
              </p>
              <p>
                This gives you a complete local archive of your Nostr long-form content, independent of any relay.
              </p>
            </section>

          </div>
        </div>
      </div>
    </>
  )
}
