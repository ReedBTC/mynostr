/**
 * Self-encrypt / self-decrypt arbitrary strings using whatever signer the
 * current NDK session has. Used to protect the NWC connection URI at rest:
 * we encrypt it *to ourselves* before writing to localStorage, so the
 * stored ciphertext is useless without the user's signer.
 *
 * Works across every login method the app supports (NIP-07 extension,
 * raw nsec via NDKPrivateKeySigner, NIP-46 bunker via wrapped BunkerSigner).
 * All of them implement the NDKSigner ABI:
 *   signer.encrypt(recipientUser, plaintext, 'nip44'|'nip04')
 *   signer.decrypt(senderUser, ciphertext, 'nip44'|'nip04')
 *
 * Recipient is the user themselves — encrypt(self, ...) for both sides.
 * `selfUser` MUST be an NDK user object (ndk.getUser({pubkey})) — never a
 * raw hex string. NDK's Nip07Signer reads .pubkey off the recipient and
 * silently fails on strings.
 *
 * Tries NIP-44 first (modern, authenticated). Falls back to NIP-04 on
 * signers that don't expose NIP-44 (rare in 2026 but still seen on older
 * extensions and some bunker apps). Both produce ciphertext-with-iv as
 * a single base64-ish string we can shove in localStorage.
 *
 * The schema marker ('44:'/'04:') is prepended so decrypt can pick the
 * right scheme without trial-and-error round-trips through the signer.
 */

const NIP44_PREFIX = '44:'
const NIP04_PREFIX = '04:'

async function supports(signer, scheme) {
  try {
    if (typeof signer.encryptionEnabled !== 'function') return true
    const list = await signer.encryptionEnabled(scheme)
    if (Array.isArray(list)) return list.includes(scheme)
    return true
  } catch {
    return true
  }
}

export async function encryptForSelf(signer, selfUser, plaintext) {
  if (!signer) throw new Error('No signer available for encryption')
  if (!selfUser) throw new Error('No self-user available for encryption')

  if (await supports(signer, 'nip44')) {
    try {
      const ct = await signer.encrypt(selfUser, plaintext, 'nip44')
      // Silent-fallback detection: some older NIP-07 builds and a few
      // bunkers ignore the requested scheme and return NIP-04 ciphertext
      // (which always contains '?iv=') instead of throwing on
      // unsupported NIP-44. Tag with the actual scheme so decrypt picks
      // the right one — otherwise we'd persist as '44:' and fail to
      // unlock on next session.
      if (typeof ct === 'string' && ct.includes('?iv=')) {
        return NIP04_PREFIX + ct
      }
      return NIP44_PREFIX + ct
    } catch {
      // explicit NIP-44 failure — fall through to nip04
    }
  }

  const ct = await signer.encrypt(selfUser, plaintext, 'nip04')
  return NIP04_PREFIX + ct
}

export async function decryptFromSelf(signer, selfUser, ciphertext) {
  if (!signer) throw new Error('No signer available for decryption')
  if (!selfUser) throw new Error('No self-user available for decryption')
  if (typeof ciphertext !== 'string' || ciphertext.length < 4) {
    throw new Error('Ciphertext is empty or malformed')
  }

  if (ciphertext.startsWith(NIP44_PREFIX)) {
    return signer.decrypt(selfUser, ciphertext.slice(NIP44_PREFIX.length), 'nip44')
  }
  if (ciphertext.startsWith(NIP04_PREFIX)) {
    return signer.decrypt(selfUser, ciphertext.slice(NIP04_PREFIX.length), 'nip04')
  }
  throw new Error('Ciphertext missing scheme prefix')
}
