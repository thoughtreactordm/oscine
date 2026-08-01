/**
 * The token catalog — the public surface of the theme layer.
 *
 * This file *is* the T1 commitment. Every id here is a name we have said we
 * will keep stable, because an operator's overrides are keyed by it and a
 * rename silently orphans their work. Adding a token is free; renaming or
 * removing one is a breaking change to somebody's saved theme.
 *
 * The split that makes that commitment affordable is `public: false`. Internal
 * tokens exist for the same reasons any implementation detail does — the bridge
 * needs somewhere to put a derived value — and the editor never shows them, so
 * they carry no promise at all. D9's concern was an unbounded public API; this
 * is where the bound is drawn.
 *
 * Structurally this mirrors the settings registry: a descriptor names a control
 * so exactly one component knows how to render each kind, and nothing else in
 * the app switches on a token's type.
 */

import type { RampSteps } from './ramp'

/** What kind of value a token holds, and therefore how it is edited. */
export type TokenKind =
  | 'ramp'
  | 'color'
  | 'length'
  | 'duration'
  | 'easing'
  | 'fontFamily'
  | 'fontWeight'
  | 'fontStyle'
  | 'number'

/**
 * Editor grouping. Ordered as declared — the editor renders groups in this
 * order, so it is the reading order of the whole surface.
 */
export const TOKEN_GROUPS = [
  {
    id: 'color',
    label: 'Colour roles',
    help: 'The ramps every surface, border and state is built from.'
  },
  {
    id: 'accent',
    label: 'Accents',
    help: 'The one step of each role that lands on a surface as text or fill.'
  },
  { id: 'surface', label: 'Surfaces', help: 'Backgrounds, from the window through to a popover.' },
  { id: 'text', label: 'Text', help: 'The weights of foreground text, dimmest to brightest.' },
  { id: 'border', label: 'Borders', help: 'Dividers, outlines and control edges.' },
  { id: 'shape', label: 'Shape', help: 'Corner rounding and edge weight.' },
  { id: 'type', label: 'Type', help: 'Fonts for headings, list rows and everything else.' },
  {
    id: 'motion',
    label: 'Motion',
    help: 'Transition timing. Clamped to zero when the system asks for reduced motion.'
  },
  { id: 'nowPlaying', label: 'Now playing', help: 'The cover backdrop behind the transport.' }
] as const

export type TokenGroupId = (typeof TOKEN_GROUPS)[number]['id']

export interface TokenDescriptor {
  /** Stable id. The override map is keyed by this. */
  readonly id: string
  /**
   * The CSS custom property it lands on. Usually derivable from the id, but not
   * always — the now-playing tokens keep the names they shipped with so that
   * migrating them into the catalog costs zero component edits.
   */
  readonly cssVar: string
  readonly kind: TokenKind
  readonly group: TokenGroupId
  readonly label: string
  readonly help: string
  /** Substrings the editor's search matches beyond label and id. */
  readonly keywords: readonly string[]
  readonly order: number
  /** False keeps it out of the editor and out of the T1 promise. */
  readonly public: boolean
}

/** The six semantic colour roles plus the neutral ramp everything greys against. */
export const COLOR_ROLES = [
  {
    id: 'primary',
    label: 'Primary',
    help: 'The accent. Focus rings, the playing indicator, primary buttons.'
  },
  { id: 'secondary', label: 'Secondary', help: 'The supporting accent.' },
  { id: 'success', label: 'Success', help: 'Completed scans, confirmed writes.' },
  { id: 'info', label: 'Info', help: 'Neutral notices.' },
  { id: 'warning', label: 'Warning', help: 'The restart-required badge, cancellable jobs.' },
  { id: 'error', label: 'Error', help: 'Failed reads, missing files, rejected input.' },
  {
    id: 'neutral',
    label: 'Neutral',
    help: 'Greys. Every surface, border and text weight derives from this ramp.'
  }
] as const

export type ColorRoleId = (typeof COLOR_ROLES)[number]['id']

/**
 * The token ids a resolved theme actually holds for a colour role.
 *
 * A role is stored as one `ramp` token — `color.primary` — but resolves to
 * eleven `color.primary-<step>` entries, because that is the granularity the
 * bridge writes and the contrast checker reads. The editor edits the former;
 * everything downstream sees the latter.
 */
export function rampTokenId(role: ColorRoleId | string, step: string): string {
  return `color.${role}-${step}`
}

function colorRoleDescriptors(): TokenDescriptor[] {
  return COLOR_ROLES.map((role, index) => ({
    id: `color.${role.id}`,
    cssVar: `--fermata-color-${role.id}`,
    kind: 'ramp' as const,
    group: 'color' as const,
    label: role.label,
    help: role.help,
    keywords: ['ramp', 'palette', 'accent', 'colour', 'color', role.id],
    order: (index + 1) * 10,
    public: true
  }))
}

/**
 * The single step of each role that actually lands on a surface.
 *
 * `text-primary` and `bg-primary` do not resolve to a ramp — they resolve to
 * one colour, Nuxt UI's `--ui-primary`, and that colour has to differ between
 * light and dark or it fails contrast in one of them. A mid-ramp amber that
 * reads correctly on a dark surface is around 2:1 on a white one.
 *
 * These exist as their own tokens rather than as a hardcoded step of the ramp
 * so the mapping is visible, checkable and overridable — and because the
 * variable they drive is, as shipped, referenced by `--color-primary` and
 * defined nowhere. Without these the app's accent colours resolve to an
 * undefined custom property.
 */
function accentDescriptors(): TokenDescriptor[] {
  return COLOR_ROLES.filter((role) => role.id !== 'neutral').map((role, index) => ({
    id: `accent.${role.id}`,
    cssVar: `--fermata-accent-${role.id}`,
    kind: 'color' as const,
    group: 'accent' as const,
    label: role.label,
    help: `${role.label} as it appears on a surface — text, icons and fills.`,
    keywords: ['accent', 'on surface', 'foreground', 'colour', 'color', role.id],
    order: (index + 1) * 10,
    public: true
  }))
}

/**
 * Surface, text and border tokens.
 *
 * These are single colours rather than ramps, and they are exactly the set Nuxt
 * UI's semantic variables consume — `--ui-bg-elevated` and friends. Keeping the
 * public names one-to-one with that set is deliberate: every one of the 40
 * components already renders against it, so a value written here is visible
 * without anything being rewired.
 */
const SEMANTIC_COLORS: readonly Omit<TokenDescriptor, 'kind' | 'public'>[] = [
  {
    id: 'surface.base',
    cssVar: '--fermata-surface-base',
    group: 'surface',
    label: 'Window',
    help: 'The base background the app sits on.',
    keywords: ['background', 'bg', 'body'],
    order: 10
  },
  {
    id: 'surface.muted',
    cssVar: '--fermata-surface-muted',
    group: 'surface',
    label: 'Recessed',
    help: 'Table headers and inset wells — a step back from the window.',
    keywords: ['background', 'inset', 'well', 'header'],
    order: 20
  },
  {
    id: 'surface.elevated',
    cssVar: '--fermata-surface-elevated',
    group: 'surface',
    label: 'Raised',
    help: 'Rails, popovers, the drawer — a step forward from the window.',
    keywords: ['background', 'panel', 'popover', 'card'],
    order: 30
  },
  {
    id: 'surface.accented',
    cssVar: '--fermata-surface-accented',
    group: 'surface',
    label: 'Accented',
    help: 'Hovered rows and pressed controls.',
    keywords: ['background', 'hover', 'active'],
    order: 40
  },
  {
    id: 'surface.inverted',
    cssVar: '--fermata-surface-inverted',
    group: 'surface',
    label: 'Inverted',
    help: 'Tooltips and toasts, which read against the opposite of everything else.',
    keywords: ['background', 'tooltip', 'toast'],
    order: 50
  },

  {
    id: 'text.dimmed',
    cssVar: '--fermata-text-dimmed',
    group: 'text',
    label: 'Dimmed',
    help: 'Placeholders and disabled controls.',
    keywords: ['foreground', 'placeholder', 'disabled'],
    order: 10
  },
  {
    id: 'text.muted',
    cssVar: '--fermata-text-muted',
    group: 'text',
    label: 'Muted',
    help: 'Artist, album and duration beside a track title.',
    keywords: ['foreground', 'secondary', 'subtitle'],
    order: 20
  },
  {
    id: 'text.toned',
    cssVar: '--fermata-text-toned',
    group: 'text',
    label: 'Toned',
    help: 'Help text under a setting.',
    keywords: ['foreground', 'help', 'description'],
    order: 30
  },
  {
    id: 'text.base',
    cssVar: '--fermata-text-base',
    group: 'text',
    label: 'Body',
    help: 'Ordinary reading text.',
    keywords: ['foreground', 'default', 'body'],
    order: 40
  },
  {
    id: 'text.highlighted',
    cssVar: '--fermata-text-highlighted',
    group: 'text',
    label: 'Highlighted',
    help: 'Headings, track titles, the selected row.',
    keywords: ['foreground', 'heading', 'title', 'emphasis'],
    order: 50
  },
  {
    id: 'text.inverted',
    cssVar: '--fermata-text-inverted',
    group: 'text',
    label: 'Inverted',
    help: 'Text on an inverted surface.',
    keywords: ['foreground', 'tooltip', 'toast'],
    order: 60
  },

  {
    id: 'border.muted',
    cssVar: '--fermata-border-muted',
    group: 'border',
    label: 'Muted',
    help: 'The quietest dividers.',
    keywords: ['divider', 'rule', 'separator'],
    order: 10
  },
  {
    id: 'border.base',
    cssVar: '--fermata-border-base',
    group: 'border',
    label: 'Default',
    help: 'Panel edges and list separators.',
    keywords: ['divider', 'outline', 'edge'],
    order: 20
  },
  {
    id: 'border.accented',
    cssVar: '--fermata-border-accented',
    group: 'border',
    label: 'Accented',
    help: 'Input outlines and the scrollbar thumb.',
    keywords: ['outline', 'input', 'scrollbar', 'focus'],
    order: 30
  },
  {
    id: 'border.inverted',
    cssVar: '--fermata-border-inverted',
    group: 'border',
    label: 'Inverted',
    help: 'Edges on an inverted surface.',
    keywords: ['outline', 'tooltip'],
    order: 40
  }
]

/**
 * Shape, type and motion.
 *
 * Each of these drives a Tailwind theme variable, which is what lets them be
 * themeable without a component edit: `rounded-lg` compiles to
 * `var(--radius-lg)`, so redefining the radius ladder from one base value
 * re-shapes every rounded thing in the app. The ladders are derived rather than
 * exposed step by step — eight radius tokens would be eight names to keep
 * stable in exchange for control nobody asked for.
 */
const STRUCTURAL: readonly TokenDescriptor[] = [
  {
    id: 'shape.radius',
    cssVar: '--fermata-shape-radius',
    kind: 'length',
    group: 'shape',
    label: 'Corner radius',
    help: 'The base rounding. Every larger radius in the app is a multiple of it.',
    keywords: ['rounded', 'corner', 'square', 'radius'],
    order: 10,
    public: true
  },
  /*
   * There is no border-width token, and it is not an oversight.
   *
   * Tailwind compiles `.border` to a literal `border-width: 1px` with no
   * variable behind it — unlike `--radius-*` and `--text-*`, which are exactly
   * why shape and type are themeable at all. A border-width token could be
   * defined, would appear in the editor, would accept a value, and would change
   * nothing until all 40 components had their `border` classes rewritten. A
   * control that silently does nothing is worse than an absent one.
   */

  {
    id: 'type.baseSize',
    cssVar: '--fermata-type-base-size',
    kind: 'length',
    group: 'type',
    label: 'Base text size',
    help: 'The size everything else scales from.',
    keywords: ['font size', 'scale', 'bigger', 'smaller', 'zoom'],
    order: 10,
    public: true
  },

  {
    id: 'motion.duration',
    cssVar: '--fermata-motion-duration',
    kind: 'duration',
    group: 'motion',
    label: 'Transition speed',
    help: 'How long a transition takes. Forced to zero when the system asks for reduced motion.',
    keywords: ['animation', 'transition', 'speed', 'fast', 'slow'],
    order: 10,
    public: true
  },
  {
    id: 'motion.easing',
    cssVar: '--fermata-motion-easing',
    kind: 'easing',
    group: 'motion',
    label: 'Easing',
    help: 'The curve a transition follows.',
    keywords: ['animation', 'curve', 'bezier', 'timing'],
    order: 20,
    public: true
  },

  /*
   * These three keep the CSS variable names they shipped with, rather than
   * being renamed into the `--fermata-now-playing-*` shape the ids suggest.
   * Renaming them would mean editing NowPlaying — the one component edit this
   * whole card exists to prove is unnecessary. The id is the stable name; the
   * variable is an implementation detail the bridge owns.
   */
  {
    id: 'nowPlaying.coverBleed',
    cssVar: '--fermata-cover-bleed',
    kind: 'number',
    group: 'nowPlaying',
    label: 'Cover bleed',
    help: 'How much of the cover art shows through behind the transport.',
    keywords: ['artwork', 'backdrop', 'opacity', 'glow'],
    order: 10,
    public: true
  },
  {
    id: 'nowPlaying.coverBlur',
    cssVar: '--fermata-cover-blur',
    kind: 'length',
    group: 'nowPlaying',
    label: 'Cover blur',
    help: 'How soft the cover backdrop is.',
    keywords: ['artwork', 'backdrop', 'blur', 'soft'],
    order: 20,
    public: true
  },
  {
    id: 'nowPlaying.coverDrift',
    cssVar: '--fermata-cover-drift',
    kind: 'duration',
    group: 'nowPlaying',
    label: 'Cover drift',
    help: 'How long the cover backdrop takes to travel its cycle.',
    keywords: ['artwork', 'backdrop', 'animation', 'drift', 'motion'],
    order: 30,
    public: true
  },

  /*
   * Fixed across themes on purpose: these sit over whatever image the file
   * carried, so their contrast has to be won against an unknown picture rather
   * than against a surface. A theme that could tint them would be a theme that
   * could make cover-art text unreadable in a way no contrast pair can catch.
   */
  {
    id: 'nowPlaying.scrim',
    cssVar: '--fermata-scrim',
    kind: 'color',
    group: 'nowPlaying',
    label: 'Cover scrim',
    help: 'The wash over cover art that text sits on.',
    keywords: ['scrim', 'overlay', 'artwork'],
    order: 40,
    public: false
  },
  {
    id: 'nowPlaying.onScrim',
    cssVar: '--fermata-on-scrim',
    kind: 'color',
    group: 'nowPlaying',
    label: 'Text on scrim',
    help: 'Text over cover art.',
    keywords: ['scrim', 'overlay', 'artwork'],
    order: 50,
    public: false
  }
]

/** The three font roles T11 names, each with a family, a weight and a slant. */
export const FONT_ROLES = [
  {
    id: 'heading',
    label: 'Headings',
    help: 'Section titles, panel headers, the now-playing title.',
    order: 20
  },
  {
    id: 'list',
    label: 'List rows',
    help: 'Track, album and artist rows. The densest text in the app.',
    order: 30
  },
  {
    id: 'body',
    label: 'General text',
    help: 'Everything else — settings, help, dialogs.',
    order: 40
  }
] as const

export type FontRoleId = (typeof FONT_ROLES)[number]['id']

function fontDescriptors(): TokenDescriptor[] {
  return FONT_ROLES.flatMap((role) => [
    {
      id: `type.${role.id}.family`,
      cssVar: `--fermata-type-${role.id}-family`,
      kind: 'fontFamily' as const,
      group: 'type' as const,
      label: `${role.label} — font`,
      help: role.help,
      keywords: ['font', 'family', 'typeface', role.id],
      order: role.order,
      public: true
    },
    {
      id: `type.${role.id}.weight`,
      cssVar: `--fermata-type-${role.id}-weight`,
      kind: 'fontWeight' as const,
      group: 'type' as const,
      label: `${role.label} — weight`,
      help: 'How heavy the strokes are.',
      keywords: ['font', 'weight', 'bold', 'light', role.id],
      order: role.order + 1,
      public: true
    },
    {
      id: `type.${role.id}.style`,
      cssVar: `--fermata-type-${role.id}-style`,
      kind: 'fontStyle' as const,
      group: 'type' as const,
      label: `${role.label} — slant`,
      help: 'Upright or italic.',
      keywords: ['font', 'italic', 'oblique', 'slant', role.id],
      order: role.order + 2,
      public: true
    }
  ])
}

/**
 * Every token, public and internal. Order within a group is `order`; group
 * order is `TOKEN_GROUPS`.
 */
export const TOKENS: readonly TokenDescriptor[] = [
  ...colorRoleDescriptors(),
  ...accentDescriptors(),
  ...SEMANTIC_COLORS.map((t) => ({ ...t, kind: 'color' as const, public: true })),
  ...fontDescriptors(),
  ...STRUCTURAL
]

const BY_ID = new Map(TOKENS.map((token) => [token.id, token]))

export function findToken(id: string): TokenDescriptor | undefined {
  return BY_ID.get(id)
}

/** The tokens the editor shows, and the only ids T1 promises to keep stable. */
export const PUBLIC_TOKENS: readonly TokenDescriptor[] = TOKENS.filter((t) => t.public)

/**
 * Curated font stacks. Each is picked so it resolves to something reasonable on
 * both Windows and Linux without shipping a font file — first the platform's
 * own, then a widely-packaged Linux equivalent, then the generic family. T11's
 * free-text escape hatch exists for the operator who has something specific
 * installed and accepts that it may not exist on their other machine.
 */
export const FONT_STACKS = [
  {
    id: 'system',
    label: 'System UI',
    value: 'system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", Cantarell, sans-serif'
  },
  {
    id: 'humanist',
    label: 'Humanist sans',
    value: '"Segoe UI", "Open Sans", "Noto Sans", Cantarell, "DejaVu Sans", sans-serif'
  },
  {
    id: 'grotesk',
    label: 'Grotesk',
    value: 'Inter, "Helvetica Neue", Helvetica, Arial, "Liberation Sans", sans-serif'
  },
  {
    id: 'serif',
    label: 'Serif',
    value: 'Georgia, Cambria, "Liberation Serif", "Times New Roman", Times, serif'
  },
  {
    id: 'mono',
    label: 'Monospace',
    value:
      '"Cascadia Code", Consolas, "JetBrains Mono", "DejaVu Sans Mono", ui-monospace, monospace'
  }
] as const

export const FONT_WEIGHTS = [
  { value: '300', label: 'Light' },
  { value: '400', label: 'Regular' },
  { value: '500', label: 'Medium' },
  { value: '600', label: 'Semibold' },
  { value: '700', label: 'Bold' }
] as const

export const FONT_STYLES = [
  { value: 'normal', label: 'Upright' },
  { value: 'italic', label: 'Italic' }
] as const

/**
 * A resolved theme: every token id mapped to its CSS value, with colour roles
 * already expanded to their eleven steps.
 */
export type ResolvedTokens = ReadonlyMap<string, string>

/** What a theme declares. Ramps are specs; everything else is a literal value. */
export interface ThemeTokenValues {
  readonly ramps: Readonly<Record<string, RampSteps>>
  readonly values: Readonly<Record<string, string>>
}
