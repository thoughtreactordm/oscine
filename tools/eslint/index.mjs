/**
 * The `oscine` ESLint plugin: the repo's own rules, in one place.
 *
 * A barrel rather than importing a rule module directly, which is what the flat
 * config did while there was only one. Both rules guard an invariant from
 * CLAUDE.md that is invisible on the machine that breaks it — a backslash path
 * works fine until the library is opened on the other OS, and a hardcoded
 * colour looks correct until someone switches theme.
 */

import { noRawColours } from './no-raw-colours.mjs'
import { noRendererNetwork } from './no-renderer-network.mjs'
import { noWindowsPathLiterals } from './no-windows-path-literals.mjs'

export default {
  rules: {
    'no-raw-colours': noRawColours,
    'no-renderer-network': noRendererNetwork,
    'no-windows-path-literals': noWindowsPathLiterals
  }
}
