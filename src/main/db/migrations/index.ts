import type { Migration } from '../migrate'
import { schemaV1 } from './001-schema-v1'
import { indexTrackOrder } from './002-index-track-order'

/**
 * Every migration, in order.
 *
 * Listed explicitly rather than discovered from disk: main is bundled into a
 * single file, so there is no directory to read at runtime. Adding a migration
 * means adding a numbered file and appending it here — `migrate` rejects the
 * registry outright if the versions are not contiguous, so forgetting the second
 * half fails loudly at startup instead of silently skipping the step.
 */
export const MIGRATIONS: readonly Migration[] = [schemaV1, indexTrackOrder]
