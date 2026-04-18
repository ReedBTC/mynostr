# MyNostr — Vision & Ideas

*Organized notes pulled from four voice-memo transcripts. Wherever possible the original phrasing is preserved.*

---

## 1. The Core Vision: "MyNostr is your web page"

> "My Nostr is your web page. If you log into my Nostr with your NSEC, you get to build and curate your web page. And all it is, is your Nostr feeds for yourself only."

The product is **one product, not two** — a landing page + editor, unified. Log in with your NSEC and you unlock all the editors. Don't log in, and you're looking at somebody's curated public page.

### The landing page
Built from your **kind 0**:
- Bio, picture, NIP-05, lightning address, website
- Relay list is there, but buried — it's about your profile, who you are
- From the landing page, options to click into:
  - Your social feed (just your kind 1 notes)
  - Your long-form posts (just what you've written)
  - Your events
  - Your stuff for sale
  - Your recipes
  - etc.

### The tagline
> "It's where you go to get all your stuff. You have other social media apps to get everybody else's stuff. But where do you go for your stuff?"

### What it is NOT
- **Not social media.** "This isn't social media. This is the anti-social media. This is the everything else."
- **Not a feed.** "I don't want to be a feed." Building a good feed means building out all the infrastructure Primal has — not happening.
- Actually: it's not even "the everything else," *"because they're all just notes."*

### The bigger frame
> "Nostr is not social media. Nostr is your portal into a new internet. A new internet. A place where you can't be censored. A place where there are no restrictions. No paywalls. You own all of your data. No ads. Just your stuff. This is the way. The new internet."

> **"MyNostr is a Nostr advertisement."** It's to show you everything that you can do with Nostr. "You don't have to fucking come live here. But there's tons of stuff you can do here that no one's doing."

---

## 2. The Share Button — Everything Is Just a Link

The share model is dead simple: every piece of your stuff has a public URL. Drop that link wherever you want.

- Long-form article → "Hey, go check out my latest article." Drop it in the feed.
- Event coming up → "Here's the URL. This is your event page. Share this wherever you want."
- For sale → "Here's your for sale link. Actually, here's the whole storefront. Your storefront."
- Cool kind 1 note from two years ago → "Well, here you go. Here's a link to it."

> "It's just a link to your stuff. And if somebody wants to come to your page and check out all your stuff, they can come to your page and check out all your stuff all in one spot. It's all curated. It's your stuff."

Works great on your existing social media feeds — you already have Twitter, Instagram, whatever. Drop the MyNostr link in there.

---

## 3. Module Priority Shift: Profile Comes Next

> "I think the next module is going to be the profile module, of all things. I thought that would be like last, but I think it's not."

The profile module is the landing page, and the landing page is the whole thesis of the product. Building it next makes the whole vision visible.

---

## 4. Onboarding — the Reluctant Module

The honest read:
> "I don't want to do onboarding. I don't want to do feeds. No feeds. Discoverability, fine."

But also:
> "Fuck, I kind of feel like I need to do onboarding. Because no one's done a good job of it yet. I think I could come up with some kind of a flow that would make sense."

### The "new Nostr experience" pitch
When a new user onboards, MyNostr opens them to their **dashboard** — their profile, their social feed, their long-form posts, their events, their stuff for sale, their recipes. Their stuff.

> "And then it's like oh but I don't have any stuff. Right? All my stuff is all empty. And it's like okay well you know let's get you some stuff."

No long form? Write one — here you go. Then share it. That's the flow.

### Two possible approaches to the account problem
1. **Punt it.** "Don't have an account yet? Go fucking send them to Primal's login. Make an account with Primal. Make an account with [another client]." Then come back.
2. **Own it with follow-packs** (see §5).

### Relay education as onboarding
From idea004 — the explanation of relays that actually works:
> "All Nostr is, is posting notes to relays who promise to share publicly. That's it. You're just publishing notes to relays who promise not to censor you. And if you publish to enough relays who promise not to censor you, all it takes is one of them to not censor you. If you follow 100 relays and 99 censor you, that one that you're following will maintain your notes as public for the entire network."

> "See, that's how you explain relays."

Onboarding should teach this AND give people tools to act on it:
- **Filter by relay policies**
- **Filter by relay statistics**
- **"Web of trust for relays"** — which relays do my friends use?
  - If Primal Index exposes a person's relay list, use it. "Like their relay list, which is a kind of whatever note."

The standard conversation we want to create:
> "When someone says, 'Oh, you should find me on Nostr,' they should say, 'Oh, you're on Nostr? Who do you publish to? … What relays do you publish to?'"

---

## 5. Follow-Packs as the Onboarding Mechanism

> "Followpacks are underutilized. And I feel like they're begging for automation and customization."
>
> "That's how you do it. That's the onboarding flow. You just make your own followpacks. You programmatically build your own followpacks."

Contrast with Primal: **no defaults.** Make it harder, not easier — in a good way. Force real choice.

### Ideas for programmatic follow-packs
- Web-of-trust-based packs
- Automated packs built from Primal indexer API data
- **"Fad zappers"** — "the people who zap fad zappers should be the most popular people on Nostr… the person who gives out the most. That's the people who everyone should want to follow."

### Open questions
- How much data is available from the Primal API?
- Can we programmatically design, monitor, and edit follow-packs?
- "Dude, followpacks are about to get mega spammed."

---

## 6. Publishing, Not Posting

Language matters. From idea003:
> "You should publish notes. Not post notes. Not share notes. **Publish.** It's a much more formal action than you think. When you publish something, Dinosaur, you've published it. It's now public."

The UX should make it clear: **this is going to be open forever.** No matter how much the UI of other clients implies there's a delete button — there is no fucking delete button.

### Delete button policy (for MyNostr)
- Every module needs a delete button — long-form, notes, events, all of it.
- Delete button comes with a **warning right on the label**: your note may still be on relays that don't respect deletions.
- Tell the user: contact that relay directly. Surface the relay's contact email if public, otherwise link to the relay's website.
- **Only recommend relays that accept/respect note deletions.** If your relay doesn't respect deletions, MyNostr is not recommending it during onboarding.

---

## 7. Content Discovery — Send People Elsewhere

We are not building feeds. The **"Find Content"** button for each module just takes you somewhere else that's already good at it.

- Long-form → send to **Hubla.news**, **Highlighter**, etc.
- Recipes → send to **zap.cooking**
- Looking for another Nostr client generally → link to **Aljaz's giant list**

> "That's an idea for a… how do you do content discovery?"

Use this pattern wherever a module has an empty state (e.g. Events tab with no events favorited yet).

---

## 8. Podcasting 2.0 Client (Future Module)

> "We can use it also to fix podcasting 2.0."

The idea: a **Podcasting 2.0 tab** in MyNostr — not primarily for podcasters (most people aren't), but as a place to **manage your podcast favorites**.

### The mechanism
- Favorites stored on Nostr as arbitrary-data notes ("you can just store whatever the fuck you want on Nostr. Like little bits of text like that.")
- Discoverability button, like every other module
- Would require cooperation from existing podcast apps (Fountain, etc.) to publish the user's favorited shows under their NPUB with the right kind — with an option for **public vs. private** lists
- If Fountain would publish that list, MyNostr picks it up and renders a podcast favorites page

### The fallback plan
> "Are there open source podcasts? Like, can I fork a podcast repo? And just build my own podcasting 2.0 fucking site? Just for the discoverability? So I have a place to send people that actually saves this shit this way?"

Long-term:
> "That's going to be a feature when we eventually build a podcasting 2.0 client. That's how it's going to do everything. It's on Nostr. The whole thing is going to be Nostr."

Framing: **"Fix podcasting 2.0 with MyNostr."** MyNostr-as-Podcasting-2.0-Nostr-client.

---

## 9. Naming

> "Dude, how did I come up with the... I came up with the name before I came up with the idea. How fucking weird is that, dude?"

Name stays. MyNostr.

---

## 10. Summary of Open Questions / TODOs

- How much data is exposed by the Primal API for follow-pack automation?
- Can we programmatically create/edit/monitor follow-packs?
- Do all relays have a public contact (email or website) we can surface on delete warnings?
- Is a user's relay list queryable through the Primal index?
- Fork an open-source podcast app for the Podcasting 2.0 module, or wait?
- How to handle the "make an account" button — popup, redirect-and-return, or just send to Primal?

---

## 11. One-Line Positioning Candidates (pulled from your own words)

- *"Where do you go for your stuff?"*
- *"The anti-social media."*
- *"Your portal into a new internet."*
- *"A Nostr advertisement."*
- *"It's all curated. It's your stuff."*
- *"This is the way. The new internet."*
