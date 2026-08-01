import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { COLOR_ROLES, PUBLIC_TOKENS, RAMP_STEPS, TOKENS } from '@shared/theme'

/** Every `.vue` and `.css` under the renderer, as one string. */
function rendererStyleSources(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) rendererStyleSources(path, acc)
    else if (entry.endsWith('.vue') || entry.endsWith('.css')) acc.push(readFileSync(path, 'utf8'))
  }
  return acc
}

/**
 * The bridge is the whole reason a theme swap touches zero component code, and
 * it is a CSS file no type checker looks at. These read it as text.
 *
 * A token the catalog defines and the bridge never references is a token that
 * appears in the editor, accepts a value, and changes nothing — the worst
 * failure this layer can have, because it looks like it works.
 */
const BRIDGE = readFileSync(resolve('src/renderer/theme/bridge.css'), 'utf8')

/**
 * The bridge is the usual consumer, but not the only legitimate one: the
 * now-playing tokens are read straight out of `NowPlaying.vue`, which is why
 * they kept the variable names they shipped with.
 */
const RENDERER_STYLES = rendererStyleSources(resolve('src/renderer')).join('\n')

describe('the bridge', () => {
  it('assigns every step of every colour role', () => {
    const missing: string[] = []
    for (const role of COLOR_ROLES) {
      for (const step of RAMP_STEPS) {
        const assignment = `--ui-color-${role.id}-${step}: var(--fermata-color-${role.id}-${step});`
        if (!BRIDGE.includes(assignment)) missing.push(assignment)
      }
    }
    expect(missing).toEqual([])
  })

  it('wires every public token to something that reads it', () => {
    // The failure this guards against: a token that appears in the editor,
    // accepts a value and changes nothing. It caught `shape.borderWidth`,
    // which could not work because Tailwind compiles `.border` to a literal
    // `border-width: 1px` with no variable behind it.
    const unwired = PUBLIC_TOKENS.filter((token) => {
      // A ramp is wired through its per-step assignments, checked above.
      if (token.kind === 'ramp') return false
      return !RENDERER_STYLES.includes(`var(${token.cssVar})`)
    }).map((token) => token.id)

    expect(unwired).toEqual([])
  })

  it('defines the accent variables the generated stylesheet leaves undefined', () => {
    // `--color-primary: var(--ui-primary)` ships with nothing defining
    // `--ui-primary`. Without these, every accent in the app resolves to an
    // undefined custom property.
    for (const role of COLOR_ROLES) {
      if (role.id === 'neutral') continue
      expect(BRIDGE, role.id).toContain(`--ui-${role.id}: var(--fermata-accent-${role.id});`)
    }
  })

  it('drives the Tailwind ladders that let shape and type be themeable', () => {
    // `rounded-lg` compiles to `var(--radius-lg)`, so this is what re-shapes
    // every rounded thing in the app without a component edit.
    for (const name of ['xs', 'sm', 'md', 'lg', 'xl', '2xl', '3xl', '4xl']) {
      expect(BRIDGE, `--radius-${name}`).toContain(`--radius-${name}:`)
    }
    for (const name of ['xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl', '4xl']) {
      expect(BRIDGE, `--text-${name}`).toContain(`--text-${name}:`)
    }
  })

  it('sets the body font on the element, not only through --font-sans', () => {
    // `--default-font-family: --theme(--font-sans, initial)` resolves at build
    // time, so overriding `--font-sans` alone does not move the body font.
    expect(BRIDGE).toMatch(/body\s*\{[^}]*font-family:\s*var\(--fermata-type-body-family\)/)
  })

  it('declares no colour of its own', () => {
    // Every right-hand side must be a token reference. A literal here would be
    // a colour no theme can reach and no contrast check can see.
    const literals = BRIDGE.match(/#[0-9a-fA-F]{3,8}\b|\b(rgba?|hsla?|oklch|oklab)\(/g) ?? []
    expect(literals).toEqual([])
  })

  it('references only tokens the catalog defines', () => {
    // The mirror of the unwired check: a bridge line pointing at a token that
    // does not exist silently resolves to nothing.
    const known = new Set(TOKENS.flatMap((t) => (t.kind === 'ramp' ? [] : [t.cssVar])))
    for (const role of COLOR_ROLES) {
      for (const step of RAMP_STEPS) known.add(`--fermata-color-${role.id}-${step}`)
    }

    const referenced = [...BRIDGE.matchAll(/var\((--fermata-[a-z0-9-]+)\)/g)].map((m) => m[1]!)
    const unknown = [...new Set(referenced)].filter((name) => !known.has(name))
    expect(unknown).toEqual([])
  })
})
