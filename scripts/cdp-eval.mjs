#!/usr/bin/env node
/**
 * Runs an expression inside the running renderer and prints what it returns.
 *
 * Several M1 cards have acceptance criteria that are behavioural — a list keeps
 * a flat DOM node count across 100k rows, a sort click returns without
 * perceptible delay — and none of them can be checked by reading code or by
 * looking at a screenshot. This is the smallest thing that can check them. The
 * design doc names Playwright for Electron smoke tests; until that lands, this
 * is how a UI card proves its claims.
 *
 * Start the app with a debugging port first. It is a launch flag, not a change
 * to the app, so the shipped binary is unaffected:
 *
 *   npm run dev -- -- --remote-debugging-port=9222
 *
 * Then, for example:
 *
 *   node scripts/cdp-eval.mjs 'return document.querySelectorAll("[role=row]").length'
 *
 * The expression is wrapped in an async function, so `await` and `return` both
 * work and the result is serialised by value.
 */
const ENDPOINT = process.env.FERMATA_CDP ?? 'http://127.0.0.1:9222'

const expression = process.argv[2]
if (!expression) {
  console.error('Usage: node scripts/cdp-eval.mjs <expression>')
  process.exit(1)
}

let targets
try {
  targets = await (await fetch(`${ENDPOINT}/json`)).json()
} catch {
  console.error(`No debugger at ${ENDPOINT}.`)
  console.error('Start the app with: npm run dev -- -- --remote-debugging-port=9222')
  process.exit(1)
}

const page = targets.find((target) => target.type === 'page')
if (!page) {
  console.error('No renderer page attached to the debugger.')
  process.exit(1)
}

const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve) => (socket.onopen = resolve))

let nextId = 0
const pending = new Map()
socket.onmessage = (event) => {
  const message = JSON.parse(event.data)
  const resolve = pending.get(message.id)
  if (resolve) {
    pending.delete(message.id)
    resolve(message)
  }
}

function send(method, params = {}) {
  const id = ++nextId
  socket.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve) => pending.set(id, resolve))
}

const response = await send('Runtime.evaluate', {
  expression: `(async () => { ${expression} })()`,
  awaitPromise: true,
  returnByValue: true
})

socket.close()

if (response.result?.exceptionDetails) {
  console.error(response.result.exceptionDetails.exception?.description ?? 'Evaluation failed.')
  process.exit(1)
}

console.log(JSON.stringify(response.result?.result?.value ?? response.result, null, 2))
