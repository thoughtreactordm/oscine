import type { CdToc } from './cdrip'

/** MusicBrainz's fixed 804-byte ASCII hash input. No Node imports in shared code. */
export function discIdInput(toc: CdToc): string {
  const hex = (n: number, width: number): string =>
    n.toString(16).toUpperCase().padStart(width, '0')
  if (
    !Number.isInteger(toc.firstTrack) ||
    !Number.isInteger(toc.lastTrack) ||
    toc.firstTrack < 1 ||
    toc.lastTrack > 99 ||
    toc.firstTrack > toc.lastTrack ||
    toc.entries.length !== toc.lastTrack - toc.firstTrack + 1
  )
    throw new Error('Invalid CD TOC')
  let previous = -1
  for (const [i, track] of toc.entries.entries()) {
    if (
      track.number !== toc.firstTrack + i ||
      !Number.isInteger(track.startSector) ||
      track.startSector <= previous ||
      track.startSector > 0xffffffff - 150
    )
      throw new Error('Invalid CD TOC')
    previous = track.startSector
  }
  if (
    !Number.isInteger(toc.leadOutSector) ||
    toc.leadOutSector <= previous ||
    toc.leadOutSector > 0xffffffff - 150
  )
    throw new Error('Invalid CD lead-out')
  const audio = toc.entries.filter((t) => t.isAudio)
  if (!audio.length) throw new Error('No audio tracks')
  const first = audio[0].number,
    last = audio.at(-1)!.number
  if (audio.length !== last - first + 1) throw new Error('Non-contiguous audio tracks')
  // https://musicbrainz.org/doc/Disc_ID_Calculation#Multi-session_(audio_+_data)_CD
  const data = toc.entries.find((t) => t.number > last)
  const leadOut = data ? data.startSector - 11400 : toc.leadOutSector
  if (leadOut <= audio.at(-1)!.startSector) throw new Error('Invalid audio session lead-out')
  const offsets = Array<string>(99).fill('00000000')
  for (const track of audio) offsets[track.number - 1] = hex(track.startSector + 150, 8)
  return hex(first, 2) + hex(last, 2) + hex(leadOut + 150, 8) + offsets.join('')
}

/** Synchronous SHA-1 for this ASCII input only; identity hashing, not a security primitive. */
export function computeDiscId(toc: CdToc): string {
  const input = discIdInput(toc)
  const bytes = new Uint8Array(Math.ceil((input.length + 9) / 64) * 64)
  for (let i = 0; i < input.length; i++) bytes[i] = input.charCodeAt(i)
  bytes[input.length] = 0x80
  const view = new DataView(bytes.buffer)
  view.setUint32(bytes.length - 4, input.length * 8)
  const state = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0]
  const words = new Int32Array(80)
  const rotate = (n: number, bits: number): number => (n << bits) | (n >>> (32 - bits))
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getInt32(offset + i * 4)
    for (let i = 16; i < 80; i++)
      words[i] = rotate(words[i - 3] ^ words[i - 8] ^ words[i - 14] ^ words[i - 16], 1)
    let [a, b, c, d, e] = state
    for (let i = 0; i < 80; i++) {
      const f =
        i < 20
          ? (b & c) | (~b & d)
          : i < 40
            ? b ^ c ^ d
            : i < 60
              ? (b & c) | (b & d) | (c & d)
              : b ^ c ^ d
      const k = i < 20 ? 0x5a827999 : i < 40 ? 0x6ed9eba1 : i < 60 ? 0x8f1bbcdc : 0xca62c1d6
      const next = (rotate(a, 5) + f + e + k + words[i]) | 0
      e = d
      d = c
      c = rotate(b, 30)
      b = a
      a = next
    }
    for (const [i, value] of [a, b, c, d, e].entries()) state[i] = (state[i] + value) | 0
  }
  const digest = new Uint8Array(20)
  const output = new DataView(digest.buffer)
  state.forEach((n, i) => output.setInt32(i * 4, n))
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._'
  let encoded = ''
  for (let i = 0; i < digest.length; i += 3) {
    const n = (digest[i] << 16) | ((digest[i + 1] ?? 0) << 8) | (digest[i + 2] ?? 0)
    encoded +=
      alphabet[n >>> 18] +
      alphabet[(n >>> 12) & 63] +
      alphabet[(n >>> 6) & 63] +
      (i + 2 < digest.length ? alphabet[n & 63] : '-')
  }
  return encoded
}
