import { randomBytes } from 'node:crypto'
import {
  CredentialSealingUnavailableError,
  type CredentialFileIo,
  type CredentialSealer
} from '../scrobble/credentials'

/**
 * The agent server's bearer token — **W24-2**, `oscine-mcp` → D36.1.
 *
 * Generated on first enable, sealed with `safeStorage`, and read back only in
 * main. It follows D19's rule for the scrobbling credentials exactly, and reuses
 * that file's sealer and I/O seams rather than restating them: not a settings
 * row, not in `library.db`, not in a profile or D11's bundle
 * (`AGENT_TOKEN_ARTIFACT` is `derived`), and no plaintext fallback when there
 * is no keyring — the server refuses to start instead, and says why.
 *
 * Unlike a scrobbling secret, the token does cross IPC, once, on request: the
 * operator has to copy it into an agent's config, and that is the whole point of
 * showing it (D36.1). It never rides the status broadcast.
 */
export interface AgentTokenStore {
  /** Whether a token could be sealed right now. Read live, never cached. */
  available(): boolean
  /** The stored token, or null when none exists or it cannot be unsealed. */
  read(): string | null
  /**
   * The stored token, generating and sealing one first if there is none.
   * Throws `CredentialSealingUnavailableError` when it cannot seal.
   */
  ensure(): string
  /** Replace the token. Throws `CredentialSealingUnavailableError` like `ensure`. */
  regenerate(): string
}

const FORMAT_VERSION = 1

/** 32 random bytes: far past guessable, and URL- and header-safe as base64url. */
export function generateAgentToken(): string {
  return randomBytes(32).toString('base64url')
}

export function createAgentTokenStore({
  sealer,
  io,
  generate = generateAgentToken
}: {
  sealer: CredentialSealer
  io: CredentialFileIo
  generate?: () => string
}): AgentTokenStore {
  const read = (): string | null => {
    const raw = io.read()
    if (raw === null || !sealer.isEncryptionAvailable()) return null
    try {
      const parsed: unknown = JSON.parse(raw)
      const sealed = (parsed as { token?: unknown } | null)?.token
      if (typeof sealed !== 'string') return null
      const token = sealer.decryptString(Buffer.from(sealed, 'base64'))
      return token.length > 0 ? token : null
    } catch {
      // Damaged, or sealed under another user's keyring: treated as no token,
      // so the next enable generates a fresh one rather than refusing to start.
      return null
    }
  }

  const write = (token: string): string => {
    if (!sealer.isEncryptionAvailable()) throw new CredentialSealingUnavailableError()
    const sealed = sealer.encryptString(token).toString('base64')
    io.write(JSON.stringify({ version: FORMAT_VERSION, token: sealed }))
    return token
  }

  return {
    available: () => sealer.isEncryptionAvailable(),
    read,
    ensure: () => read() ?? write(generate()),
    regenerate: () => write(generate())
  }
}
