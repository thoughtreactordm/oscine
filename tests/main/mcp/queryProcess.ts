import { fork } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import type { QueryProcess, SpawnQueryProcess } from '../../../src/main/mcp/query/host'
import type { QueryRequest, QueryResponse } from '../../../src/main/mcp/query/protocol'

/**
 * The real query process for tests — `src/main/mcp/query/worker.ts`, bundled the
 * way electron-vite bundles it and forked with `child_process` instead of
 * Electron's `utilityProcess`, which needs a running app. The worker speaks to
 * either. A real process, because the point of several tests is that killing it
 * stops a statement mid-step, which nothing in-process can show.
 */
export interface QueryProcessHarness {
  spawn(libraryPath: string): SpawnQueryProcess
  /** Processes spawned so far that have not exited. */
  alive(): number
  dispose(): void
}

export async function bundleQueryWorker(): Promise<QueryProcessHarness> {
  const dir = mkdtempSync(join(tmpdir(), 'oscine-query-worker-'))
  const outfile = join(dir, 'mcpQueryWorker.cjs')
  await build({
    entryPoints: [resolve(__dirname, '../../../src/main/mcp/query/worker.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile,
    logLevel: 'silent'
  })
  const live = new Set<ReturnType<typeof fork>>()
  return {
    spawn: (libraryPath) => () => {
      const child = fork(outfile, [libraryPath], { stdio: 'ignore' })
      live.add(child)
      child.once('exit', () => live.delete(child))
      const process: QueryProcess = {
        send: (request: QueryRequest) => void child.send(request),
        onMessage: (listener) => {
          child.on('message', (message) => listener(message as QueryResponse))
        },
        onExit: (listener) => {
          child.once('exit', () => listener())
        },
        kill: () => void child.kill('SIGKILL')
      }
      return process
    },
    alive: () => live.size,
    dispose: () => {
      for (const child of live) child.kill('SIGKILL')
      rmSync(dir, { recursive: true, force: true })
    }
  }
}
