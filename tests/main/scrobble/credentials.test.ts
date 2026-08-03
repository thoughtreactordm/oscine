/**
 * The credential store, including the two cases it exists to get right: no
 * keyring, and a damaged file.
 *
 * The sealer here is a reversible transform rather than real encryption, which
 * is the point — these tests are about *whether the store seals, refuses and
 * forgets at the right moments*, not about whether the OS keyring works. What
 * they can assert about secrecy is the property that matters at this layer: the
 * bytes written to disk are not the bytes handed in.
 */

import { describe, expect, it } from 'vitest'
import {
  CredentialSealingUnavailableError,
  createScrobbleCredentialStore,
  type CredentialFileIo,
  type CredentialSealer
} from '../../../src/main/scrobble/credentials'

/** A file that lives in a variable, so no test touches a disk. */
function memoryIo(initial: string | null = null): CredentialFileIo & { contents: string | null } {
  const io = {
    contents: initial,
    read: (): string | null => io.contents,
    write: (contents: string): void => {
      io.contents = contents
    },
    remove: (): void => {
      io.contents = null
    }
  }
  return io
}

/**
 * A reversible stand-in for `safeStorage`.
 *
 * Reversed rather than merely tagged so that a store which forgot to encrypt
 * would still fail the "not stored in the clear" assertion — a passthrough
 * sealer would let that bug through.
 */
function fakeSealer(available = true): CredentialSealer & { available: boolean } {
  const sealer = {
    available,
    isEncryptionAvailable: (): boolean => sealer.available,
    encryptString: (plain: string): Buffer =>
      Buffer.from([...Buffer.from(plain, 'utf8')].reverse()),
    decryptString: (sealed: Buffer): string => Buffer.from([...sealed].reverse()).toString('utf8')
  }
  return sealer
}

const CREDENTIAL = { username: 'operator', secret: 'session-key-abc123' }

describe('createScrobbleCredentialStore', () => {
  it('round-trips a credential', () => {
    const store = createScrobbleCredentialStore({ sealer: fakeSealer(), io: memoryIo() })
    store.write('lastfm', CREDENTIAL)
    expect(store.read('lastfm')).toEqual(CREDENTIAL)
  })

  it('never writes the secret in the clear', () => {
    const io = memoryIo()
    createScrobbleCredentialStore({ sealer: fakeSealer(), io }).write('lastfm', CREDENTIAL)
    expect(io.contents).not.toContain(CREDENTIAL.secret)
    expect(io.contents).not.toContain(CREDENTIAL.username)
  })

  it('keeps targets apart', () => {
    const store = createScrobbleCredentialStore({ sealer: fakeSealer(), io: memoryIo() })
    store.write('lastfm', CREDENTIAL)
    store.write('listenbrainz', { username: 'other', secret: 'token-xyz' })

    expect(store.read('lastfm')).toEqual(CREDENTIAL)
    expect(store.read('listenbrainz')?.username).toBe('other')

    store.clear('lastfm')
    expect(store.read('lastfm')).toBeNull()
    expect(store.read('listenbrainz')?.username).toBe('other')
  })

  it('removes the file once the last credential is cleared', () => {
    const io = memoryIo()
    const store = createScrobbleCredentialStore({ sealer: fakeSealer(), io })
    store.write('lastfm', CREDENTIAL)
    store.clear('lastfm')
    expect(io.contents).toBeNull()
  })

  it('clearing an absent target is a no-op', () => {
    const io = memoryIo()
    const store = createScrobbleCredentialStore({ sealer: fakeSealer(), io })
    expect(() => store.clear('lastfm')).not.toThrow()
    expect(io.contents).toBeNull()
  })

  it('reads nothing when nothing was written', () => {
    const store = createScrobbleCredentialStore({ sealer: fakeSealer(), io: memoryIo() })
    expect(store.read('lastfm')).toBeNull()
  })

  describe('with no keyring', () => {
    it('refuses to write rather than storing plaintext', () => {
      const io = memoryIo()
      const store = createScrobbleCredentialStore({ sealer: fakeSealer(false), io })

      expect(() => store.write('lastfm', CREDENTIAL)).toThrow(CredentialSealingUnavailableError)
      // The load-bearing half of that assertion: nothing was written at all.
      expect(io.contents).toBeNull()
    })

    it('reports itself unavailable so a caller can say so before a sign-in', () => {
      const store = createScrobbleCredentialStore({ sealer: fakeSealer(false), io: memoryIo() })
      expect(store.available()).toBe(false)
    })

    it('reads a stored credential as absent rather than throwing', () => {
      const sealer = fakeSealer()
      const io = memoryIo()
      const store = createScrobbleCredentialStore({ sealer, io })
      store.write('lastfm', CREDENTIAL)

      // The keyring went away between one launch and the next.
      sealer.available = false
      expect(store.read('lastfm')).toBeNull()

      // And comes back, without the credential having been touched.
      sealer.available = true
      expect(store.read('lastfm')).toEqual(CREDENTIAL)
    })

    it('is re-read live, so a keyring unlocked after launch just works', () => {
      const sealer = fakeSealer(false)
      const store = createScrobbleCredentialStore({ sealer, io: memoryIo() })
      expect(store.available()).toBe(false)
      sealer.available = true
      expect(store.available()).toBe(true)
      expect(() => store.write('lastfm', CREDENTIAL)).not.toThrow()
    })
  })

  describe('with a damaged file', () => {
    it.each([
      ['not JSON at all', 'half a wri'],
      ['JSON that is not an object', '"nonsense"'],
      ['an object with no targets', '{"version":1}'],
      ['targets that is not an object', '{"version":1,"targets":7}'],
      ['a target whose value is not a string', '{"version":1,"targets":{"lastfm":42}}']
    ])('treats %s as no credential', (_case, contents) => {
      const store = createScrobbleCredentialStore({ sealer: fakeSealer(), io: memoryIo(contents) })
      expect(store.read('lastfm')).toBeNull()
    })

    it('treats an unsealable blob as no credential', () => {
      const sealer = fakeSealer()
      const store = createScrobbleCredentialStore({
        // Sealed by another machine's keyring: valid base64, not our plaintext.
        sealer: { ...sealer, decryptString: () => 'not json' },
        io: memoryIo('{"version":1,"targets":{"lastfm":"YWJj"}}')
      })
      expect(store.read('lastfm')).toBeNull()
    })

    it('drops an unknown target id rather than carrying it forward', () => {
      const io = memoryIo('{"version":1,"targets":{"myspace":"YWJj"}}')
      const store = createScrobbleCredentialStore({ sealer: fakeSealer(), io })
      store.write('lastfm', CREDENTIAL)
      expect(io.contents).not.toContain('myspace')
      expect(store.read('lastfm')).toEqual(CREDENTIAL)
    })

    it('a write repairs it rather than being lost to it', () => {
      const io = memoryIo('half a wri')
      const store = createScrobbleCredentialStore({ sealer: fakeSealer(), io })
      store.write('lastfm', CREDENTIAL)
      expect(store.read('lastfm')).toEqual(CREDENTIAL)
    })
  })
})
