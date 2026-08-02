import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WIKIPEDIA_LICENCE_NAME, WIKIPEDIA_LICENCE_URL } from '../../../src/shared/biography'

/**
 * The renderer never renders raw HTML, and the biography always says where it
 * came from.
 *
 * Two properties of the source tree rather than of a mounted component, and
 * that is the point of testing them this way. W7-10's acceptance is absolute —
 * "no unsanitised remote HTML reaches the renderer **under any circumstances**"
 * — and a test that mounts `BiographyPane` and checks one string proves the
 * pane is safe today. Grepping the tree proves that the next pane is too,
 * including the one that renders a MusicBrainz annotation or a podcast show
 * note, which are the two places this rule is most likely to be broken next.
 *
 * `v-html` is the whole surface. Vue escapes interpolated text, so a component
 * that does not use `v-html` cannot inject markup however untrustworthy its
 * data — which is why main's stripping in `wikipedia/extract.ts` is
 * defence-in-depth rather than the defence.
 *
 * The attribution half is here for the same reason it is not a mount test: CC
 * BY-SA obliges us to name the licence and link it, and the failure mode worth
 * catching is somebody deleting the line during a refactor, not it rendering
 * wrong.
 */

const RENDERER = join(__dirname, '../../../src/renderer')

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? walk(path) : [path]
  })
}

/**
 * The two ways a Vue renderer can be made to parse a string as markup.
 *
 * `v-html` is matched as a *binding* rather than as a word, so that a comment
 * explaining why the rule exists is not itself a violation of it — which is
 * otherwise a genuinely annoying way for this test to fail. `innerHTML` covers
 * the escape hatch a component reaching for a DOM node would use.
 */
const INJECTION_POINTS = [/\bv-html\s*=/, /\.innerHTML\b/, /\bouterHTML\b/]

describe('no remote HTML', () => {
  it('has no way to render markup anywhere in the renderer', () => {
    const offenders = walk(RENDERER).filter((path) => {
      if (!path.endsWith('.vue') && !path.endsWith('.ts')) return false
      const source = readFileSync(path, 'utf8')
      return INJECTION_POINTS.some((pattern) => pattern.test(source))
    })

    expect(offenders).toEqual([])
  })

  it('renders the extract through interpolation', () => {
    const pane = readFileSync(join(RENDERER, 'panels/tunedeck/BiographyPane.vue'), 'utf8')
    // The paragraph loop, and it is a moustache rather than a binding.
    expect(pane).toContain('{{ paragraph }}')
  })
})

describe('attribution', () => {
  it('names the licence and links both it and the article', () => {
    const pane = readFileSync(join(RENDERER, 'panels/tunedeck/BiographyPane.vue'), 'utf8')

    expect(pane).toContain('WIKIPEDIA_LICENCE_URL')
    expect(pane).toContain('WIKIPEDIA_LICENCE_NAME')
    expect(pane).toContain('From the Wikipedia article')
    // The article's own URL, which is Wikidata's canonical sitelink.
    expect(pane).toContain(':href="biographies.biography.url"')
  })

  it('points at the version of the licence Wikimedia actually uses', () => {
    // Relicensed from 3.0 in June 2023, and the version is part of what has to
    // be named. A notice naming the wrong one is a claim rather than an
    // omission, which is worse.
    expect(WIKIPEDIA_LICENCE_NAME).toBe('CC BY-SA 4.0')
    expect(WIKIPEDIA_LICENCE_URL).toBe('https://creativecommons.org/licenses/by-sa/4.0/')
  })
})
