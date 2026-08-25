import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'
import { TAILWIND_PALETTE_NAMES } from '../../src/shared/theme'
// @ts-expect-error — plain .mjs with no types, loaded for its two exported lists.
import { RAW_PALETTE_NAMES, REMAPPED_ROLES } from '../../tools/eslint/no-raw-colours.mjs'

/**
 * The same argument `pathPortability.test.ts` makes, for the other invariant.
 *
 * M5 exits when swapping a theme touches zero component code. Proving that once
 * by hand would establish it held on the day it was written; an `ignores` entry,
 * a renamed directory or a plugin that quietly fails to load would all disarm
 * the check without anything going red.
 *
 * So this goes through the real `eslint.config.mjs` rather than instantiating
 * the rule. The rule being correct is the easy half; what protects the exit
 * criterion is that it is switched on, for the renderer, at error severity.
 */

const eslint = new ESLint()

async function lint(code: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath })
  return result!.messages.map((message) => message.ruleId ?? '<fatal>')
}

const RULE = 'oscine/no-raw-colours'
/** Not on disk. ESLint resolves config from a path, not from its contents. */
const PANEL = 'src/renderer/panels/colour-probe.ts'
const COMPONENT = 'src/renderer/panels/ColourProbe.vue'

describe('the raw-colour check is armed for the renderer', () => {
  it('rejects a hex colour', async () => {
    expect(await lint(`export const c = '#1e293b'`, PANEL)).toContain(RULE)
  })

  it('rejects a colour function', async () => {
    expect(await lint(`export const c = 'rgb(30 41 59)'`, PANEL)).toContain(RULE)
    expect(await lint(`export const c = 'oklch(50% 0.1 200)'`, PANEL)).toContain(RULE)
  })

  it('rejects a colour inside a template literal', async () => {
    expect(await lint('export const c = (a: number) => `rgba(0,0,0,${a})`', PANEL)).toContain(RULE)
  })

  it('rejects a raw Tailwind palette utility', async () => {
    expect(await lint(`export const c = 'bg-slate-800'`, PANEL)).toContain(RULE)
    expect(await lint(`export const c = 'text-rose-500'`, PANEL)).toContain(RULE)
  })

  it('rejects one in a component class attribute', async () => {
    // The common case, and the one a script-only visitor would miss entirely.
    const vue = `<template><div class="flex bg-slate-800 p-2" /></template>`
    expect(await lint(vue, COMPONENT)).toContain(RULE)
  })

  it('rejects a hex in a component template expression', async () => {
    const vue = `<template><div :style="{ color: '#ff0000' }" /></template>`
    expect(await lint(vue, COMPONENT)).toContain(RULE)
  })

  it('reports at error severity, so lint exits non-zero', async () => {
    const [result] = await eslint.lintText(`export const c = '#1e293b'`, { filePath: PANEL })
    expect(result!.errorCount).toBeGreaterThan(0)
  })
})

describe('the check leaves themeable code alone', () => {
  it('accepts Nuxt UI semantic classes', async () => {
    const vue = `<template><div class="bg-elevated text-highlighted border-default" /></template>`
    expect(await lint(vue, COMPONENT)).not.toContain(RULE)
  })

  it('accepts the roles the bridge drives', async () => {
    // `bg-neutral-800` compiles to var(--ui-color-neutral-800), which the
    // bridge assigns from the token layer. Flagging it would push people off
    // the themeable path.
    const vue = `<template><div class="bg-neutral-800 text-primary ring-warning/40" /></template>`
    expect(await lint(vue, COMPONENT)).not.toContain(RULE)
  })

  it('accepts a --oscine-* custom property', async () => {
    expect(await lint(`export const c = 'var(--oscine-surface-base)'`, PANEL)).not.toContain(RULE)
  })

  it('accepts selectors that merely start with a hash', async () => {
    // `#app` and `#setting-library-artworkCacheMb` are both real in this app.
    expect(await lint(`export const s = '#app'`, PANEL)).not.toContain(RULE)
    expect(await lint(`export const s = '#setting-library-artworkCacheMb'`, PANEL)).not.toContain(
      RULE
    )
  })

  it('exempts the theme layer, which is what names colours', async () => {
    const inTheme = 'src/renderer/theme/probe.ts'
    expect(await lint(`export const c = 'oklch(50% 0.1 200)'`, inTheme)).not.toContain(RULE)
  })
})

describe('the palette list tracks Tailwind', () => {
  it('accounts for every shipped ramp exactly once', () => {
    // A Tailwind upgrade that adds a ramp must fail here rather than silently
    // opening a hole in the rule.
    const covered = [...(RAW_PALETTE_NAMES as string[]), ...(REMAPPED_ROLES as string[])]
    const missing = TAILWIND_PALETTE_NAMES.filter((name) => !covered.includes(name))
    expect(missing).toEqual([])
  })

  it('does not flag a role the bridge remaps', () => {
    for (const role of REMAPPED_ROLES as string[]) {
      expect(RAW_PALETTE_NAMES as string[]).not.toContain(role)
    }
  })
})

/**
 * The gap the rule cannot reach.
 *
 * ESLint parses a component's script and template; its `<style>` block is part
 * of neither AST. Scoped styles are exactly where a stray hex would hide, so
 * they are scanned directly for the same patterns.
 */
function vueFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) vueFiles(path, acc)
    else if (entry.endsWith('.vue')) acc.push(path)
  }
  return acc
}

const CSS_COLOUR =
  /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b|\b(?:rgba?|hsla?|oklch|oklab)\(/

describe('component style blocks name no colours either', () => {
  it('finds none across every .vue file', () => {
    const offenders: string[] = []

    for (const file of vueFiles(resolve('src/renderer'))) {
      const source = readFileSync(file, 'utf8')
      for (const block of source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) {
        // Comments in a style block are prose, not shipped colour.
        const css = block[1]!.replace(/\/\*[\s\S]*?\*\//g, '')
        if (CSS_COLOUR.test(css)) offenders.push(file.replace(resolve('.') + '/', ''))
      }
    }

    expect(offenders).toEqual([])
  })

  it('would notice one if it appeared', () => {
    // A scan that cannot fail is a scan nobody should trust.
    expect(CSS_COLOUR.test('.x { color: #1e293b; }')).toBe(true)
    expect(CSS_COLOUR.test('.x { color: var(--oscine-text-base); }')).toBe(false)
  })
})
