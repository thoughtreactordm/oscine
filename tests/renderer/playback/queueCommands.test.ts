import { describe, expect, it, vi } from 'vitest'
import {
  createQueueCommands,
  queueCommandLabel,
  queueEntryLabel,
  queueIds,
  queueRows
} from '../../../src/renderer/playback/queueCommands'
import { createUpNextQueue } from '../../../src/renderer/playback/upNextQueue'
import type { Track } from '../../../src/shared/library'

/**
 * The queue verbs, over the real `upNextQueue` and a synthetic library.
 *
 * Driven against the actual queue rather than a mock of it, because the thing
 * worth checking is the *composition* — that "play next" from a four-thousand
 * row selection arrives in the queue in the order the user saw, through however
 * many round trips it took to widen it.
 */

function track(id: number): Track {
  return {
    id,
    rootId: 1,
    title: `Song ${id}`,
    artist: id % 2 === 0 ? 'Artist' : null,
    album: 'Album',
    albumArtist: null,
    trackNo: null,
    discNo: null,
    year: null,
    durationSec: 100,
    codec: 'flac',
    encodedBytes: 1_000_000,
    sampleRateHz: 44_100,
    channels: 2,
    bitDepth: 16,
    playCount: 0,
    lastPlayedAt: null,
    artwork: { small: 'fermata://artwork/missing/small', large: 'fermata://artwork/missing/large' },
    rgTrackGainDb: null,
    rgTrackPeak: null,
    rgAlbumGainDb: null,
    rgAlbumPeak: null,
    rgSource: null
  }
}

function harness(options: { chunkSize?: number; missing?: number[] } = {}) {
  const queue = createUpNextQueue()
  const played: string[] = []
  const missing = new Set(options.missing ?? [])

  const fetchTracks = vi.fn((ids: readonly number[]) =>
    // Ids the library no longer has drop out, exactly as the contract says.
    Promise.resolve(ids.filter((id) => !missing.has(id)).map(track))
  )

  const commands = createQueueCommands({
    fetchTracks,
    chunkSize: options.chunkSize,
    queue: {
      enqueue: queue.enqueue,
      enqueueNext: queue.enqueueNext,
      remove: queue.remove,
      move: queue.move,
      clearUser: queue.clearUser,
      clear: queue.clear,
      play: (entryId) => {
        played.push(entryId)
        queue.take(entryId)
      }
    }
  })

  return { commands, queue, fetchTracks, played }
}

const titles = (queue: ReturnType<typeof createUpNextQueue>): string[] =>
  queue.entries.value.map((entry) => entry.track.title)

describe('queue commands', () => {
  it('appends in the order the rows were shown', async () => {
    const { commands, queue } = harness()

    await commands.addToQueue(queueIds([9, 4, 7]))

    expect(titles(queue)).toEqual(['Song 9', 'Song 4', 'Song 7'])
  })

  it('preserves the visible order across every chunk of a large selection', async () => {
    const { commands, queue, fetchTracks } = harness({ chunkSize: 100 })
    // Descending, so an implementation that sorted or raced the chunks and got
    // lucky on ascending input cannot pass this.
    const selection = Array.from({ length: 4_000 }, (_, index) => 4_000 - index)

    await commands.addToQueue(queueIds(selection))

    expect(fetchTracks).toHaveBeenCalledTimes(40)
    expect(queue.count.value).toBe(4_000)
    expect(queue.entries.value.map((entry) => entry.trackId)).toEqual(selection)
  })

  it('puts play-next in front of what is already queued, in its own order', async () => {
    const { commands, queue } = harness()

    await commands.addToQueue(queueIds([1, 2]))
    await commands.playNext(queueIds([8, 9]))

    expect(titles(queue)).toEqual(['Song 8', 'Song 9', 'Song 1', 'Song 2'])
  })

  it('takes rows the caller is already holding without a round trip', async () => {
    const { commands, queue, fetchTracks } = harness()

    await commands.addToQueue(queueRows([track(3)]))

    expect(fetchTracks).not.toHaveBeenCalled()
    expect(titles(queue)).toEqual(['Song 3'])
  })

  it('queues the survivors when some ids are gone, and reports how many', async () => {
    const { commands, queue } = harness({ missing: [4] })

    await expect(commands.addToQueue(queueIds([3, 4, 5]))).resolves.toBe(2)
    expect(titles(queue)).toEqual(['Song 3', 'Song 5'])
  })

  it('does nothing for an empty target', async () => {
    const { commands, queue, fetchTracks } = harness()

    await expect(commands.addToQueue(queueIds([]))).resolves.toBe(0)
    await expect(commands.playNext(queueRows([]))).resolves.toBe(0)

    expect(fetchTracks).not.toHaveBeenCalled()
    expect(queue.count.value).toBe(0)
  })

  it('queues two copies of one track as two rows (D12)', async () => {
    const { commands, queue } = harness()

    await commands.addToQueue(queueIds([5, 5]))

    expect(queue.count.value).toBe(2)
    const [first, second] = queue.entries.value
    expect(first?.trackId).toBe(second?.trackId)
    expect(first?.id).not.toBe(second?.id)
  })

  it('removes one row, clears the rest, and jumps to an entry', async () => {
    const { commands, queue, played } = harness()

    await commands.addToQueue(queueIds([1, 2, 3]))
    const [, second, third] = queue.entries.value

    commands.remove(second!.id)
    expect(titles(queue)).toEqual(['Song 1', 'Song 3'])

    await commands.jumpTo(third!.id)
    expect(played).toEqual([third!.id])
    // §5: jumping takes only the row it plays. Dropping everything above it is
    // the other reading, and the controller takes the one that destroys nothing.
    expect(titles(queue)).toEqual(['Song 1'])

    commands.clear()
    expect(queue.count.value).toBe(0)
  })

  it('reorders through the queue, so the tier clamp is not reimplemented above it', async () => {
    const { commands, queue } = harness()

    await commands.addToQueue(queueIds([1, 2, 3]))
    queue.fillSession([{ track: track(9), orderIndex: 0 }])

    commands.move(queue.entries.value[0]!.id, 2)
    expect(titles(queue)).toEqual(['Song 2', 'Song 3', 'Song 1', 'Song 9'])

    // Past the boundary, and clamped back inside it by the queue rather than by
    // the caller — W7-2's pane refuses the gesture, and this is what it would
    // otherwise be relying on.
    commands.move(queue.entries.value[0]!.id, 3)
    expect(titles(queue)).toEqual(['Song 3', 'Song 1', 'Song 2', 'Song 9'])
  })
})

describe('queue command wording', () => {
  it('names the count once, so two menus cannot word it differently', () => {
    expect(queueCommandLabel('playNext', 1)).toBe('Play next')
    expect(queueCommandLabel('playNext', 4312)).toBe('Play 4,312 tracks next')
    expect(queueCommandLabel('addToQueue', 1)).toBe('Add to queue')
    expect(queueCommandLabel('addToQueue', 2)).toBe('Add 2 tracks to queue')
  })

  it('falls back to the title alone for a track with no artist', () => {
    const queue = createUpNextQueue()
    queue.enqueue([track(2), track(3)])
    const [withArtist, without] = queue.entries.value

    expect(queueEntryLabel(withArtist!)).toBe('Artist — Song 2')
    expect(queueEntryLabel(without!)).toBe('Song 3')
  })
})
