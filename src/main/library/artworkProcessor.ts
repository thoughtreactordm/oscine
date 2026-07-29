import { Worker } from 'node:worker_threads'
import { join } from 'node:path'

interface Pending {
  resolve: (result: boolean) => void
  reject: (error: Error) => void
}

export interface ArtworkImageProcessor {
  generate(cacheDir: string, hash: string, bytes: Uint8Array): Promise<boolean>
  validate(cacheDir: string, hash: string): Promise<boolean>
  close(): Promise<void>
}

/**
 * Long-lived worker adapter. Image decode, resize and WebP encoding never run
 * on Electron's main thread; Uint8Array transfer avoids copying large covers.
 */
export class WorkerArtworkImageProcessor implements ArtworkImageProcessor {
  private worker: Worker | null = null
  private nextId = 1
  private readonly pending = new Map<number, Pending>()

  generate(cacheDir: string, hash: string, bytes: Uint8Array): Promise<boolean> {
    const transferable = new Uint8Array(bytes).buffer
    return this.request(
      { kind: 'generate', cacheDir, hash, bytes: new Uint8Array(transferable) },
      transferable
    )
  }

  validate(cacheDir: string, hash: string): Promise<boolean> {
    return this.request({ kind: 'validate', cacheDir, hash })
  }

  async close(): Promise<void> {
    const worker = this.worker
    this.worker = null
    if (!worker) return
    this.failAll(new Error('Artwork worker closed.'))
    await worker.terminate()
  }

  private request(message: object, transferable?: ArrayBuffer): Promise<boolean> {
    const worker = this.getWorker()
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      worker.postMessage({ id, ...message }, transferable ? [transferable] : [])
    })
  }

  private getWorker(): Worker {
    if (this.worker) return this.worker
    // This adapter is bundled into the main entry, alongside the named worker
    // entry in `out/main`.
    const worker = new Worker(join(__dirname, 'artworkWorker.js'))
    worker.on('message', (message: { id: number; result?: boolean; error?: string }) => {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(message.error))
      else pending.resolve(message.result ?? false)
    })
    worker.on('error', (error) => this.failAll(error))
    worker.on('exit', (code) => {
      if (this.worker === worker) this.worker = null
      if (code !== 0) this.failAll(new Error(`Artwork worker exited with code ${code}.`))
    })
    this.worker = worker
    return worker
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }
}
