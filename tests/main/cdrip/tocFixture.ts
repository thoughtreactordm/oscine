import type { CdToc } from '@shared/cdrip'
export function fromToc(value: string): CdToc {
  const [firstTrack, lastTrack, leadOut, ...offsets] = value.split(/\s+/).map(Number)
  return {
    firstTrack,
    lastTrack,
    leadOutSector: leadOut - 150,
    entries: offsets.map((offset, i) => ({
      number: firstTrack + i,
      startSector: offset - 150,
      sectorCount: (offsets[i + 1] ?? leadOut) - offset,
      isAudio: true,
      preEmphasis: false
    }))
  }
}
