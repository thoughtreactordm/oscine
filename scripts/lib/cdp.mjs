/**
 * A minimal Chrome DevTools Protocol client, shared by the scripts that need to
 * ask the running app a question it cannot be asked from the outside.
 *
 * Two endpoints matter and they are different protocols wearing the same
 * transport:
 *
 * - The **page** target (`--remote-debugging-port`) reaches the renderer, where
 *   the Vue app, the Pinia stores and the AudioEngine live.
 * - The **main** target (`--inspect`) is a plain Node inspector, and it is the
 *   only place `electron.app` can be reached. `app.getAppMetrics()` is why we
 *   bother: it reports working-set size per child process with the same shape on
 *   Windows and Linux, so a memory figure taken on one platform means the same
 *   thing as a figure taken on the other. Reading `/proc` would not have been
 *   comparable, and there is no `/proc` on Windows to read.
 *
 * Deliberately dependency-free and about a hundred lines: the whole point is to
 * be a thing that still works in two years without a `npm audit` conversation.
 */

const DEFAULT_PAGE_ENDPOINT = 'http://127.0.0.1:9222'
const DEFAULT_MAIN_ENDPOINT = 'http://127.0.0.1:9229'

/**
 * Wraps one CDP websocket. `send` resolves with the raw protocol message so
 * callers can inspect `error` themselves; `evaluate` is the ergonomic path.
 */
class CdpSession {
  #socket
  #nextId = 0
  #pending = new Map()

  constructor(socket) {
    this.#socket = socket
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data)
      const resolve = this.#pending.get(message.id)
      if (resolve) {
        this.#pending.delete(message.id)
        resolve(message)
      }
    }
  }

  send(method, params = {}) {
    const id = ++this.#nextId
    this.#socket.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve) => this.#pending.set(id, resolve))
  }

  /**
   * Runs `expression` as the body of an async function and returns its value by
   * value, so `await` and `return` both work and the caller gets plain data
   * rather than a remote object handle.
   *
   * Throws on a thrown expression rather than returning a sentinel: a probe that
   * quietly records `undefined` for a step that blew up is worse than no probe.
   */
  async evaluate(expression) {
    const response = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true,
      includeCommandLineAPI: true
    })
    const details = response.result?.exceptionDetails
    if (details) {
      throw new Error(details.exception?.description ?? details.text ?? 'Evaluation failed.')
    }
    return response.result?.result?.value
  }

  close() {
    this.#socket.close()
  }
}

async function connect(webSocketDebuggerUrl) {
  const socket = new WebSocket(webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.onopen = resolve
    socket.onerror = () => reject(new Error(`Could not open ${webSocketDebuggerUrl}`))
  })
  return new CdpSession(socket)
}

async function listTargets(endpoint) {
  try {
    return await (await fetch(`${endpoint}/json`)).json()
  } catch {
    return null
  }
}

/** The renderer. `endpoint` overridable for the rare case of a second window. */
export async function connectToRenderer(
  endpoint = process.env.OSCINE_CDP ?? DEFAULT_PAGE_ENDPOINT
) {
  const targets = await listTargets(endpoint)
  if (targets === null) {
    throw new Error(
      `No debugger at ${endpoint}.\n` +
        'Start the app with: npm run dev -- -- --remote-debugging-port=9222'
    )
  }
  const page = targets.find((target) => target.type === 'page')
  if (!page) throw new Error('No renderer page attached to the debugger.')
  return connect(page.webSocketDebuggerUrl)
}

/** The Electron main process, via its Node inspector. */
export async function connectToMain(
  endpoint = process.env.OSCINE_INSPECT ?? DEFAULT_MAIN_ENDPOINT
) {
  const targets = await listTargets(endpoint)
  if (targets === null || targets.length === 0) {
    throw new Error(
      `No main-process inspector at ${endpoint}.\n` +
        'Start the app with: npm run dev -- -- --remote-debugging-port=9222 --inspect=9229'
    )
  }
  return connect(targets[0].webSocketDebuggerUrl)
}

/**
 * Per-process memory, straight from Chromium's own accounting.
 *
 * `workingSetSize` and `peakWorkingSetSize` arrive in KB. The `Tab` entry is the
 * renderer — the process that holds decoded audio, and therefore the only one
 * R1 is really about.
 */
export async function appMetrics(main) {
  const json = await main.evaluate(
    "return JSON.stringify(require('electron').app.getAppMetrics()" +
      '.map((m) => ({ type: m.type, pid: m.pid, kb: m.memory?.workingSetSize ?? 0,' +
      ' peakKb: m.memory?.peakWorkingSetSize ?? 0 })))'
  )
  return JSON.parse(json)
}

/** Renderer working-set in MiB, or null if the tab has gone. */
export async function rendererMiB(main) {
  const tab = (await appMetrics(main)).find((entry) => entry.type === 'Tab')
  return tab ? tab.kb / 1024 : null
}
