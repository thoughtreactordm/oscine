import { describe, expect, it } from 'vitest'
import { checkMcpRequest } from '../../../src/main/mcp/requestGuard'

/**
 * The agent server's front door — **W24-1**, `oscine-mcp` → D36.1. Pure over the
 * headers; `server.test.ts` proves the same refusals reach the wire.
 */
describe('checkMcpRequest', () => {
  const config = { port: 47318, token: 'secret-token' }
  const good = { host: '127.0.0.1:47318', authorization: 'Bearer secret-token' }

  it('admits a loopback Host with the right bearer token and no Origin', () => {
    expect(checkMcpRequest(good, config)).toBeNull()
    expect(checkMcpRequest({ ...good, host: 'localhost:47318' }, config)).toBeNull()
    expect(checkMcpRequest({ ...good, authorization: 'bearer secret-token' }, config)).toBeNull()
  })

  it('refuses a missing, malformed or wrong token', () => {
    for (const authorization of [undefined, '', 'secret-token', 'Basic c2VjcmV0', 'Bearer nope']) {
      expect(checkMcpRequest({ ...good, authorization }, config)?.status).toBe(401)
    }
  })

  it('refuses every token when none is configured', () => {
    expect(
      checkMcpRequest({ ...good, authorization: 'Bearer ' }, { ...config, token: '' })
    ).not.toBeNull()
  })

  it('refuses any Origin, including loopback and the opaque null', () => {
    for (const origin of ['https://evil.example', 'http://127.0.0.1:47318', 'null']) {
      expect(checkMcpRequest({ ...good, origin }, config)?.status).toBe(403)
    }
  })

  it('refuses a foreign, missing or wrong-port Host — the DNS-rebinding case', () => {
    for (const host of [
      undefined,
      'evil.example:47318',
      '127.0.0.1',
      '127.0.0.1:80',
      '[::1]:47318'
    ]) {
      expect(checkMcpRequest({ ...good, host }, config)?.status).toBe(421)
    }
  })
})
