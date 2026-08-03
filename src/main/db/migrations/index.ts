import type { Migration } from '../migrate'
import { schemaV1 } from './001-schema-v1'
import { indexTrackOrder } from './002-index-track-order'
import { replayGainJobs } from './003-replaygain-jobs'
import { trigramSearch } from './004-trigram-search'
import { podcasts } from './005-podcasts'
import { settings } from './006-settings'
import { crossfadeCascade } from './007-crossfade-cascade'
import { themeKeys } from './008-theme-keys'
import { playHistory } from './009-play-history'
import { trackGenre } from './010-track-genre'
import { artistMbid } from './011-artist-mbid'
import { scrobbleOutbox } from './012-scrobble-outbox'
import { trackGenres } from './013-track-genres'

/**
 * Every migration, in order.
 *
 * Listed explicitly rather than discovered from disk: main is bundled into a
 * single file, so there is no directory to read at runtime. Adding a migration
 * means adding a numbered file and appending it here — `migrate` rejects the
 * registry outright if the versions are not contiguous, so forgetting the second
 * half fails loudly at startup instead of silently skipping the step.
 */
export const MIGRATIONS: readonly Migration[] = [
  schemaV1,
  indexTrackOrder,
  replayGainJobs,
  trigramSearch,
  podcasts,
  settings,
  crossfadeCascade,
  themeKeys,
  playHistory,
  trackGenre,
  artistMbid,
  scrobbleOutbox,
  trackGenres
]
