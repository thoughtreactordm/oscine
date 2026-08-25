/**
 * Catches path handling that only works on Windows.
 *
 * D10 makes Linux and Windows both first-class, and this bug class is invisible
 * on the machine that introduces it: a backslash-joined path is a perfectly good
 * path until someone opens the library on the other OS. The invariant it guards
 * is the one in CLAUDE.md — paths are stored relative to a named root, POSIX
 * normalised on write, rejoined per-platform on read — so any separator that
 * gets written by hand is already outside the sanctioned route.
 *
 * Three shapes are reported:
 *
 *   1. A string literal whose value contains a backslash. `'C:\\Users'`,
 *      `'\\\\server\\share'`, `'Rock\\a.mp3'`. Regex literals are a different
 *      AST node and are left alone, so `/[\\/]/` stays legal.
 *   2. The same, inside a template literal's static parts.
 *   3. `+` concatenation against a bare separator — `root + '/' + rel`. Even the
 *      POSIX-looking form is wrong here, because the correct call (`path.join`,
 *      or the helpers in `src/main/db/paths.ts`) is what normalises `..` and
 *      collapses duplicate separators. Hand-joining skips that.
 *
 * The rule is deliberately syntactic. It cannot tell a path from any other
 * string, which is why it is scoped to `src/` in the flat config: test fixtures
 * legitimately spell out Windows paths, and `tests/main/db/paths.test.ts` is
 * nothing but.
 */

/**
 * A literal made of nothing but separators — `'/'`, `'\\'`, `'//'`.
 *
 * Narrow on purpose. `x + '/subdir'` is arguably the same mistake, but it is
 * also how every URL in the app is built, and a rule that cries wolf gets
 * disabled wholesale. A bare separator has no second reading.
 */
const SEPARATOR_ONLY = /^[/\\]+$/

/** @type {import('eslint').Rule.RuleModule} */
export const noWindowsPathLiterals = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow backslash path separators and hand-rolled path concatenation in shipped code'
    },
    schema: [],
    messages: {
      backslash:
        'Backslash in a string literal. Paths are stored POSIX-normalised and rejoined with ' +
        "node:path per platform; a literal '\\' only works on Windows. If this string is not a " +
        'path, disable this rule on the line with a comment saying so.',
      concatenation:
        'Path built by string concatenation. Use path.join / path.resolve, or the helpers in ' +
        'src/main/db/paths.ts, so normalisation and the platform separator are not left to chance.'
    }
  },

  create(context) {
    /** Backslash survives into the cooked value only when it was escaped in source. */
    const hasBackslash = (value) => typeof value === 'string' && value.includes('\\')

    return {
      Literal(node) {
        // `node.regex` marks a regex literal, whose `value` is a RegExp object.
        if (node.regex !== undefined) return
        if (hasBackslash(node.value)) {
          context.report({ node, messageId: 'backslash' })
        }
      },

      TemplateElement(node) {
        if (hasBackslash(node.value.cooked)) {
          context.report({ node, messageId: 'backslash' })
        }
      },

      BinaryExpression(node) {
        if (node.operator !== '+') return
        for (const side of [node.left, node.right]) {
          if (side.type !== 'Literal' || typeof side.value !== 'string') continue
          // A backslash separator is already reported by the Literal visitor;
          // reporting it twice on one expression helps nobody.
          if (side.value.includes('\\')) continue
          if (SEPARATOR_ONLY.test(side.value)) {
            context.report({ node, messageId: 'concatenation' })
            return
          }
        }
      }
    }
  }
}

/** Packaged as a plugin so the flat config can name it `oscine/...`. */
export default {
  rules: {
    'no-windows-path-literals': noWindowsPathLiterals
  }
}
