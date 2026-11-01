import { describe, expect, it } from 'vitest'
import { CredentialSealingUnavailableError } from '../../../src/main/scrobble/credentials'
import { createAgentTokenStore, generateAgentToken } from '../../../src/main/mcp/tokenStore'

/** W24-2: the agent token is sealed like D19's credentials, with no plaintext fallback. */
function fakeSealer(available = { value: true }) {
  return {
    isEncryptionAvailable: () => available.value,
    encryptString: (plain: string) => Buffer.from(`sealed:${plain}`, 'utf8'),
    decryptString: (sealed: Buffer) => {
      const text = sealed.toString('utf8')
      if (!text.startsWith('sealed:')) throw new Error('not ours')
      return text.slice('sealed:'.length)
    }
  }
}

function memoryIo() {
  const box = { contents: null as string | null }
  return {
    box,
    io: {
      read: () => box.contents,
      write: (contents: string) => {
        box.contents = contents
      },
      remove: () => {
        box.contents = null
      }
    }
  }
}

describe('agent token store', () => {
  it('generates and seals a token on first ensure, then returns the same one', () => {
    const { box, io } = memoryIo()
    let n = 0
    const store = createAgentTokenStore({ sealer: fakeSealer(), io, generate: () => `t${++n}` })

    expect(store.read()).toBeNull()
    expect(store.ensure()).toBe('t1')
    expect(store.ensure()).toBe('t1')
    expect(store.read()).toBe('t1')
    // Sealed on disk, never the plaintext.
    expect(box.contents).not.toContain('"t1"')
    expect(box.contents).toContain(Buffer.from('sealed:t1').toString('base64'))
  })

  it('regenerate replaces the token', () => {
    const { io } = memoryIo()
    let n = 0
    const store = createAgentTokenStore({ sealer: fakeSealer(), io, generate: () => `t${++n}` })
    store.ensure()
    expect(store.regenerate()).toBe('t2')
    expect(store.read()).toBe('t2')
  })

  it('refuses to write without a keyring, and reads nothing', () => {
    const { box, io } = memoryIo()
    const available = { value: false }
    const store = createAgentTokenStore({ sealer: fakeSealer(available), io })
    expect(store.available()).toBe(false)
    expect(() => store.ensure()).toThrow(CredentialSealingUnavailableError)
    expect(() => store.regenerate()).toThrow(CredentialSealingUnavailableError)
    expect(box.contents).toBeNull()
  })

  it('treats a damaged or foreign file as no token', () => {
    const { box, io } = memoryIo()
    const store = createAgentTokenStore({ sealer: fakeSealer(), io, generate: () => 'fresh' })
    box.contents = '{not json'
    expect(store.read()).toBeNull()
    box.contents = JSON.stringify({ version: 1, token: Buffer.from('other').toString('base64') })
    expect(store.read()).toBeNull()
    expect(store.ensure()).toBe('fresh')
  })

  it('generates long, header-safe tokens', () => {
    const token = generateAgentToken()
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(generateAgentToken()).not.toBe(token)
  })
})
