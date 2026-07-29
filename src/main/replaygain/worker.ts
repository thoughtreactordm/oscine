import { parentPort } from 'node:worker_threads'
import { decodeAndAnalyze } from './analyzer'

if (!parentPort) throw new Error('ReplayGain worker requires a parent port.')

parentPort.on('message', async (message: { id: number; path: string }) => {
  try {
    const result = await decodeAndAnalyze(message.path)
    parentPort!.postMessage({ id: message.id, result })
  } catch (error) {
    parentPort!.postMessage({
      id: message.id,
      error: error instanceof Error ? error.message : String(error)
    })
  }
})
