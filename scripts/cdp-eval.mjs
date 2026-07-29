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
import { connectToRenderer } from './lib/cdp.mjs'

const expression = process.argv[2]
if (!expression) {
  console.error('Usage: node scripts/cdp-eval.mjs <expression>')
  process.exit(1)
}

let renderer
try {
  renderer = await connectToRenderer()
} catch (error) {
  console.error(error.message)
  process.exit(1)
}

try {
  console.log(JSON.stringify(await renderer.evaluate(expression), null, 2))
} catch (error) {
  console.error(error.message)
  process.exit(1)
} finally {
  renderer.close()
}
