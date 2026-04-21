import { useState } from 'react'

/**
 * RelayFAQ — collapsible primer appended to the bottom of RelayCard.
 *
 * This is the teaching layer under the table. The columns tell you WHAT a
 * relay does; the FAQ tells you why it matters, how to pick your own relays,
 * and what the non-obvious surprises are (relays don't share notes; deletion
 * is best-effort; the software stack has real implications).
 *
 * Each question is independently collapsible so the FAQ doesn't dominate
 * vertical space by default. The top-level header toggles the whole section.
 */

const ITEMS = [
  {
    q: 'What is a relay?',
    a: (
      <>
        A relay is a small server that stores and serves Nostr events (notes,
        profiles, likes, zaps, etc.). You publish an event to one or more
        relays, and anyone who connects to those same relays can read it.
        Unlike Twitter or Facebook, there is no central database —
        <span className="text-neutral-100"> Nostr is the network of relays</span>,
        and each relay is run by a different person or organization.
      </>
    ),
  },
  {
    q: 'Do relays share notes with each other?',
    a: (
      <>
        <span className="text-neutral-100">No.</span> This is the single biggest
        surprise for new users. Relays do not gossip events between themselves —
        if you publish a note only to Relay A, someone connected only to Relay B
        will never see it. Clients (like mynostr) fan out your publishes to
        multiple relays so your notes reach a wider audience. Reading clients
        do the reverse: they connect to many relays and merge what they find.
      </>
    ),
  },
  {
    q: 'How many relays should I use?',
    a: (
      <>
        A common sweet spot is{' '}
        <span className="text-neutral-100">3–5 write relays</span> and{' '}
        <span className="text-neutral-100">5–10 read relays</span>. Writing to
        too many relays slows every publish and wastes bandwidth; writing to
        too few makes you invisible if any of them go down. Reading from more
        relays catches more replies and follows but takes longer to load.
      </>
    ),
  },
  {
    q: 'What is the difference between a read relay and a write relay?',
    a: (
      <>
        A <span className="text-neutral-100">write</span> relay is one you publish
        your own notes to — your outbox. A <span className="text-neutral-100">read</span>{' '}
        relay is one your client pulls other people's notes from — your inbox.
        Most relays are both, but marking them separately lets you, for example,
        write only to a trusted paid relay while reading from a wider fan-out of
        free relays. Other clients discover where to find your notes by checking
        your <span className="text-neutral-100">write</span> relays, and they
        deliver replies and mentions to your <span className="text-neutral-100">read</span> relays.
      </>
    ),
  },
  {
    q: 'If I can only have 8 relays, which 8 should I pick?',
    a: (
      <>
        Think about four properties, and try to cover each:
        <ul className="list-disc pl-5 mt-2 space-y-1.5">
          <li>
            <span className="text-neutral-100">Diversity of operators.</span>{' '}
            If every relay in your list is run by the same team or hosted on the
            same cloud provider, one takedown or policy change silences you
            everywhere at once. Pick relays from at least three independent
            operators.
          </li>
          <li>
            <span className="text-neutral-100">Redundancy.</span> Three write
            relays is the floor — losing any one shouldn't lose your note.
            A fourth and fifth adds margin without much extra cost.
          </li>
          <li>
            <span className="text-neutral-100">Geography.</span> Relays are
            servers in specific places. If they're all in one region, users on
            the other side of the world see your notes more slowly and a
            regional outage silences you globally. Two or three regions is
            usually plenty.
          </li>
          <li>
            <span className="text-neutral-100">Mix of paid and free.</span>{' '}
            Paid relays usually have better uptime, stricter spam filtering,
            and longer retention; free relays are lower friction and more
            numerous. Using only one kind concentrates your risk — if the paid
            relay boots you, or the free relays all go down at once, you need
            the other bucket as a fallback.
          </li>
        </ul>
        <div className="mt-2">
          A reasonable starting mix for most users:
        </div>
        <ul className="list-disc pl-5 mt-1 space-y-1 text-neutral-400">
          <li>1 paid relay as your primary (e.g. nostr.wine, relay.primal.net)</li>
          <li>2–3 popular free relays from different operators (e.g. relay.damus.io, nos.lol, nostr.mom)</li>
          <li>1 relay for your community / language / region</li>
          <li>1 relay with search (NIP-50) so you can grep your own history later</li>
          <li>1 relay that honors deletion (NIP-62) if right-to-delete matters to you</li>
        </ul>
      </>
    ),
  },
  {
    q: 'What does the "Paid" badge mean?',
    a: (
      <>
        Some relays charge a small one-time or recurring fee to accept your
        writes. In exchange you typically get better uptime, less spam, and
        longer event retention. The badge is lit when the relay declares either
        a <code className="text-neutral-300">payments_url</code> or a{' '}
        <code className="text-neutral-300">fees</code> object in its NIP-11 info
        document. Paid relays are also a small moat against bots — anyone can
        spam a free relay, but even $10/year filters most of them out.
      </>
    ),
  },
  {
    q: 'What does the "Auth" column mean?',
    a: (
      <>
        An Auth relay uses <span className="text-neutral-100">NIP-42</span> to
        challenge connecting clients, asking you to sign a message proving you
        own the pubkey you're using. Common on private / subscriber relays and
        on relays that block unknown keys. mynostr handles the handshake
        automatically when your logged-in account has access. If you{' '}
        <em>don't</em> have access, the relay silently drops your reads and
        writes — which is why it's worth knowing which of your relays are gated.
      </>
    ),
  },
  {
    q: 'What does the "Search" column mean?',
    a: (
      <>
        Search = <span className="text-neutral-100">NIP-50</span>. A relay
        that supports NIP-50 has indexed event content for keyword search; a
        relay that doesn't can only filter events by their structured fields
        (author pubkey, tags, kind, timestamp). If you ever want to search
        your own history or find a note someone wrote three months ago that
        contained a specific phrase, you need at least one NIP-50 relay in
        your read list. As of 2026 it's still rare — indexing all content is
        expensive to run, so most relays skip it.
      </>
    ),
  },
  {
    q: 'What does the "Vanish" column mean, and why is it rare?',
    a: (
      <>
        Vanish = <span className="text-neutral-100">NIP-62</span>. A relay that
        declares NIP-62 commits to permanently deleting every event tied to
        your pubkey when you ask — it MUST honor the request.
        <div className="mt-2">
          Relays that don't declare Vanish fall back on{' '}
          <span className="text-neutral-100">NIP-09</span>, which is a polite{' '}
          <em>SHOULD delete</em>. Some relays honor NIP-09 requests; some ignore
          them; some can't for technical reasons (append-only storage, no
          delete path). Practically: if you publish something you might later
          regret, the only way to be confident it can be removed is to publish
          only to Vanish relays. Most major relays don't declare NIP-62 — as
          of 2026, Ditto-based relays are the main option.
        </div>
      </>
    ),
  },
  {
    q: 'What does the "Software" column tell me?',
    a: (
      <>
        It shows the relay's codebase as declared in NIP-11. Different stacks
        have real implications for reliability, feature support, and operator
        behavior:
        <ul className="list-disc pl-5 mt-2 space-y-1.5">
          <li>
            <span className="text-neutral-100 font-mono">strfry</span> — C++
            relay by jb55. The most common stack; runs many of the largest
            free relays (damus, nos.lol, relay.primal.net). Fast, efficient,
            battle-tested. Lean feature set — usually no NIP-50 search, no NIP-62.
          </li>
          <li>
            <span className="text-neutral-100 font-mono">khatru</span> — Go
            relay framework by fiatjaf (who created Nostr). Very flexible —
            operators can plug in custom rules (allowlists, payments, moderation).
            Actively developed; common for niche / community relays.
          </li>
          <li>
            <span className="text-neutral-100 font-mono">nostream</span> —
            TypeScript relay backed by Postgres. One of the first "professional"
            relays. Handles payments and NIP-42 auth well; slower than strfry
            under load.
          </li>
          <li>
            <span className="text-neutral-100 font-mono">ditto</span> — Full
            social-media backend that happens to include a relay. Implements
            more of the NIP catalog than anyone else — NIP-50 search, NIP-62
            vanish, moderation tooling. Behaves more like a platform than a
            dumb pipe.
          </li>
          <li>
            <span className="text-neutral-100 font-mono">nostr-rs-relay</span>,{' '}
            <span className="text-neutral-100 font-mono">rnostr</span>,{' '}
            <span className="text-neutral-100 font-mono">nostrpony</span>,{' '}
            <span className="text-neutral-100 font-mono">nosflare</span> —
            smaller projects, often hobby or self-hosted. Feature support varies.
          </li>
          <li>
            <span className="text-neutral-100 font-mono">citrine</span> — a
            relay that runs on your Android phone. Lets you keep a personal
            backup of everything you've ever seen, even if the public relays
            drop it.
          </li>
        </ul>
        <div className="mt-2">
          A healthy relay list has at least 2–3 different stacks. If every
          relay you use runs strfry, a single strfry bug or operator decision
          affects your entire footprint.
        </div>
      </>
    ),
  },
  {
    q: 'Why doesn\'t the table flag "Articles," "Events," or "Market" support?',
    a: (
      <>
        Because the data isn't reliable. Long-form articles (NIP-23), calendar
        events (NIP-52), and marketplace listings (NIP-99) are just event
        kinds — any relay that accepts parameterized replaceable events
        effectively supports them, without any special code. Relay operators
        don't think of those as features worth declaring, so their NIP-11 docs
        are silent on them. Nearly every modern relay handles these kinds fine
        in practice; if one specific kind fails to publish, fall through to
        another relay in your list.
      </>
    ),
  },
  {
    q: 'What is censorship resistance, really?',
    a: (
      <>
        Because Nostr has no central server, no single company can delete your
        identity or your history the way Twitter can. But each individual
        relay <span className="text-neutral-100">can</span> refuse to host your
        events or kick you off. Censorship resistance in Nostr comes from{' '}
        <span className="text-neutral-100">being reachable on many relays</span>
        {' '}— if one drops you, the rest still carry your notes, and your
        followers' clients will keep finding you.
      </>
    ),
  },
  {
    q: 'What happens if a relay goes offline?',
    a: (
      <>
        Your notes on that relay become temporarily unreachable; anyone who
        only reads from it won't see you until it's back. Notes you also
        published to other relays are unaffected. If the relay loses its
        database (disk crash, shutdown), everything you stored <em>only</em>{' '}
        there is gone — which is why mirroring to several relays matters.
      </>
    ),
  },
  {
    q: 'Why do some cells show "—" instead of ✓ or –?',
    a: (
      <>
        A dash means we couldn't reach that relay's NIP-11 info document (it
        didn't respond, blocked our proxy, or returned an error). We'll retry
        in a few minutes. This doesn't mean the relay is down for Nostr
        traffic — some relays happily serve notes but don't publish a NIP-11
        document, or serve it only to specific IPs.
      </>
    ),
  },
]

export default function RelayFAQ() {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="border-t border-neutral-800">
      <button
        type="button"
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-neutral-900/40 transition-colors focus:outline-none focus:ring-1 focus:ring-purple-600"
        aria-expanded={expanded}
      >
        <span className="flex items-baseline gap-2 min-w-0">
          <span className="text-sm font-semibold text-neutral-200">Relay FAQ</span>
          <span className="text-[10px] text-neutral-500 truncate">
            how relays work, and why it matters
          </span>
        </span>
        <span className={`text-neutral-500 text-xs transition-transform shrink-0 ${expanded ? 'rotate-90' : ''}`}>
          ▶
        </span>
      </button>
      {expanded && (
        <div className="px-4 pb-4 space-y-1">
          {ITEMS.map((item, i) => (
            <FAQItem key={i} q={item.q} a={item.a} />
          ))}
        </div>
      )}
    </div>
  )
}

function FAQItem({ q, a }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="border border-neutral-900 rounded-md bg-neutral-950 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left hover:bg-neutral-900/60 transition-colors focus:outline-none focus:ring-1 focus:ring-purple-600"
        aria-expanded={open}
      >
        <span className="text-xs text-neutral-200">{q}</span>
        <span className={`text-neutral-500 text-[10px] shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}>
          ▶
        </span>
      </button>
      {open && (
        <div className="px-3 pb-3 pt-1 text-xs text-neutral-400 leading-relaxed">
          {a}
        </div>
      )}
    </div>
  )
}
