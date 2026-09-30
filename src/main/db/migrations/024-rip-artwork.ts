import type { Migration } from '../migrate'

/** Keep the original cover with the checkpoint so resume needs no source image file. */
export const ripArtwork: Migration = {
  version: 24,
  name: 'rip-artwork',
  sql: `ALTER TABLE rip_sessions ADD COLUMN artwork_bytes BLOB;
ALTER TABLE rip_sessions ADD COLUMN artwork_mime TEXT;`
}
