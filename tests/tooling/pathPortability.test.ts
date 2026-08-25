import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'

/**
 * W6-1 asks that a deliberately broken path-handling line fail CI, "proving the
 * check works rather than merely existing". Proving it once by hand would only
 * establish that it worked on the day it was written — an `ignores` entry, a
 * renamed directory or a plugin that silently fails to load would all disarm it
 * without anything going red. So the proof runs on every push instead.
 *
 * This deliberately goes through the real `eslint.config.mjs` rather than
 * instantiating the rule directly. The rule module being correct is the easy
 * half; what actually protects D10 is that the rule is switched on, for `src/`,
 * at error severity. That wiring is what is under test.
 *
 * Neither directory below is on disk. ESLint resolves configuration from a
 * path, not from its contents, so a fictional filename is enough to ask "what
 * would happen to a file here" — and leaves no fixture that a future reader
 * might mistake for real code.
 */

const eslint = new ESLint()

/** Rule ids reported against `code`, as if it lived at `filePath`. */
async function lint(code: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath })
  return result.messages.map((message) => message.ruleId ?? '<fatal>')
}

const RULE = 'oscine/no-windows-path-literals'
const SRC = 'src/main/library/portability-probe.ts'

describe('the Windows-path check is armed for src/', () => {
  it('rejects a backslash separator in a string literal', async () => {
    expect(await lint(`export const root = 'C:\\\\Users\\\\Michael\\\\Music'`, SRC)).toContain(RULE)
  })

  it('rejects a backslash separator inside a template literal', async () => {
    expect(await lint('export const p = (r: string) => `${r}\\\\a.flac`', SRC)).toContain(RULE)
  })

  it('rejects a path assembled by concatenation', async () => {
    expect(await lint(`export const p = (r: string, f: string) => r + '/' + f`, SRC)).toContain(
      RULE
    )
  })

  it('reports at error severity, so lint exits non-zero', async () => {
    const [result] = await eslint.lintText(`export const root = 'C:\\\\Music'`, { filePath: SRC })
    expect(result.errorCount).toBeGreaterThan(0)
  })
})

describe('the check leaves correct code alone', () => {
  it('accepts path.join', async () => {
    const code = [
      `import { join } from 'node:path'`,
      `export const p = (r: string, f: string) => join(r, f)`
    ].join('\n')
    expect(await lint(code, SRC)).not.toContain(RULE)
  })

  it('accepts a separator character class in a regex', async () => {
    // src/main/library/walk.ts does exactly this to split either platform's
    // separator. A rule that broke it would be turned off within the week.
    expect(
      await lint(`export const last = (p: string) => p.split(/[\\\\/]/).pop()`, SRC)
    ).not.toContain(RULE)
  })
})

describe('the check stays out of the way of tests', () => {
  it('allows Windows path fixtures under tests/', async () => {
    // tests/main/db/paths.test.ts is a wall of literal Windows paths by design:
    // driving win32 semantics from a Linux machine is the entire point of it.
    const fixture = 'tests/main/db/portability-probe.test.ts'
    expect(await lint(`const WIN_ROOT = 'C:\\\\Users\\\\Michael\\\\Music'`, fixture)).not.toContain(
      RULE
    )
  })
})
