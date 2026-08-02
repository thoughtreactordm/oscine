/**
 * Keeps the renderer off the network.
 *
 * **D14**'s second rule: fetching happens in the main process only, for the same
 * reason the renderer never opens a file. W7-7's acceptance asks for this to be
 * reviewed and adds "worth a lint rule if it is cheap" — it is, and a review
 * only holds until the next person adds a call.
 *
 * ## What is reported, and what is not
 *
 * `XMLHttpRequest`, `WebSocket`, `EventSource` and `navigator.sendBeacon` are
 * reported unconditionally. None of them can address a local scheme usefully,
 * so there is no false positive to weigh against.
 *
 * `fetch` is not, because two renderer call sites legitimately use it and must
 * keep working:
 *
 *   - `audio/DecodedAudioEngine.ts` reads a track's bytes from a `fermata://`
 *     URL that main minted.
 *   - `playback/browserMediaSession.ts` re-addresses artwork as a blob, because
 *     Chromium's `MediaImage` refuses the `fermata://` scheme however it is
 *     privileged.
 *
 * Both pass a URL that came from main, and neither can be told apart from a
 * remote fetch by looking at the call. So the rule reports the case it *can*
 * decide: a `fetch` whose target is statically a remote URL — a string literal
 * or a template whose head begins `http://`, `https://` or `//`. That catches
 * the way a remote call actually gets written, and a rule that fired on every
 * `fetch(url)` would be turned off within a week.
 *
 * The gap is deliberate and is not the only defence. `registerTrackProtocol`
 * and the CSP bound what the renderer's origin may reach at runtime; this rule
 * is the cheap one that fails at review time instead.
 */

const BANNED_GLOBALS = new Map([
  ['XMLHttpRequest', 'XMLHttpRequest'],
  ['WebSocket', 'WebSocket'],
  ['EventSource', 'EventSource']
])

const REMOTE_URL = /^(https?:)?\/\//i

/** The static head of a fetch target, or `null` when it cannot be known here. */
function staticTarget(node) {
  if (!node) return null
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value
  if (node.type === 'TemplateLiteral' && node.quasis.length > 0) {
    return node.quasis[0].value.cooked ?? null
  }
  return null
}

/** @type {import('eslint').Rule.RuleModule} */
export const noRendererNetwork = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow opening a socket from the renderer process'
    },
    schema: [],
    messages: {
      global:
        'Renderer code may not use {{name}}. D14 puts every outbound request in main — add a ' +
        'channel to src/shared/ipc.ts and go through src/main/net instead.',
      beacon:
        'Renderer code may not use navigator.sendBeacon. D14 puts every outbound request in ' +
        'main — add a channel to src/shared/ipc.ts and go through src/main/net instead.',
      remoteFetch:
        'fetch() to a remote URL from the renderer. D14 puts every outbound request in main — ' +
        'add a channel to src/shared/ipc.ts and go through src/main/net instead. Local ' +
        'fermata:// and blob: reads are fine and are why this rule does not ban fetch outright.'
    }
  },

  create(context) {
    /**
     * True when the name is the genuine global rather than something declared.
     *
     * A local `const WebSocket = ...` — a stub in a test double, a type import
     * shadowing the name — is not the browser global and is not this rule's
     * business. Walking the scope chain answers that; a bare name check does
     * not.
     */
    const isGlobal = (node) => {
      for (let scope = context.sourceCode.getScope(node); scope; scope = scope.upper) {
        const variable = scope.set.get(node.name)
        if (variable) return variable.defs.length === 0
      }
      return true
    }

    return {
      Identifier(node) {
        const name = BANNED_GLOBALS.get(node.name)
        if (!name) return
        // `foo.WebSocket` and `{ WebSocket: x }` are not references to the global.
        if (node.parent?.type === 'MemberExpression' && node.parent.property === node) return
        if (node.parent?.type === 'Property' && node.parent.key === node) return
        if (!isGlobal(node)) return
        context.report({ node, messageId: 'global', data: { name } })
      },

      'MemberExpression[property.name="sendBeacon"]'(node) {
        context.report({ node, messageId: 'beacon' })
      },

      'CallExpression[callee.name="fetch"]'(node) {
        const target = staticTarget(node.arguments[0])
        if (target !== null && REMOTE_URL.test(target)) {
          context.report({ node, messageId: 'remoteFetch' })
        }
      },

      'NewExpression[callee.name="Request"]'(node) {
        const target = staticTarget(node.arguments[0])
        if (target !== null && REMOTE_URL.test(target)) {
          context.report({ node, messageId: 'remoteFetch' })
        }
      }
    }
  }
}

/** Packaged as a plugin so the flat config can name it `fermata/...`. */
export default {
  rules: {
    'no-renderer-network': noRendererNetwork
  }
}
