/**
 * The theme token layer — W8-12, which by decision also carries the token layer
 * W4 was nominally to own. See the wiki page `oscine-theme-token-layer`.
 *
 * Everything here is pure and `@shared`-only so it tests under plain Node, the
 * rule `listViewport` and the settings kernel already follow. Application —
 * writing the custom properties, the `.dark` class, listening to the OS — lives
 * in `src/renderer/theme/`.
 */

export {
  clampToGamut,
  formatOklch,
  isOutOfGamut,
  oklch,
  parseColor,
  relativeLuminance,
  toHex,
  type Oklch
} from './color'

export {
  AA_LARGE,
  AA_NON_TEXT,
  AA_NORMAL,
  CONTRAST_PAIRS,
  STRICT_CONTRAST_PAIRS,
  contrastRatio,
  findContrastFailures,
  type ContrastDemand,
  type ContrastFinding,
  type ContrastPair
} from './contrast'

export { hasOverrides, parseOverrides, withOverride, withoutOverride } from './overrides'

export { TAILWIND_PALETTES, TAILWIND_PALETTE_NAMES } from './palettes'

export {
  RAMP_STEPS,
  SEED_STEP,
  describeRamp,
  isTailwindPalette,
  rampFromSeed,
  resolveRamp,
  type RampSpec,
  type RampStep,
  type RampSteps
} from './ramp'

export {
  resolveTheme,
  type ResolveOptions,
  type ResolvedTheme,
  type ThemeOverrides
} from './resolve'

export {
  BUILT_IN_THEMES,
  DEFAULT_THEME_ID,
  LEGACY_DEFAULT_THEME_ID,
  HIGH_CONTRAST_THEME_ID,
  SEMANTIC_MAPPING,
  STRUCTURAL_DEFAULTS,
  findTheme,
  type BuiltInTheme,
  type SemanticSource,
  type ThemeMode,
  type ThemeVariant
} from './themes'

export {
  COLOR_ROLES,
  FONT_ROLES,
  FONT_STACKS,
  FONT_STYLES,
  FONT_WEIGHTS,
  PUBLIC_TOKENS,
  TOKENS,
  TOKEN_GROUPS,
  findToken,
  rampTokenId,
  type ColorRoleId,
  type FontRoleId,
  type ResolvedTokens,
  type ThemeTokenValues,
  type TokenDescriptor,
  type TokenGroupId,
  type TokenKind
} from './tokens'
