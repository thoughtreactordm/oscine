import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type OpenDatabaseResult } from '../../../src/main/db'
import { TagOverrideStore } from '../../../src/main/library/overrides/tagOverrides'
import { buildTagFieldEditState } from '../../../src/main/library/overrides/editState'
import type { TagFieldKey, TagFieldValue } from '@shared/tagFields'

/**
 * The generic correction layer — **W16-15**. The tri-state per field (no row,
 * a value, a clear), the batch path, and the two lifecycle guarantees: a key
 * this build does not know survives everything but the track's own deletion.
 */

const NOW = 1_000

describe('track tag overrides', () => {
  let dir: string
  let opened: OpenDatabaseResult
  let store: TagOverrideStore
  let rootId: number

  function insertTrack(rel: string): number {
    return Number(
      opened.db
        .prepare('INSERT INTO tracks (root_id, rel_path, mtime, size) VALUES (?, ?, 1, 1)')
        .run(rootId, rel).lastInsertRowid
    )
  }

  function rawRows(trackId: number): Array<{ field: string; value: string }> {
    return opened.db
      .prepare('SELECT field, value FROM track_tag_overrides WHERE track_id = ? ORDER BY field')
      .all(trackId) as Array<{ field: string; value: string }>
  }

  function insertRaw(trackId: number, field: string, value: string): void {
    opened.db
      .prepare(
        'INSERT INTO track_tag_overrides (track_id, field, value, updated_at) VALUES (?, ?, ?, ?)'
      )
      .run(trackId, field, value, NOW)
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oscine-tag-overrides-'))
    opened = openDatabase(join(dir, 'library.db'))
    store = new TagOverrideStore(opened.db)
    rootId = Number(
      opened.db
        .prepare('INSERT INTO roots (label, path, added_at) VALUES (?, ?, ?)')
        .run('Synthetic', '/synthetic', 1).lastInsertRowid
    )
  })

  afterEach(() => {
    opened.db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('round-trips set, clear and revert per field', () => {
    const track = insertTrack('a.flac')

    store.set([track], { composers: ['Bach', 'Handel'], bpm: 90, compilation: true }, NOW)
    expect(store.get(track)).toEqual(
      new Map<TagFieldKey, TagFieldValue | null>([
        ['bpm', 90],
        ['compilation', true],
        ['composers', ['Bach', 'Handel']]
      ])
    )

    // A clear is a present row holding JSON null — distinct from absent.
    store.set([track], { bpm: null }, NOW + 1)
    expect(store.get(track).get('bpm')).toBeNull()
    expect(store.get(track).has('bpm')).toBe(true)
    expect(rawRows(track).find((row) => row.field === 'bpm')?.value).toBe('null')

    store.revert([track], ['bpm', 'composers'])
    expect([...store.get(track).keys()]).toEqual(['compilation'])

    store.revert([track], ['compilation'])
    expect(rawRows(track)).toEqual([])
  })

  it('touches only the fields present in the patch', () => {
    const track = insertTrack('a.flac')
    store.set([track], { conductor: 'Karajan', publisher: 'DG' }, NOW)
    store.set([track], { conductor: 'Abbado' }, NOW + 1)
    expect(store.get(track).get('conductor')).toBe('Abbado')
    expect(store.get(track).get('publisher')).toBe('DG')
  })

  it('applies a batch to every track, once each', () => {
    const a = insertTrack('a.flac')
    const b = insertTrack('b.flac')
    store.set([a, b, a], { grouping: 'Side A' }, NOW)
    const many = store.getMany([a, b])
    expect(many.get(a)?.get('grouping')).toBe('Side A')
    expect(many.get(b)?.get('grouping')).toBe('Side A')
    store.revert([a, b], ['grouping'])
    expect(store.getMany([a, b]).get(b)?.size).toBe(0)
  })

  it('preserves rows under unknown keys, and skips them on read', () => {
    const track = insertTrack('a.flac')
    insertRaw(track, 'someFutureField', '"kept"')
    store.set([track], { conductor: 'Karajan' }, NOW)

    expect([...store.get(track).keys()]).toEqual(['conductor'])

    store.revert([track], ['conductor'])
    store.revertAll()
    expect(rawRows(track)).toEqual([{ field: 'someFutureField', value: '"kept"' }])
  })

  it('skips, but keeps, a stored value that no longer fits its field’s kind', () => {
    const track = insertTrack('a.flac')
    insertRaw(track, 'bpm', '"fast"')
    insertRaw(track, 'composers', 'not json')
    expect(store.get(track).size).toBe(0)
    expect(rawRows(track)).toHaveLength(2)
  })

  it('discards every known correction on revertAll', () => {
    const a = insertTrack('a.flac')
    const b = insertTrack('b.flac')
    store.set([a], { conductor: 'Karajan' }, NOW)
    store.set([b], { bpm: 120, isrc: null }, NOW)
    store.revertAll()
    expect(rawRows(a)).toEqual([])
    expect(rawRows(b)).toEqual([])
  })

  it('cascades on track delete, unknown keys included', () => {
    const track = insertTrack('a.flac')
    store.set([track], { conductor: 'Karajan' }, NOW)
    insertRaw(track, 'someFutureField', '1')
    opened.db.prepare('DELETE FROM tracks WHERE id = ?').run(track)
    expect(opened.db.prepare('SELECT count(*) AS n FROM track_tag_overrides').get()).toEqual({
      n: 0
    })
  })
})

describe('buildTagFieldEditState', () => {
  function row(values: Array<[TagFieldKey, TagFieldValue | null]>, overridden: TagFieldKey[] = []) {
    return { values: new Map(values), overridden: new Set(overridden) }
  }

  it('folds a shared value, comparing lists by value', () => {
    const state = buildTagFieldEditState(
      [row([['composers', ['Bach', 'Handel']]]), row([['composers', ['Bach', 'Handel']]])],
      ['composers']
    )
    expect(state.composers).toEqual({ value: ['Bach', 'Handel'], mixed: false, overridden: false })
  })

  it('marks disagreement as mixed, including list order', () => {
    const state = buildTagFieldEditState(
      [row([['composers', ['Bach', 'Handel']]]), row([['composers', ['Handel', 'Bach']]])],
      ['composers']
    )
    expect(state.composers).toEqual({ value: null, mixed: true, overridden: false })
  })

  it('treats a missing value as empty, and empty against set as mixed', () => {
    const state = buildTagFieldEditState([row([]), row([['bpm', 120]])], ['bpm', 'conductor'])
    expect(state.bpm).toEqual({ value: null, mixed: true, overridden: false })
    expect(state.conductor).toEqual({ value: null, mixed: false, overridden: false })
  })

  it('reports overridden when any track carries a correction', () => {
    const state = buildTagFieldEditState(
      [row([['compilation', true]], ['compilation']), row([['compilation', true]])],
      ['compilation']
    )
    expect(state.compilation).toEqual({ value: true, mixed: false, overridden: true })
  })

  it('folds only the requested fields, and an empty batch to empty values', () => {
    const state = buildTagFieldEditState([], ['isrc'])
    expect(Object.keys(state)).toEqual(['isrc'])
    expect(state.isrc).toEqual({ value: null, mixed: false, overridden: false })
  })
})
