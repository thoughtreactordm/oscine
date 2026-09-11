/** Synthetic MMC packs, including real CRCs. Each call describes a twelve-byte payload. */
export function pack(
  type: number,
  track: number,
  text: string | number[],
  sequence = 0,
  flags = 0
): Buffer {
  const p = Buffer.alloc(18)
  p.set([type, track, sequence, flags])
  p.set(typeof text === 'string' ? Buffer.from(text, 'latin1') : text, 4)
  let crc = 0
  for (let i = 0; i < 16; i++) {
    crc ^= p[i] << 8
    for (let j = 0; j < 8; j++) crc = ((crc << 1) ^ (crc & 0x8000 ? 0x1021 : 0)) & 0xffff
  }
  p.writeUInt16BE(~crc & 0xffff, 16)
  return p
}
export function cdText(...packs: Buffer[]): Buffer {
  const header = Buffer.alloc(4)
  header.writeUInt16BE(2 + packs.length * 18)
  return Buffer.concat([header, ...packs])
}
