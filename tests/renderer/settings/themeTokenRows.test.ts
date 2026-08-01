import { describe, expect, it } from 'vitest'
import { PUBLIC_TOKENS, TOKENS, TOKEN_GROUPS, type ThemeOverrides } from '@shared/theme'
import {
  buildTokenRows,
  groupTokenIds,
  isOverridden,
  TOKEN_ROW_PX
} from '../../../src/renderer/panels/settings/theme/tokenRows'

/**
 * The token editor's row model — the half of the editor that can be checked
 * without mounting a modal, and the half where the unknown-key rule either holds
 * or quietly stops holding.
 */

function tokenIds(rows: ReturnType<typeof buildTokenRows>['rows']): string[] {
  return rows.filter((row) => row.kind === 'token').map((row) => row.key)
}

function groupIds(rows: ReturnType<typeof buildTokenRows>['rows']): string[] {
  return rows.filter((row) => row.kind === 'group').map((row) => row.id)
}

const NONE: ThemeOverrides = {}

describe('buildTokenRows', () => {
  it('draws every public token, and nothing internal', () => {
    const built = buildTokenRows({ overrides: NONE, unknown: [] })
    const drawn = new Set(tokenIds(built.rows))

    for (const token of PUBLIC_TOKENS) expect(drawn.has(token.id)).toBe(true)

    // The T1 promise is over the public subset. An internal token in the editor
    // would be a name the operator could come to depend on without it ever
    // having been committed to.
    for (const token of TOKENS.filter((entry) => !entry.public)) {
      expect(drawn.has(token.id)).toBe(false)
    }
  })

  it('orders groups as TOKEN_GROUPS declares them', () => {
    const built = buildTokenRows({ overrides: NONE, unknown: [] })
    const declared = TOKEN_GROUPS.map((group) => group.id).filter((id) =>
      PUBLIC_TOKENS.some((token) => token.group === id)
    )
    expect(groupIds(built.rows)).toEqual(declared)
  })

  it('puts a heading in front of every run of tokens', () => {
    const built = buildTokenRows({ overrides: NONE, unknown: [] })
    expect(built.rows[0]?.kind).toBe('group')

    // No heading may be drawn with nothing under it: an empty section reads as
    // a group whose tokens failed to load.
    for (const [index, row] of built.rows.entries()) {
      if (row.kind !== 'group') continue
      expect(built.rows[index + 1]?.kind).not.toBe('group')
      expect(row.total).toBeGreaterThan(0)
    }
  })

  it('counts rows without counting headings', () => {
    const built = buildTokenRows({ overrides: NONE, unknown: [] })
    expect(built.matched).toBe(PUBLIC_TOKENS.length)
    expect(built.rows.length).toBe(built.matched + groupIds(built.rows).length)
    expect(built.filtered).toBe(false)
  })
})

describe('search', () => {
  it('matches a label', () => {
    const built = buildTokenRows({ overrides: NONE, unknown: [], query: 'corner radius' })
    expect(tokenIds(built.rows)).toEqual(['shape.radius'])
    expect(built.filtered).toBe(true)
  })

  it('matches a keyword the label does not carry', () => {
    // "Window" is the label; nobody types that looking for the background.
    const built = buildTokenRows({ overrides: NONE, unknown: [], query: 'background' })
    expect(tokenIds(built.rows)).toContain('surface.base')
  })

  it('matches the custom property, so a name read off the DOM can be pasted back', () => {
    const built = buildTokenRows({ overrides: NONE, unknown: [], query: '--fermata-shape-radius' })
    expect(tokenIds(built.rows)).toEqual(['shape.radius'])
  })

  it('matches a group name', () => {
    const built = buildTokenRows({ overrides: NONE, unknown: [], query: 'Motion' })
    expect(tokenIds(built.rows)).toContain('motion.duration')
    expect(tokenIds(built.rows)).toContain('motion.easing')
  })

  it('drops the heading when a query empties its group', () => {
    const built = buildTokenRows({ overrides: NONE, unknown: [], query: 'corner radius' })
    expect(groupIds(built.rows)).toEqual(['shape'])
  })

  it('reports nothing rather than everything when a query matches nothing', () => {
    const built = buildTokenRows({ overrides: NONE, unknown: [], query: 'zzzzz' })
    expect(built.rows).toEqual([])
    expect(built.matched).toBe(0)
  })

  it('ignores case and surrounding space', () => {
    const built = buildTokenRows({ overrides: NONE, unknown: [], query: '  CORNER Radius ' })
    expect(tokenIds(built.rows)).toEqual(['shape.radius'])
  })
})

describe('provenance', () => {
  const overrides: ThemeOverrides = {
    'shape.radius': '0rem',
    'color.primary': { mode: 'palette', palette: 'violet' }
  }

  it('marks the rows carrying an override', () => {
    const built = buildTokenRows({ overrides, unknown: [] })
    const marked = built.rows.filter((row) => row.kind === 'token' && row.overridden)
    expect(marked.map((row) => row.key).sort()).toEqual(['color.primary', 'shape.radius'])
  })

  it('counts overrides across the whole catalog, not the drawn rows', () => {
    const built = buildTokenRows({ overrides, unknown: [], query: 'corner radius' })
    expect(tokenIds(built.rows)).toEqual(['shape.radius'])
    expect(built.overridden).toBe(2)
  })

  it('filters to what the operator has moved', () => {
    const built = buildTokenRows({ overrides, unknown: [], overriddenOnly: true })
    expect(tokenIds(built.rows).sort()).toEqual(['color.primary', 'shape.radius'])
    expect(built.filtered).toBe(true)
  })

  it('combines the filter with a query', () => {
    const built = buildTokenRows({
      overrides,
      unknown: [],
      overriddenOnly: true,
      query: 'radius'
    })
    expect(tokenIds(built.rows)).toEqual(['shape.radius'])
  })
})

describe('orphans — the unknown-key rule on screen', () => {
  const overrides: ThemeOverrides = {
    'shape.radius': '0rem',
    'legacy.sidebar.tint': 'oklch(50% 0.1 200)'
  }
  const unknown = ['legacy.sidebar.tint']

  it('shows an override naming no token rather than dropping it', () => {
    const built = buildTokenRows({ overrides, unknown })
    const orphans = built.rows.filter((row) => row.kind === 'orphan')
    expect(orphans.map((row) => row.id)).toEqual(['legacy.sidebar.tint'])
  })

  it('gives them their own heading, last', () => {
    const built = buildTokenRows({ overrides, unknown })
    expect(groupIds(built.rows).at(-1)).toBe('unknown')
    expect(built.rows.at(-1)?.kind).toBe('orphan')
  })

  it('counts them among the drawn rows', () => {
    const built = buildTokenRows({ overrides, unknown })
    expect(built.matched).toBe(PUBLIC_TOKENS.length + 1)
  })

  it('keeps them under the changed filter, since every one of them is a change', () => {
    const built = buildTokenRows({ overrides, unknown, overriddenOnly: true })
    expect(built.rows.filter((row) => row.kind === 'orphan').map((row) => row.id)).toEqual([
      'legacy.sidebar.tint'
    ])
  })

  it('searches them by name', () => {
    const built = buildTokenRows({ overrides, unknown, query: 'sidebar' })
    expect(built.rows.filter((row) => row.kind === 'orphan').map((row) => row.id)).toEqual([
      'legacy.sidebar.tint'
    ])
    expect(tokenIds(built.rows)).toEqual([])
  })

  it('draws no heading when there are none', () => {
    const built = buildTokenRows({ overrides: NONE, unknown: [] })
    expect(groupIds(built.rows)).not.toContain('unknown')
  })
})

describe('groupTokenIds', () => {
  it('returns only the overridden tokens of a group', () => {
    const overrides: ThemeOverrides = {
      'surface.base': 'oklch(10% 0 0)',
      'shape.radius': '0rem'
    }
    expect(groupTokenIds('surface', overrides, [])).toEqual(['surface.base'])
  })

  it('sweeps the whole group, not what a query left on screen', () => {
    const overrides: ThemeOverrides = {
      'surface.base': 'oklch(10% 0 0)',
      'surface.elevated': 'oklch(14% 0 0)'
    }
    expect(groupTokenIds('surface', overrides, []).sort()).toEqual([
      'surface.base',
      'surface.elevated'
    ])
  })

  it('reverting the orphan group takes the unknown ids and nothing else', () => {
    // An override on an *internal* token resolves perfectly well and is not an
    // orphan. Deriving orphans from "has no public descriptor" would sweep it
    // away with them.
    const overrides: ThemeOverrides = {
      'nowPlaying.scrim': 'oklch(0% 0 0 / 0.5)',
      'legacy.sidebar.tint': 'oklch(50% 0.1 200)'
    }
    expect(groupTokenIds('unknown', overrides, ['legacy.sidebar.tint'])).toEqual([
      'legacy.sidebar.tint'
    ])
  })

  it('returns nothing for a group with no overrides', () => {
    expect(groupTokenIds('motion', NONE, [])).toEqual([])
  })
})

describe('isOverridden', () => {
  it('is true for a key that is present, even holding a falsy value', () => {
    expect(isOverridden('shape.radius', { 'shape.radius': '' })).toBe(true)
    expect(isOverridden('shape.radius', NONE)).toBe(false)
  })

  it('does not see inherited properties', () => {
    expect(isOverridden('toString', NONE)).toBe(false)
  })
})

describe('TOKEN_ROW_PX', () => {
  it('is one number, because the list is virtualized on it', () => {
    expect(TOKEN_ROW_PX).toBeGreaterThan(0)
    expect(Number.isInteger(TOKEN_ROW_PX)).toBe(true)
  })
})
