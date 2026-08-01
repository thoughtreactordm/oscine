/**
 * Catches colours written into a component instead of taken from the theme.
 *
 * M5's exit criterion is that swapping a theme touches zero component code, and
 * W8-12's card says that if the token layer needs a component edit to work then
 * it is not finished. Both are properties that hold on the day they are checked
 * and quietly stop holding later: one hex in one hover state is invisible until
 * somebody switches to a theme it clashes with. That is what this is for.
 *
 * Two shapes are reported:
 *
 *   1. A CSS colour in a string or template literal — `#1e293b`, `rgb(...)`,
 *      `oklch(...)`. The token layer is the only place a colour is allowed to
 *      be named; everything else asks for `--fermata-*` through a semantic
 *      class or a custom property.
 *   2. A bare Tailwind palette utility — `bg-slate-800`, `text-rose-500`. These
 *      look themeable and are not: `slate` is a raw Tailwind ramp that nothing
 *      remaps, so a theme swap leaves it exactly where it was.
 *
 * ## What is deliberately allowed
 *
 * The roles Nuxt UI remaps — `primary`, `secondary`, `success`, `info`,
 * `warning`, `error` and `neutral`. `bg-neutral-800` compiles to
 * `var(--ui-color-neutral-800)`, which the bridge assigns from the token layer,
 * so it is themeable and correct. Only the raw ramps are a problem, which is
 * why the list below is Tailwind's palettes *minus* those seven.
 *
 * ## What this cannot see
 *
 * `<style>` blocks in `.vue` files. ESLint parses a component's script and
 * template; its styles are not part of either AST. `tests/tooling/rawColours.
 * test.ts` scans them directly for the same patterns, so the gap is covered —
 * but it is covered there, not here.
 */

/**
 * Tailwind's ramp names that are *not* remapped onto the token layer.
 *
 * Hardcoded because this file is plain `.mjs` loaded by ESLint and cannot
 * import from `src/shared/theme`. `tests/tooling/rawColours.test.ts`
 * cross-checks it against `TAILWIND_PALETTE_NAMES`, so a Tailwind upgrade that
 * adds a ramp fails a test rather than silently opening a hole.
 */
const RAW_PALETTES = [
  'red',
  'orange',
  'amber',
  'yellow',
  'lime',
  'green',
  'emerald',
  'teal',
  'cyan',
  'sky',
  'blue',
  'indigo',
  'violet',
  'purple',
  'fuchsia',
  'pink',
  'rose',
  'slate',
  'gray',
  'zinc',
  'stone',
  'mauve',
  'olive',
  'mist',
  'taupe'
]

/** The roles the bridge drives, which are themeable and must not be reported. */
export const REMAPPED_ROLES = [
  'primary',
  'secondary',
  'success',
  'info',
  'warning',
  'error',
  'neutral'
]

export const RAW_PALETTE_NAMES = RAW_PALETTES

/**
 * A hex colour, or a CSS colour function.
 *
 * The hex form is anchored on a word boundary so `#app` and `#setting-foo-bar`
 * — both real selectors in this app — cannot match: they contain letters
 * outside `a-f`, and the length alternation refuses anything that is not 3, 4,
 * 6 or 8 digits.
 */
const CSS_COLOUR =
  /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b|\b(?:rgba?|hsla?|oklch|oklab|lch|lab|color-mix)\(/

const PALETTE_UTILITY = new RegExp(
  String.raw`\b(?:bg|text|border|ring|outline|decoration|shadow|fill|stroke|from|via|to|accent|caret|divide|placeholder)-(?:${RAW_PALETTES.join('|')})-(?:50|\d{3})\b`
)

/** @type {import('eslint').Rule.RuleModule} */
export const noRawColours = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow CSS colour literals and raw Tailwind palette utilities outside the theme layer'
    },
    schema: [],
    messages: {
      literal:
        'CSS colour written by hand. Components render against the token layer — use a Nuxt UI ' +
        'semantic class (text-highlighted, bg-elevated, border-default) or a --fermata-* custom ' +
        'property. If this is genuinely not a theme colour, disable this rule on the line and say why.',
      palette:
        'Raw Tailwind palette utility. "{{ name }}" is a ramp nothing remaps, so a theme swap ' +
        'leaves it where it is. Use a semantic class, or one of the remapped roles ' +
        '(primary, neutral, warning, ...) which the bridge drives from the token layer.'
    }
  },

  create(context) {
    const report = (node, value) => {
      if (typeof value !== 'string' || value.length === 0) return
      if (CSS_COLOUR.test(value)) {
        context.report({ node, messageId: 'literal' })
        return
      }
      const match = PALETTE_UTILITY.exec(value)
      if (match) context.report({ node, messageId: 'palette', data: { name: match[0] } })
    }

    const scriptVisitor = {
      Literal(node) {
        report(node, node.value)
      },
      TemplateElement(node) {
        report(node, node.value.cooked)
      }
    }

    /*
     * Attribute values are `VLiteral` and belong to the template AST, which
     * `vue-eslint-parser` only exposes through this hook. A plain `class="..."`
     * is exactly where a stray palette utility lives, so skipping it would miss
     * the common case entirely.
     */
    const templateVisitor = {
      VLiteral(node) {
        report(node, node.value)
      },
      Literal(node) {
        report(node, node.value)
      },
      TemplateElement(node) {
        report(node, node.value.cooked)
      }
    }

    const services = context.sourceCode?.parserServices ?? context.parserServices
    if (typeof services?.defineTemplateBodyVisitor === 'function') {
      return services.defineTemplateBodyVisitor(templateVisitor, scriptVisitor)
    }
    return scriptVisitor
  }
}
