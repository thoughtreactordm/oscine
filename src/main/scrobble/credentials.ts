/**
 * Where a scrobbling credential lives, and the one rule about it — **D19**.
 *
 * The rule is that the secret is sealed by Electron's `safeStorage` and is read
 * back only in main, only by the target that owns it. It is not a settings row,
 * it is not in `library.db`, it is not in D11's bundle, and it never crosses
 * IPC. This is the first use of `safeStorage` in Oscine, so this file is the
 * pattern rather than one instance of it.
 *
 * ## Why the username is sealed too
 *
 * It is not a secret, and the settings pane needs it. Sealing it anyway costs
 * nothing and buys one property worth having: there is exactly one thing in this
 * file, so there is exactly one rule about it. A format with a plaintext half
 * and an encrypted half is a format where the next field has to be argued about,
 * and the argument is settled by whoever is in a hurry.
 *
 * ## When there is no keyring
 *
 * `safeStorage.isEncryptionAvailable()` is false on a Linux box with no keyring
 * — a bare window manager, a container, a live session. Oscine refuses to
 * connect and says why. The alternative is writing a session key in plaintext
 * into a file whose whole reason for existing is that it is not plaintext, and
 * an operator who was told "your credentials are stored securely" would have no
 * way of knowing that this install quietly meant something else. Refusing is
 * recoverable — install a keyring, connect again. A plaintext fallback is not
 * recoverable, because nobody knows it happened.
 *
 * That check is made live on every read and every write rather than cached at
 * startup, for `net/consent.ts`' reason: a keyring unlocked five minutes after
 * launch should just work, and there is no invalidation path to get wrong.
 *
 * *Which* keyring `safeStorage` looks for is decided before any of this, in
 * `main/passwordStore.ts`. It matters here because the two failures are easy to
 * confuse: on a session Chromium does not recognise — Hyprland, sway, river —
 * `isEncryptionAvailable()` is false whether or not a keyring is running, and an
 * operator who reads this file's error as "install a keyring" will install one
 * and see no change at all.
 *
 * ## Injected, not imported
 *
 * `safeStorage` and the filesystem arrive as parameters. Electron's module is
 * not loadable under Vitest and `safeStorage` needs a live keyring even when it
 * is, so a store that reached for either directly would be a store with no
 * tests — which, for the file that holds the credentials, is the wrong file to
 * leave untested.
 */

import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import type { ScrobbleTargetId } from '@shared/scrobble'
import { SCROBBLE_TARGET_IDS } from '@shared/scrobble'

/** What one target's sign-in produced. Never leaves main (D19). */
export interface ScrobbleCredential {
  /** The account name. The only half of this the renderer is ever told. */
  readonly username: string
  /**
   * The credential proper: Last.fm's session key, ListenBrainz's user token.
   *
   * Named for what it is rather than for either service's word, because W11-8
   * stores a differently-shaped string here under the same rule and a field
   * called `sessionKey` would invite a second field beside it.
   */
  readonly secret: string
}

/**
 * The half of Electron's `safeStorage` this needs.
 *
 * Structurally identical to the real thing, so `safeStorage` itself is a legal
 * argument and a test's stand-in is three functions.
 */
export interface CredentialSealer {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

/** The file operations this needs, so a test never touches a disk. */
export interface CredentialFileIo {
  /** The file's contents, or `null` when it does not exist. */
  read(): string | null
  /** Replace the file's contents atomically. */
  write(contents: string): void
  remove(): void
}

/**
 * Thrown when a credential cannot be sealed, and therefore must not be written.
 *
 * A distinct type rather than a `NetFailure` because it is not a network
 * condition: nothing was attempted and nothing will be. The target catches it at
 * the end of `authorize` and turns it into a failure the pane can render.
 */
export class CredentialSealingUnavailableError extends Error {
  constructor() {
    super(
      'This system has no secure credential store available, so Oscine will not save a ' +
        'sign-in. On Linux, a keyring being installed is not enough on its own: it also has ' +
        'to have been created and unlocked. The usual cause is a login keyring that no login ' +
        'ever unlocks — check that ~/.local/share/keyrings holds one, and that your display ' +
        'manager is set up to unlock it when you log in.'
    )
    this.name = 'CredentialSealingUnavailableError'
  }
}

export interface ScrobbleCredentialStore {
  /** Whether a credential could be sealed right now. Read live, never cached. */
  available(): boolean
  /** The stored credential for a target, or `null`. Never fails outward. */
  read(target: ScrobbleTargetId): ScrobbleCredential | null
  /** Seal and store. Throws `CredentialSealingUnavailableError` if it cannot. */
  write(target: ScrobbleTargetId, credential: ScrobbleCredential): void
  /** Forget one target's credential. Idempotent. */
  clear(target: ScrobbleTargetId): void
}

/** The on-disk shape. Versioned so a future format has somewhere to branch. */
const FORMAT_VERSION = 1

interface CredentialFile {
  version: number
  /** Target id to base64 of the sealed `ScrobbleCredential` JSON. */
  targets: Record<string, string>
}

function isTargetId(value: string): value is ScrobbleTargetId {
  return (SCROBBLE_TARGET_IDS as readonly string[]).includes(value)
}

/**
 * Parse defensively: a damaged file is treated as no file.
 *
 * The worst case of misreading this file is signing the operator out, which
 * costs one browser round trip. The worst case of throwing on it is an app that
 * will not start because of a truncated write during a power cut, so every
 * unreadable shape here resolves to "nothing stored" rather than to an error.
 */
function parseFile(raw: string | null): CredentialFile {
  const empty: CredentialFile = { version: FORMAT_VERSION, targets: {} }
  if (raw === null) return empty
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return empty
    const { targets } = parsed as { targets?: unknown }
    if (typeof targets !== 'object' || targets === null) return empty

    const kept: Record<string, string> = {}
    for (const [key, value] of Object.entries(targets as Record<string, unknown>)) {
      if (isTargetId(key) && typeof value === 'string') kept[key] = value
    }
    return { version: FORMAT_VERSION, targets: kept }
  } catch {
    return empty
  }
}

export function createScrobbleCredentialStore({
  sealer,
  io
}: {
  sealer: CredentialSealer
  io: CredentialFileIo
}): ScrobbleCredentialStore {
  const load = (): CredentialFile => parseFile(io.read())

  const save = (file: CredentialFile): void => {
    // An empty map removes the file rather than writing `{"targets":{}}`. The
    // operator's "disconnect everything" should leave nothing behind on disk to
    // wonder about, and an absent file is the same state as an empty one.
    if (Object.keys(file.targets).length === 0) {
      io.remove()
      return
    }
    io.write(JSON.stringify(file))
  }

  return {
    available: (): boolean => sealer.isEncryptionAvailable(),

    read: (target): ScrobbleCredential | null => {
      const sealed = load().targets[target]
      if (sealed === undefined) return null
      // Checked here as well as at write time because the two are separated by a
      // restart: a keyring that was running when the credential was stored may
      // not be running now, and that is a "not connected", not a crash.
      if (!sealer.isEncryptionAvailable()) return null
      try {
        const plain: unknown = JSON.parse(sealer.decryptString(Buffer.from(sealed, 'base64')))
        if (typeof plain !== 'object' || plain === null) return null
        const { username, secret } = plain as { username?: unknown; secret?: unknown }
        if (typeof username !== 'string' || typeof secret !== 'string') return null
        if (secret === '') return null
        return { username, secret }
      } catch {
        // Sealed by a different user, a different machine, or a keyring that has
        // since been reset. Not recoverable and not an error worth surfacing:
        // the operator is simply signed out and can sign in again.
        return null
      }
    },

    write: (target, credential): void => {
      if (!sealer.isEncryptionAvailable()) throw new CredentialSealingUnavailableError()
      const file = load()
      file.targets[target] = sealer
        .encryptString(JSON.stringify({ username: credential.username, secret: credential.secret }))
        .toString('base64')
      save(file)
    },

    clear: (target): void => {
      const file = load()
      if (!(target in file.targets)) return
      delete file.targets[target]
      save(file)
    }
  }
}

/**
 * The real filesystem, with two properties the store depends on.
 *
 * **Atomic replacement.** A partial write leaves an unparseable file, and an
 * unparseable file signs the operator out of every target at once — so the new
 * contents land under a temporary name and are renamed over the old ones, which
 * is atomic within a directory on both platforms.
 *
 * **Owner-only on creation.** `0o600` is honoured on Linux and ignored on
 * Windows, where the inherited ACL under `userData` is already per-user. It is
 * belt to `safeStorage`'s braces: the bytes are sealed regardless, and a file
 * mode is cheap enough not to argue about.
 */
export function createCredentialFileIo(filePath: string): CredentialFileIo {
  const temporaryPath = `${filePath}.tmp`
  return {
    read: (): string | null => {
      try {
        return readFileSync(filePath, 'utf8')
      } catch {
        return null
      }
    },
    write: (contents): void => {
      writeFileSync(temporaryPath, contents, { encoding: 'utf8', mode: 0o600 })
      renameSync(temporaryPath, filePath)
    },
    remove: (): void => {
      rmSync(filePath, { force: true })
      rmSync(temporaryPath, { force: true })
    }
  }
}
