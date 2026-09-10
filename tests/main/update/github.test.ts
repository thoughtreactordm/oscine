import { describe, expect, it, vi } from 'vitest'
import { createGitHubPublishedVersionReader } from '../../../src/main/update/github'

describe('createGitHubPublishedVersionReader', () => {
  it('reads latest-linux.yml from the GitHub latest/download URL', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe(
        'https://github.com/thoughtreactordm/oscine/releases/latest/download/latest-linux.yml'
      )
      return new Response('version: 1.0.4\npath: Oscine-1.0.4.AppImage\n', { status: 200 })
    }) as unknown as typeof fetch

    const read = createGitHubPublishedVersionReader({
      platform: 'linux',
      userAgent: 'Oscine/1.0.2 (test)',
      fetchImpl,
      readText: async (response) => await response.text()
    })

    await expect(read()).resolves.toBe('1.0.4')
  })

  it('throws on a missing sidecar rather than inventing a version', async () => {
    const read = createGitHubPublishedVersionReader({
      platform: 'win32',
      userAgent: 'Oscine/1.0.2 (test)',
      fetchImpl: (async () => new Response('nope', { status: 404 })) as typeof fetch,
      readText: async (response) => await response.text()
    })

    await expect(read()).rejects.toThrow(/HTTP 404/)
  })
})
