import { readFile } from 'node:fs/promises'
import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import type { ReplayGainAnalysis } from './loudness'

export interface ReplayGainAnalyzer {
  analyze(path: string, signal: AbortSignal): Promise<ReplayGainAnalysis>
  close(): Promise<void>
}

interface Pending {
  resolve: (result: ReplayGainAnalysis) => void
  reject: (error: Error) => void
}

/**
 * One worker is sufficient for the default job runner: decoding and DSP are
 * CPU-bound and the job runner bounds concurrency by constructing two of these.
 */
export class WorkerReplayGainAnalyzer implements ReplayGainAnalyzer {
  private worker: Worker | null = null
  private stopping: Promise<void> | null = null
  private nextId = 1
  private readonly pending = new Map<number, Pending>()

  async analyze(path: string, signal: AbortSignal): Promise<ReplayGainAnalysis> {
    if (signal.aborted) throw new Error('ReplayGain analysis cancelled.')
    const worker = this.getWorker()
    const id = this.nextId++

    return new Promise((resolve, reject) => {
      const abort = (): void => {
        this.pending.delete(id)
        reject(new Error('ReplayGain analysis cancelled.'))
        void this.stopWorker()
      }
      signal.addEventListener('abort', abort, { once: true })
      this.pending.set(id, {
        resolve: (result) => {
          signal.removeEventListener('abort', abort)
          resolve(result)
        },
        reject: (error) => {
          signal.removeEventListener('abort', abort)
          reject(error)
        }
      })
      worker.postMessage({ id, path })
    })
  }

  async close(): Promise<void> {
    await this.stopWorker()
  }

  private getWorker(): Worker {
    if (this.worker) return this.worker
    // This module is shared by main and the worker, so Rollup emits it below
    // `out/main/chunks`; the named worker entry remains one directory above.
    const worker = new Worker(join(__dirname, '..', 'replayGainWorker.js'))
    worker.on('message', (message: { id: number; result?: ReplayGainAnalysis; error?: string }) => {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.result) pending.resolve(message.result)
      else pending.reject(new Error(message.error ?? 'ReplayGain worker failed.'))
    })
    worker.on('error', (error) => this.failAll(error))
    worker.on('exit', (code) => {
      if (this.worker === worker) this.worker = null
      if (code !== 0) this.failAll(new Error(`ReplayGain worker exited with code ${code}.`))
    })
    this.worker = worker
    return worker
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }

  private async stopWorker(): Promise<void> {
    if (this.stopping) return this.stopping
    const worker = this.worker
    this.worker = null
    if (!worker) return
    this.failAll(new Error('ReplayGain analysis cancelled.'))
    const stopping = worker.terminate().then(() => {})
    this.stopping = stopping
    try {
      await stopping
    } finally {
      if (this.stopping === stopping) this.stopping = null
    }
  }
}

/**
 * Worker-side decoder. Exported for a direct packaging smoke test without
 * exposing node-web-audio-api to the main-process service.
 */
export async function decodeAndAnalyze(path: string): Promise<ReplayGainAnalysis> {
  const { AudioContext } = await import('node-web-audio-api')
  // node-web-audio-api supports the standards-track `sinkId: {type:'none'}`
  // option, but the DOM lib bundled with the current TypeScript release does
  // not declare it yet.
  const context = new AudioContext({
    sinkId: { type: 'none' }
  } as AudioContextOptions)
  try {
    const bytes = await readFile(path)
    const buffer = await context.decodeAudioData(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    )
    const channels: Float32Array[] = []
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      const samples = new Float32Array(buffer.length)
      buffer.copyFromChannel(samples, channel)
      channels.push(samples)
    }
    const { analyzePcm } = await import('./loudness')
    return analyzePcm(channels, buffer.sampleRate)
  } finally {
    await context.close()
  }
}
