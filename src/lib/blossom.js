import { getNDK } from './ndk.js'
import { NDKEvent } from '@nostr-dev-kit/ndk'

const BLOSSOM_SERVER = 'https://blossom.primal.net'

async function sha256Hex(buffer) {
  if (!crypto?.subtle) {
    throw new Error('Image upload requires HTTPS or localhost. LAN access over HTTP is not supported.')
  }
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer)
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

// Builds and signs a NIP-94 / BUD-02 kind 24242 auth event for a single upload
async function buildAuthEvent(fileHash) {
  const ndk = getNDK()
  const expiration = Math.floor(Date.now() / 1000) + 60 * 5 // 5 min window

  const event = new NDKEvent(ndk)
  event.kind = 24242
  event.content = 'Upload image'
  event.tags = [
    ['t', 'upload'],
    ['x', fileHash],
    ['expiration', String(expiration)],
  ]
  await event.sign()
  return JSON.stringify(await event.toNostrEvent())
}

// Uploads a File to the Primal blossom server and returns the public URL.
// Throws on network error or non-2xx response.
export async function uploadToBlossom(file) {
  const buffer = await file.arrayBuffer()
  const hash = await sha256Hex(buffer)
  const authEventJson = await buildAuthEvent(hash)
  const authHeader = 'Nostr ' + btoa(authEventJson)

  const res = await fetch(`${BLOSSOM_SERVER}/upload`, {
    method: 'PUT',
    headers: {
      'Authorization': authHeader,
      'Content-Type': file.type || 'application/octet-stream',
    },
    body: buffer,
  })

  if (!res.ok) {
    const msg = await res.text().catch(() => '')
    throw new Error(`Blossom upload failed (${res.status})${msg ? ': ' + msg : ''}`)
  }

  const data = await res.json()
  const url = data.url || data.nip94_event?.tags?.find(t => t[0] === 'url')?.[1]
  if (!url) throw new Error('Blossom response missing URL')
  return url
}
