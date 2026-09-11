import { manualDiscProposal, type CdToc, type DiscMetadataProposal } from '@shared/cdrip'

/** Decode the first supported language block; never guess at double-byte text. */
export function parseCdText(toc: CdToc): DiscMetadataProposal | null {
  const bytes = toc.cdText
  if (!bytes || bytes.length < 4) return null
  const length = ((bytes[0] << 8) | bytes[1]) + 2
  if (length > bytes.length || length < 4 || (length - 4) % 18) return null
  const packs: Uint8Array[] = []
  for (let offset = 4; offset < length; offset += 18) {
    const pack = bytes.slice(offset, offset + 18)
    // CD-TEXT uses complemented CRC-16/CCITT over the first sixteen bytes.
    let crc = 0
    for (const byte of pack.slice(0, 16)) {
      crc ^= byte << 8
      for (let bit = 0; bit < 8; bit++) crc = ((crc << 1) ^ (crc & 0x8000 ? 0x1021 : 0)) & 0xffff
    }
    if ((~crc & 0xffff) !== ((pack[16] << 8) | pack[17])) return null
    packs.push(pack)
  }
  for (let block = 0; block < 8; block++) {
    const local = packs.filter((p) => ((p[3] >> 4) & 7) === block).sort((a, b) => a[2] - b[2])
    if (
      !local.length ||
      local.some((p, i) => p[3] & 0x80 || (i > 0 && p[2] !== local[i - 1][2] + 1))
    )
      continue
    const size = local.find((p) => p[0] === 0x8f && p[1] === 0)
    // 0 = ISO-8859-1, 1 = ASCII. With no declaration only ASCII is safe.
    const charset = size?.[4] ?? 1
    if (charset !== 0 && charset !== 1) continue
    const fields = new Map<number, Map<number, string>>()
    let valid = true
    for (const type of [0x80, 0x81]) {
      const values = new Map<number, string>()
      fields.set(type, values)
      let pending: number[] = [],
        track = -1
      for (const pack of local.filter((p) => p[0] === type)) {
        if (pending.length) {
          if (pack[1] !== track || (pack[3] & 15) !== (pending.length > 12 ? 15 : pending.length)) {
            valid = false
            break
          }
        } else {
          if (pack[3] & 15) {
            valid = false
            break
          }
          track = pack[1]
        }
        for (const byte of pack.slice(4, 16)) {
          if (byte === 0) {
            if (pending.length) {
              const text = String.fromCharCode(...pending)
              if (values.has(track)) {
                valid = false
                break
              }
              values.set(track, text === '\t' ? (values.get(track - 1) ?? '') : text.trim())
            }
            pending = []
            track++
          } else {
            if ((byte < 32 && byte !== 9) || (byte >= 127 && (charset === 1 || byte < 160))) {
              valid = false
              break
            }
            pending.push(byte)
          }
        }
        if (!valid) break
      }
      if (pending.length) valid = false
    }
    if (!valid) continue
    const titles = fields.get(0x80)!,
      artists = fields.get(0x81)!
    const proposal = manualDiscProposal(toc)
    proposal.source = 'cdtext'
    proposal.album = titles.get(0) ?? ''
    proposal.albumArtist = artists.get(0) ?? ''
    for (const track of proposal.tracks) {
      track.title = titles.get(track.number) ?? ''
      track.artist = artists.get(track.number) ?? proposal.albumArtist
    }
    if (proposal.album || proposal.albumArtist || proposal.tracks.some((t) => t.title || t.artist))
      return proposal
  }
  return null
}
