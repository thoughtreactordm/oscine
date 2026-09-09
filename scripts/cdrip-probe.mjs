/** Read-only hardware spike. No output audio files, encoding, metadata, or app state. */
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'

const cd = createRequire(import.meta.url)('@oscine/cdrip')
const driveId = process.argv[2]
const drives = await cd.listDrives()
console.info(JSON.stringify({ runtime: process.versions, drives }, null, 2))
if (drives.length === 0) throw new Error('No optical drives found')
const selected = driveId ? drives.find((drive) => drive.id === driveId) : drives[0]
if (!selected) throw new Error('Requested drive is not in listDrives()')
try {
  const toc = await cd.readToc(selected.id)
  console.info(JSON.stringify({ toc }, null, 2))
  const track = toc.entries.find((entry) => entry.isAudio)
  if (!track) throw new Error('Disc contains no audio tracks')
  const count = Math.min(32, track.sectorCount)
  const start = track.startSector + Math.min(750, track.sectorCount - count)
  let ticks = 0
  const timer = setInterval(() => ticks++, 1)
  const begin = performance.now()
  try {
    const audio = await cd.readSectors(selected.id, start, count)
    if (audio.pcm.length !== count * 2352 || (audio.c2 && audio.c2.length !== count * 294)) {
      throw new Error('Unexpected audio/C2 byte count')
    }
    console.info(
      JSON.stringify(
        {
          start,
          count,
          pcmBytes: audio.pcm.length,
          c2Bytes: audio.c2?.length ?? null,
          c2Flagged: audio.c2?.some((byte) => byte !== 0) ?? null,
          sha256: createHash('sha256').update(audio.pcm).digest('hex'),
          milliseconds: Math.round(performance.now() - begin),
          eventLoopTicks: ticks
        },
        null,
        2
      )
    )
  } finally {
    clearInterval(timer)
  }
} catch (error) {
  console.error(JSON.stringify({ code: error.code, message: error.message, sector: error.sector }))
  process.exitCode = 1
}
