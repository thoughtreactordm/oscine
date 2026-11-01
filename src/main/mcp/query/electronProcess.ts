import { join } from 'node:path'
import { utilityProcess, type UtilityProcess } from 'electron'
import type { QueryRequest, QueryResponse } from './protocol'
import type { QueryProcess, SpawnQueryProcess } from './host'

/**
 * The query process as an Electron `utilityProcess` — **W24-5**, D36.4.2.
 *
 * `out/main/mcpQueryWorker.js` is its own build entry (`electron.vite.config.ts`).
 * A utility process is Electron's supported way to run Node in a child: it does
 * not depend on the `RunAsNode` fuse, reads from `app.asar`, and `kill()` ends
 * it at once. Messages sent before it has spawned are held until it has.
 */
export function utilityQueryProcess(libraryPath: string): SpawnQueryProcess {
  return () => {
    const child: UtilityProcess = utilityProcess.fork(
      join(__dirname, 'mcpQueryWorker.js'),
      [libraryPath],
      { serviceName: 'Oscine agent query', stdio: 'ignore' }
    )
    let spawned = false
    const held: QueryRequest[] = []
    child.once('spawn', () => {
      spawned = true
      for (const request of held.splice(0)) child.postMessage(request)
    })
    const process: QueryProcess = {
      send(request) {
        if (spawned) child.postMessage(request)
        else held.push(request)
      },
      onMessage(listener) {
        child.on('message', (message: QueryResponse) => listener(message))
      },
      onExit(listener) {
        child.once('exit', () => listener())
      },
      kill() {
        child.kill()
      }
    }
    return process
  }
}
