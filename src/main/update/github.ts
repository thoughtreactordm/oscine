/**
 * Read the version electron-builder published as `latest.yml`.
 *
 * Used only by installs that cannot self-update. AppImage and NSIS go through
 * `electron-updater`, which fetches the same file; doing it twice would be a
 * second GitHub hit for no extra information.
 *
 * This is a first-party read of our own Releases channel, not a D14 metadata
 * source: the operator clicked Check, and the host is the repo that already
 * cut the installer they are running. Consent for MusicBrainz does not gate it.
 */

import { latestMetadataUrl, parseLatestYmlVersion } from '@shared/update'

const MAX_YML_BYTES = 64_000
const TIMEOUT_MS = 15_000

export interface PublishedVersionReaderDeps {
  readonly platform: string
  readonly userAgent: string
  readonly fetchImpl?: typeof fetch
  readonly readText: (response: Response, maxBytes: number) => Promise<string>
}

export function createGitHubPublishedVersionReader(
  deps: PublishedVersionReaderDeps
): () => Promise<string> {
  const fetchImpl = deps.fetchImpl ?? fetch

  return async (): Promise<string> => {
    const url = latestMetadataUrl(deps.platform)
    const response = await fetchImpl(url, {
      headers: { 'User-Agent': deps.userAgent, Accept: 'text/yaml, text/plain, */*' },
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
    if (!response.ok) {
      throw new Error(`latest metadata HTTP ${response.status}`)
    }
    const text = await deps.readText(response, MAX_YML_BYTES)
    const version = parseLatestYmlVersion(text)
    if (!version) {
      throw new Error('latest metadata had no version')
    }
    return version
  }
}
