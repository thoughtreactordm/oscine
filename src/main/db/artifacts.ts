/**
 * Everything Fermata writes into `userData`, and which half of D11 it is on.
 *
 * D11's export bundle carries statements *about tracks* — playlists, ratings,
 * play counts. It has never carried whole files, so "excluded from the bundle"
 * is not something an exporter does by omission; it is something an exporter has
 * to be told. This list is where it is told.
 *
 * The reason it is a list rather than a comment in the exporter is D14's
 * `cache.db`. A derived, disposable database sitting in the same directory as
 * the library is exactly the file a future "back up my Fermata data" feature
 * picks up by globbing `*.db` — and the failure would be silent, shipping an
 * operator's browsing history to another machine inside something advertised as
 * a playlist bundle. Every artifact declares its side once, here, and
 * `artifacts.test.ts` asserts the declaration rather than trusting a reviewer to
 * remember it.
 *
 * Free of Electron on purpose: `location.ts` resolves these to real paths and is
 * the only part of `db/` that needs `app.getPath`, so this stays readable from a
 * plain-Node test.
 */

/** What losing this file costs, which is the same question as whether to export it. */
export type ArtifactKind =
  /**
   * Authored by the operator or by scanning their files. Losing it loses work.
   * Being on this side does not mean the bundle carries the *file* — it means
   * the bundle is where its contents are argued about.
   */
  | 'authored'
  /**
   * Reconstructible from something else Fermata already has: the files on disk,
   * or a request that can be made again. Deleting it costs time, never data,
   * and it is never exported.
   */
  | 'derived'

export interface UserDataArtifact {
  /** Path component under `userData`. A file or a directory. */
  readonly name: string
  readonly kind: ArtifactKind
  /** Why it is on that side. Read by whoever next wonders. */
  readonly why: string
}

export const LIBRARY_DATABASE_ARTIFACT: UserDataArtifact = {
  name: 'library.db',
  kind: 'authored',
  why: 'Ratings, playlists, play counts and the scan of the operator’s files.'
}

export const CACHE_DATABASE_ARTIFACT: UserDataArtifact = {
  name: 'cache.db',
  kind: 'derived',
  why:
    'D14’s external-metadata cache. Every row is a reply that can be fetched again, ' +
    'carries a TTL, and is separate from the library precisely so that deleting it is ' +
    'a supported action rather than a corruption.'
}

export const ARTWORK_CACHE_ARTIFACT: UserDataArtifact = {
  name: 'artwork-cache-v1',
  kind: 'derived',
  why: 'Thumbnails re-extracted from the audio files and folder images they came from.'
}

export const PODCASTS_ARTIFACT: UserDataArtifact = {
  name: 'podcasts',
  kind: 'derived',
  why: 'Downloaded episode audio, re-downloadable from the feed the subscription names.'
}

/**
 * Every artifact, declared once.
 *
 * `location.ts` derives its filenames from this, so a path that exists without
 * an entry here is not possible: there is nowhere else for the name to come
 * from.
 */
export const USER_DATA_ARTIFACTS: readonly UserDataArtifact[] = [
  LIBRARY_DATABASE_ARTIFACT,
  CACHE_DATABASE_ARTIFACT,
  ARTWORK_CACHE_ARTIFACT,
  PODCASTS_ARTIFACT
]

/**
 * The names D11's export bundle must never contain, at any path inside it.
 *
 * The exporter that lands later reads this rather than restating it. A bundle
 * builder that walks `userData` should reject on encountering one of these
 * instead of skipping it quietly — a bundle that silently drops a file it was
 * asked for is a different bug from one that refuses.
 */
export const EXPORT_EXCLUDED_ARTIFACTS: readonly string[] = USER_DATA_ARTIFACTS.filter(
  (artifact) => artifact.kind === 'derived'
).map((artifact) => artifact.name)
