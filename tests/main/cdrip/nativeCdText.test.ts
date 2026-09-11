import { createRequire } from 'node:module'
import { expect, it } from 'vitest'
import type { CdToc } from '@shared/cdrip'
import fixture from './fixtures/captured-lba.json'
import { cdText, pack } from './cdTextFixture'
const addon = createRequire(import.meta.url)('@oscine/cdrip') as {
  _test: (
    op: string,
    ...args: unknown[]
  ) => { toc?: CdToc; error?: { code: string }; commands: Buffer[] }
}
const toc = Buffer.from(fixture.hex, 'hex')
const read = (...steps: (Buffer | string)[]) => addon._test('tocScript', 0, 0, [toc, ...steps])
it('reads format 5 on the same TOC operation with bounded two-step allocation', () => {
  const text = cdText(pack(0x80, 0, 'Album\0'))
  const result = read(text.subarray(0, 4), text)
  expect(result.toc?.cdText).toEqual(text)
  expect(result.commands.map((c) => [c[0], c[2], c.readUInt16BE(7)])).toEqual([
    [0x43, 0, 804],
    [0x43, 5, 4],
    [0x43, 5, text.length]
  ])
})
it('optional text failures leave a readable TOC', () => {
  for (const step of [
    'unsupported-drive',
    'read-failed',
    cdText(),
    Buffer.from([255, 255, 0, 0])
  ]) {
    const result = read(step)
    expect(result.error).toBeUndefined()
    expect(result.toc?.entries).toHaveLength(7)
    expect(result.toc?.cdText).toBeUndefined()
  }
})
it('rejects short text responses and propagates media changes', () => {
  const text = cdText(pack(0x80, 0, 'Album\0'))
  expect(read(text.subarray(0, 4), text.subarray(0, 8)).toc?.cdText).toBeUndefined()
  for (const code of ['no-disc', 'device-busy']) expect(read(code).error?.code).toBe(code)
})
