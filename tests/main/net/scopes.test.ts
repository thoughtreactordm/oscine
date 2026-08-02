import { describe, expect, it } from 'vitest'
import {
  createScopeRegistry,
  RequestTimeoutError,
  ScopeCancelledError
} from '../../../src/main/net/scopes'

describe('createScopeRegistry', () => {
  it('aborts every enrolled request when the scope is cancelled', () => {
    const scopes = createScopeRegistry()
    const one = scopes.enter('tunedeck')
    const two = scopes.enter('tunedeck')

    expect(scopes.size('tunedeck')).toBe(2)
    expect(scopes.cancel('tunedeck')).toBe(2)

    expect(one.signal.aborted).toBe(true)
    expect(two.signal.aborted).toBe(true)
    expect(one.signal.reason).toBeInstanceOf(ScopeCancelledError)
    expect((one.signal.reason as ScopeCancelledError).scope).toBe('tunedeck')
  })

  it('leaves a released request alone', () => {
    const scopes = createScopeRegistry()
    const done = scopes.enter('tunedeck')
    const live = scopes.enter('tunedeck')

    done.release()
    expect(scopes.size('tunedeck')).toBe(1)
    expect(scopes.cancel('tunedeck')).toBe(1)

    expect(done.signal.aborted).toBe(false)
    expect(live.signal.aborted).toBe(true)
  })

  it('survives a listener that releases while the scope is being cancelled', () => {
    const scopes = createScopeRegistry()
    const first = scopes.enter('tunedeck')
    const second = scopes.enter('tunedeck')
    // Exactly what the client's `finally` does, arriving mid-walk.
    first.signal.addEventListener('abort', () => first.release())
    second.signal.addEventListener('abort', () => second.release())

    expect(() => scopes.cancel('tunedeck')).not.toThrow()
    expect(first.signal.aborted).toBe(true)
    expect(second.signal.aborted).toBe(true)
    expect(scopes.size('tunedeck')).toBe(0)
  })

  it('reports nothing cancelled for a scope with no requests', () => {
    const scopes = createScopeRegistry()
    expect(scopes.cancel('tunedeck')).toBe(0)
    expect(scopes.size('tunedeck')).toBe(0)
  })

  it('release is idempotent', () => {
    const scopes = createScopeRegistry()
    const entry = scopes.enter('tunedeck')
    entry.release()
    expect(() => entry.release()).not.toThrow()
    expect(scopes.size('tunedeck')).toBe(0)
  })

  it('keeps the two abort reasons distinguishable', () => {
    // The property `client.ts` relies on to tell "the operator closed the deck"
    // from "the service went quiet".
    expect(new ScopeCancelledError('tunedeck')).toBeInstanceOf(ScopeCancelledError)
    expect(new RequestTimeoutError(10_000)).not.toBeInstanceOf(ScopeCancelledError)
    expect(new RequestTimeoutError(10_000).timeoutMs).toBe(10_000)
  })
})
