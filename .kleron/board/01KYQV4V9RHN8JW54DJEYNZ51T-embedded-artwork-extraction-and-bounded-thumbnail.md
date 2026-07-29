---
taskId: 01KYQV4V9RHN8JW54DJEYNZ51T
title: Embedded artwork extraction and bounded thumbnail cache
status: done
priority: medium
labels:
  - M3
  - library
  - artwork
  - cache
workstream: W2
workstreamId: W2-7
dependsOn:
  - 01KYECGN8JRHFBMDEBTRS9ZT1E
effort: high
order: 2
created: '2026-07-29T21:05:34.007Z'
updated: '2026-07-29T21:44:51.000Z'
---
Add M3's artwork cache as a main-process library service. Artwork is derived local data: the renderer receives only an opaque URL and never a filesystem path.

## Scope

- During scan/rescan, select a deterministic valid embedded image for each album and derive display thumbnails off the main UI path.
- Hash normalized source bytes (or another documented stable input), store the hash in `albums.artwork_hash`, and deduplicate identical art across albums.
- Store generated thumbnails under the app's cache/data location with composed platform-neutral paths. Write atomically so interruption cannot leave a valid-looking partial file.
- Define bounded thumbnail variants sufficient for album browsing and Now Playing; decode/resize work must not inflate IPC payloads or block the renderer.
- Serve cached art through a narrow opaque `fermata://` URL or equally constrained protocol route with strict id/hash validation and a placeholder for missing art.
- Invalidate changed art on rescan and prune cache entries no album references. A missing/corrupt cache file must self-heal from source metadata on the next reconciliation.
- Batch or queue extraction so a 100k-track initial scan remains responsive and duplicate album tracks do not repeat the same work.
- Cover malformed images, unsupported formats, albums with no art, duplicate art and interrupted writes.

## Explicitly not in scope

Online cover lookup, sidecar-folder image discovery, manual artwork editing, animated artwork, original-resolution export, or a general renderer file-serving primitive.

## Acceptance

- Multiple tracks/albums carrying identical embedded art produce one cached content object and stable album hashes.
- The renderer can display small and large variants through opaque URLs without receiving a path or raw original image over IPC.
- Missing and malformed artwork yields the placeholder and never aborts a scan.
- Changing embedded art updates the album hash; unreferenced derived files are eventually removed.
- Cache writes survive forced interruption without serving partial images.
- Extraction/dedup on the M3 fixture has bounded concurrency and recorded time/disk totals for the exit report.

## Implementation

- SHA-256 keys the exact embedded source bytes. Candidate tracks and pictures have a deterministic order, and invalid candidates fall through without failing the scan.
- A worker-thread sharp pipeline atomically derives only 160 px and 640 px WebP variants with album concurrency capped at two.
- Album and track queries expose only closed `fermata://artwork/<hash>/<variant>` URLs. The protocol validates hashes/variants and supplies a built-in missing-art placeholder.
- Reconciliation runs for changed albums, validates the cache at startup, prunes temporary and unreferenced files, and logs structured time/disk/count metrics.
- Focused artwork tests cover deduplication, malformed fallback, changed-art invalidation, pruning, corruption self-healing, missing-art URLs, and bounded concurrency.
