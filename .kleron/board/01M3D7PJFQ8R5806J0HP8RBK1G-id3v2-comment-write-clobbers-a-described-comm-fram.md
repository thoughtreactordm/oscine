---
taskId: 01M3D7PJFQ8R5806J0HP8RBK1G
title: ID3v2 `comment` write clobbers a described COMM frame
status: done
priority: medium
labels:
  - '1.1'
  - tag-writeback
  - gate
triageKind: bug
workstream: W16
workstreamId: W16-19
order: 1
created: '2026-09-25T21:31:48.085Z'
updated: '2026-09-27T00:39:10.108Z'
---
Found by the W16-16 per-field corpus gate (`npm run probe:writeback-corpus`), linux/x64, node-taglib-sharp as pinned.

**Red cell:** `comment` × mp3, `written:comment:set`.

On an MP3 that has no plain COMM frame but does have *described* COMM frames (the corpus seeds `oscine-a` / `oscine-b`), assigning `tag.comment` does not add a new frame with an empty description. It overwrites the first described frame: `oscine-a` changes from `alpha` to the comment text. node-taglib-sharp's ID3v2 comment accessor picks a "preferred" COMM frame and falls back to any frame when none has an empty description. The read has the same problem: on such a file the editor would show `alpha` as the track's comment.

This is the R6 failure the corpus exists to catch. A user's comment edit would destroy an unrelated frame that another tool owns.

**Status:** `comment` stays held (`admitted: false`) in `src/shared/tagFields.ts` until this is resolved. flac/vorbis/opus/aac are green.

**Likely fix direction (for W16-17's writer, not the gate):** on ID3v2, read and write the comment through an explicit `Id3v2CommentsFrame` with description `''` (find, or create if missing) instead of the portable `Tag.comment` accessor. Then re-run the gate. The `comment` cell must go green, including the collateral check, before the field is admitted.
