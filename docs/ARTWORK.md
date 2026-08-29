# Artwork cache

Artwork thumbnails are derived, disposable local data owned by the main process.
The renderer receives only `oscine://artwork/<hash>/<variant>` URLs.

## Selection and identity

Albums are reconciled in database-id order. Candidate tracks are ordered by root
id, POSIX relative path, then track id. Within a track, front-cover pictures are
preferred and parser order breaks ties. All embedded candidates are preferred
over sidecar images.

When an album has no valid embedded picture, Oscine checks each track directory
for the case-insensitive basenames `cover`, `folder`, `front`, `albumart`,
`albumcover`, and `artwork`, in that order. Supported sidecar extensions are
JPG/JPEG, PNG, WebP, AVIF, GIF, and TIFF. For albums split across sibling disc
directories, their common parent is checked first. Sidecar additions, changes,
and removals are picked up by the live directory watcher.

The cache key is lowercase SHA-256 over the exact embedded picture bytes. The
input is intentionally independent of the image library and encoder version:
byte-identical source images deduplicate across albums, while changing the
source bytes changes `albums.artwork_hash`.

## Files and bounds

Cache files live below the app's `userData/artwork-cache-v1` directory. Exactly
two WebP variants are defined:

- `small`: 160 × 160 for album browsing
- `large`: 640 × 640 for Now Playing

Images are decoded, auto-oriented, center-cropped, resized and encoded in a
worker thread. Album reconciliation has a concurrency limit of two, and sharp
uses one processing thread per operation. Files are written to unique temporary
names and renamed only after encoding completes. Reconciliation removes
temporary files and any content hash no live album references.

Missing, malformed and unsupported pictures leave a null database hash and use
the built-in protocol placeholder. Missing or invalid variants are regenerated
from embedded metadata during the next reconciliation.

Each reconciliation writes one structured `[artwork]` log record with album and
source counts, unique hashes, generated/pruned files, elapsed time, cache bytes,
and the configured concurrency. An exit probe can aggregate these records
without adding a renderer IPC payload.
