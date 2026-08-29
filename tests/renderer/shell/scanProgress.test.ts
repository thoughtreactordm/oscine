import { describe, expect, it } from 'vitest'
import type { ScanProgress } from '../../../src/shared/library'
import {
  indexingChipDetail,
  indexingChipLabel,
  scanCountsLabel,
  scanFileLabel
} from '../../../src/renderer/shell/scanProgress'

function progress(over: Partial<ScanProgress> = {}): ScanProgress {
  return {
    rootId: 1,
    filesSeen: 12,
    tracksIndexed: 8,
    currentFile: '03.flac',
    done: false,
    ...over
  }
}

describe('scanProgress copy', () => {
  it('writes found and indexed as a single status line', () => {
    expect(scanCountsLabel(progress())).toBe('12 found · 8 indexed')
    expect(scanCountsLabel(progress({ filesSeen: 1, tracksIndexed: 0 }))).toBe(
      '1 found · 0 indexed'
    )
  })

  it('uses the basename when one is present, and a waiting line when not', () => {
    expect(scanFileLabel(progress())).toBe('03.flac')
    expect(scanFileLabel(progress({ currentFile: null }))).toBe('Reading folders…')
  })

  it('labels the title-bar chip with tracks indexed', () => {
    expect(indexingChipLabel(progress())).toBe('Indexing · 8')
    expect(indexingChipDetail(progress())).toBe('12 found · 8 indexed. 03.flac')
  })
})
