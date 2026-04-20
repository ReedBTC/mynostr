import { useState } from 'react'

/**
 * RelayFAQ — collapsible primer appended to the bottom of RelayCard.
 *
 * Most users (even long-time Nostr users) have a fuzzy mental model of
 * relays. This component answers the questions we see asked most often,
 * in plain language, so a user reading someone's profile can click
 * through to understand what the table above actually means.
 *
 * Each question is independently collapsible so the FAQ doesn't dominate
 * vertical space by default. The top-level header toggles the whole
 * section visible/hidden.
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
    q: 'How should I pick my relays?',
    a: (
      <>
        Favor diversity: pick relays run by different operators, in different
        countries, with a mix of paid and free. If all your relays are
        operated by the same team or hosted on the same cloud provider,
        one takedown, outage, or policy change can silence you everywhere
        at once. Paid relays usually have better uptime and stricter spam
        filtering; free relays are lower friction and more numerous.
      </>
    ),
  },
  {
    q: 'What does the "Paid" badge mean?',
    a: (
      <>
        Some relays charge a small one-time or recurring fee to accept your
        writes. In exchange you typically get better uptime, less spam, and
        longer event retention. Paid status is declared by the relay itself in
        its NIP-11 info document (via <code className="text-neutral-300">payments_url</code>{' '}
        or a <code className="text-neutral-300">fees</code> object).
      </>
    ),
  },
  {
    q: 'What does the "Auth" badge mean?',
    a: (
      <>
        An Auth relay uses <span className="text-neutral-100">NIP-42</span> to
        challenge connecting clients to prove ownership of a pubkey before
        reading or writing. This is common on private/subscriber relays and on
        relays that throttle unknown keys. mynostr handles the auth handshake
        automatically when your logged-in account is permitted.
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
    q: 'What is "Right to Vanish" (NIP-62) vs. regular deletion (NIP-09)?',
    a: (
      <>
        <span className="text-neutral-100">NIP-09</span> is a polite request:
        the relay <em>should</em> delete an event when you ask, but many
        don't, and some can't. <span className="text-neutral-100">NIP-62</span>{' '}
        is stricter — relays that support it <em>MUST</em> permanently delete
        every event tied to your pubkey on request. If your right-to-delete
        matters to you, prefer relays that explicitly support NIP-62.
      </>
    ),
  },
  {
    q: 'Why do some cells show "—" instead of ✓ or –?',
    a: (
      <>
        A dash means we couldn't reach that relay's NIP-11 info document (it
        didn't respond, blocked the request via CORS, or returned an error).
        We'll retry in a few minutes. This doesn't mean the relay is down for
        Nostr traffic — it just means it didn't publish its capabilities at
        the HTTPS endpoint.
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
