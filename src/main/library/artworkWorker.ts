import { mkdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { parentPort } from 'node:worker_threads'
import sharp from 'sharp'
import type { ArtworkVariant } from '@shared/library'

if (!parentPort) throw new Error('Artwork worker requires a parent port.')

const VARIANTS: Readonly<Record<ArtworkVariant, number>> = {
  small: 160,
  large: 640
}

// Reconciliation bounds album-level concurrency. Keep each sharp operation
// single-threaded as well so two covers cannot fan out across every CPU core.
sharp.concurrency(1)

interface GenerateMessage {
  id: number
  kind: 'generate'
  cacheDir: string
  hash: string
  bytes: Uint8Array
}

interface ValidateMessage {
  id: number
  kind: 'validate'
  cacheDir: string
  hash: string
}

type WorkerMessage = GenerateMessage | ValidateMessage

parentPort.on('message', async (message: WorkerMessage) => {
  try {
    const result =
      message.kind === 'generate'
        ? await generate(message.cacheDir, message.hash, message.bytes)
        : await validate(message.cacheDir, message.hash)
    parentPort!.postMessage({ id: message.id, result })
  } catch (error) {
    parentPort!.postMessage({
      id: message.id,
      error: error instanceof Error ? error.message : String(error)
    })
  }
})

async function generate(cacheDir: string, hash: string, bytes: Uint8Array): Promise<boolean> {
  await mkdir(cacheDir, { recursive: true })

  // Decode once before writing anything. This rejects truncated bytes and
  // unsupported formats without leaving a valid-looking cache filename.
  const source = sharp(bytes, { animated: false, limitInputPixels: 100_000_000 }).rotate()
  const metadata = await source.metadata()
  if (!metadata.width || !metadata.height) throw new Error('Embedded image has no dimensions.')

  let wrote = false
  for (const [variant, size] of Object.entries(VARIANTS) as Array<[ArtworkVariant, number]>) {
    const finalPath = thumbnailPath(cacheDir, hash, variant)
    if (await validateVariant(finalPath, size)) continue

    const temporaryPath = join(
      cacheDir,
      `.${hash}-${variant}-${process.pid}-${Date.now()}.tmp.webp`
    )
    try {
      await sharp(bytes, { animated: false, limitInputPixels: 100_000_000 })
        .rotate()
        .resize(size, size, { fit: 'cover', position: 'centre', withoutEnlargement: false })
        .webp({ quality: variant === 'small' ? 78 : 84, effort: 4 })
        .toFile(temporaryPath)

      // A corrupt prior final is not useful. Removing it before rename creates
      // at worst a brief placeholder response, never a partial thumbnail.
      await rm(finalPath, { force: true })
      await rename(temporaryPath, finalPath)
      wrote = true
    } finally {
      await rm(temporaryPath, { force: true })
    }
  }
  return wrote
}

async function validate(cacheDir: string, hash: string): Promise<boolean> {
  return (
    (await validateVariant(thumbnailPath(cacheDir, hash, 'small'), VARIANTS.small)) &&
    (await validateVariant(thumbnailPath(cacheDir, hash, 'large'), VARIANTS.large))
  )
}

async function validateVariant(path: string, expectedSize: number): Promise<boolean> {
  try {
    const metadata = await sharp(path, { animated: false }).metadata()
    return (
      metadata.format === 'webp' &&
      metadata.width === expectedSize &&
      metadata.height === expectedSize
    )
  } catch {
    return false
  }
}

function thumbnailPath(cacheDir: string, hash: string, variant: ArtworkVariant): string {
  return join(cacheDir, `${hash}-${variant}.webp`)
}
