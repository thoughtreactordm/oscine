import { describe, expect, it } from 'vitest'
import type { LyricsDocument } from '@shared/lyrics'
import { createLyricsLoader } from '../../../src/renderer/stores/lyricsLoader'

function doc(source: LyricsDocument['source'], text: string): LyricsDocument {
  return { lines: [{ timeMs: 0, text }], synced: true, offsetMs: 0, source }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('createLyricsLoader', () => {
  it('does not let a slow response for an old track overwrite a fresh one', async () => {
    const first = deferred<LyricsDocument | null>()
    const second = deferred<LyricsDocument | null>()
    const loader = createLyricsLoader((id) => (id === 1 ? first.promise : second.promise))

    void loader.load(1)
    void loader.load(2)
    expect(loader.trackId.value).toBe(2)
    expect(loader.loading.value).toBe(true)

    const wanted = doc('sidecar', 'track two')
    second.resolve(wanted)
    await flush()
    expect(loader.document.value).toBe(wanted)
    expect(loader.loading.value).toBe(false)

    // The stale winner arrives late and must be ignored.
    first.resolve(doc('embedded', 'track one'))
    await flush()
    expect(loader.document.value).toBe(wanted)
    expect(loader.loading.value).toBe(false)
  })

  it('surfaces a rejection as failed, not a thrown track change', async () => {
    const loader = createLyricsLoader(() => Promise.reject(new Error('ipc down')))
    await loader.load(7)
    expect(loader.failed.value).toBe(true)
    expect(loader.document.value).toBeNull()
    expect(loader.loading.value).toBe(false)
  })

  it('clears everything when the track goes away', async () => {
    const loader = createLyricsLoader(() => Promise.resolve(doc('sidecar', 'x')))
    await loader.load(3)
    expect(loader.document.value).not.toBeNull()

    await loader.load(null)
    expect(loader.document.value).toBeNull()
    expect(loader.trackId.value).toBeNull()
    expect(loader.loading.value).toBe(false)
    expect(loader.failed.value).toBe(false)
  })

  it('clears the stale document up front so no track shows another’s words', async () => {
    const pending = deferred<LyricsDocument | null>()
    let call = 0
    const loader = createLyricsLoader((id) => {
      call++
      return id === 10 ? Promise.resolve(doc('sidecar', 'first')) : pending.promise
    })

    await loader.load(10)
    expect(loader.document.value?.lines[0]?.text).toBe('first')

    // Second load is in flight: the old document is gone immediately.
    void loader.load(11)
    expect(loader.document.value).toBeNull()
    expect(loader.loading.value).toBe(true)
    expect(call).toBe(2)
    pending.resolve(doc('embedded', 'second'))
    await flush()
    expect(loader.document.value?.lines[0]?.text).toBe('second')
  })
})
