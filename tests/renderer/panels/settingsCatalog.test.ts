import { describe, expect, it } from 'vitest'
import {
  booleanValue,
  defineSetting,
  enumValue,
  integerValue,
  SETTINGS_REGISTRY,
  type SettingDescriptor
} from '@shared/settings'
import {
  buildSettingsCatalog,
  matchesSettingQuery,
  settingAnchorId
} from '../../../src/renderer/panels/settings/catalog'

/**
 * The claim the settings view rests on: nothing in it is authored per key.
 *
 * Which is a claim about this function, not about a template — the components
 * place rows and draw controls, and the only thing that decides a row exists at
 * all is here. So the test that matters is the one that hands it a descriptor
 * the registry has never held and watches it arrive, in the right section, with
 * the right control, without a line changing anywhere else.
 */

/** A key that does not ship, in a category that currently holds none. */
const FAKE_TOGGLE = defineSetting<boolean>({
  key: 'network.testOnlyToggle',
  scope: 'durable',
  default: false,
  validate: booleanValue(),
  control: { kind: 'toggle' },
  category: 'network',
  label: 'Test only toggle',
  help: 'Exists for a test and nowhere else.',
  keywords: ['fixture'],
  order: 20
})

const FAKE_SELECT = defineSetting<'a' | 'b'>({
  key: 'network.testOnlySelect',
  scope: 'durable',
  default: 'a',
  validate: enumValue<'a' | 'b'>(['a', 'b']),
  control: {
    kind: 'select',
    options: [
      { value: 'a', label: 'A' },
      { value: 'b', label: 'B' }
    ]
  },
  category: 'network',
  label: 'Test only select',
  help: 'A choice between two things that do not exist.',
  order: 10
})

const FAKE_ADVANCED = defineSetting<number>({
  key: 'network.testOnlyBudget',
  scope: 'durable',
  default: 4,
  validate: integerValue({ min: 1, max: 16 }),
  control: { kind: 'number', min: 1, max: 16, unit: 'MB' },
  category: 'network',
  label: 'Test only budget',
  help: 'A number behind the disclosure.',
  keywords: ['obscure'],
  advanced: true,
  order: 30
})

const FAKE_INTERNAL = defineSetting<boolean>({
  key: 'network.testOnlyInternal',
  scope: 'view',
  default: false,
  validate: booleanValue(),
  category: 'network',
  label: 'Test only internal',
  help: 'Set by dragging something, not by a row.',
  internal: true
})

const FIXTURE: readonly SettingDescriptor[] = [
  FAKE_TOGGLE,
  FAKE_SELECT,
  FAKE_ADVANCED,
  FAKE_INTERNAL
]

describe('generated from descriptors', () => {
  it('renders a key the view has never heard of, in its category, with its control', () => {
    const catalog = buildSettingsCatalog(FIXTURE, { category: 'network' })

    const row = catalog.rows.find((entry) => entry.key === 'network.testOnlyToggle')
    expect(row).toBeDefined()
    expect(row?.category).toBe('network')
    expect(row?.descriptor.control).toEqual({ kind: 'toggle' })
    expect(row?.descriptor.label).toBe('Test only toggle')
  })

  it('gives an empty category a section as soon as a descriptor claims it', () => {
    // 'network' holds nothing in the shipped registry, so the rail must not be a
    // list of categories anyone wrote down.
    expect(buildSettingsCatalog(SETTINGS_REGISTRY).sections.map((s) => s.id)).not.toContain(
      'network'
    )

    const withFixture = buildSettingsCatalog(FIXTURE)
    expect(withFixture.sections.map((s) => s.id)).toEqual(['network'])
    expect(withFixture.category).toBe('network')
  })

  it('keeps internal keys off the surface', () => {
    const catalog = buildSettingsCatalog(FIXTURE, {
      category: 'network',
      advanced: { network: true }
    })

    expect(catalog.rows.map((row) => row.key)).not.toContain('network.testOnlyInternal')
    // And not merely hidden — the section does not count it either, or the
    // advanced disclosure would offer to reveal a row that cannot be drawn.
    expect(catalog.sections[0]?.total).toBe(3)
  })

  it('orders by category, then by the descriptor’s own order', () => {
    const catalog = buildSettingsCatalog([...SETTINGS_REGISTRY, ...FIXTURE], {
      advanced: { network: true }
    })
    const categories = catalog.sections.map((section) => section.id)

    expect(categories.indexOf('audio')).toBeLessThan(categories.indexOf('library'))
    expect(categories[categories.length - 1]).toBe('network')

    const network = buildSettingsCatalog(FIXTURE, {
      category: 'network',
      advanced: { network: true }
    })
    expect(network.rows.map((row) => row.key)).toEqual([
      'network.testOnlySelect',
      'network.testOnlyToggle',
      'network.testOnlyBudget'
    ])
  })

  it('addresses every row by its key, uniquely', () => {
    const catalog = buildSettingsCatalog([...SETTINGS_REGISTRY, ...FIXTURE], {
      advanced: { network: true }
    })
    const ids = new Set<string>()

    for (const descriptor of [...SETTINGS_REGISTRY, ...FIXTURE]) {
      if (descriptor.internal) continue
      ids.add(settingAnchorId(descriptor.key))
    }

    expect(ids.size).toBe(catalog.sections.reduce((sum, section) => sum + section.total, 0))
    expect(settingAnchorId('audio.crossfadeMs')).toBe('setting-audio-crossfadeMs')
  })
})

describe('search', () => {
  it('matches help text, not just labels', () => {
    // Nothing in this label or key says "disclosure"; the help does.
    expect(matchesSettingQuery(FAKE_ADVANCED, 'disclosure')).toBe(true)
    expect(matchesSettingQuery(FAKE_TOGGLE, 'disclosure')).toBe(false)
  })

  it('matches keywords, which are in neither', () => {
    expect(matchesSettingQuery(FAKE_ADVANCED, 'obscure')).toBe(true)
    expect(matchesSettingQuery(FAKE_TOGGLE, 'fixture')).toBe(true)
  })

  it('matches on the key, and on substrings of any of them', () => {
    expect(matchesSettingQuery(FAKE_SELECT, 'testonlyselect')).toBe(true)
    expect(matchesSettingQuery(FAKE_SELECT, 'CHOICE')).toBe(true)
  })

  it('requires every term, in any of the fields', () => {
    expect(matchesSettingQuery(FAKE_ADVANCED, 'budget number')).toBe(true)
    expect(matchesSettingQuery(FAKE_ADVANCED, 'budget nonsense')).toBe(false)
  })

  it('spans every category, whichever one the rail is pointing at', () => {
    const catalog = buildSettingsCatalog([...SETTINGS_REGISTRY, ...FIXTURE], {
      category: 'audio',
      query: 'obscure'
    })

    expect(catalog.filtered).toBe(true)
    expect(catalog.category).toBeNull()
    expect(catalog.rows.map((row) => row.key)).toEqual(['network.testOnlyBudget'])
  })

  it('counts what it matched per section, so the rail can say', () => {
    const catalog = buildSettingsCatalog(FIXTURE, { query: 'test only' })
    const section = catalog.sections.find((entry) => entry.id === 'network')

    expect(section?.total).toBe(3)
    expect(section?.matches).toBe(3)
    expect(buildSettingsCatalog(FIXTURE, { query: 'obscure' }).sections[0]?.matches).toBe(1)
  })

  it('shows everything again once the query is emptied', () => {
    const blank = buildSettingsCatalog(FIXTURE, { query: '   ', category: 'network' })

    expect(blank.filtered).toBe(false)
    expect(blank.category).toBe('network')
  })
})

describe('advanced disclosure', () => {
  it('withholds advanced rows while it is shut, and says how many', () => {
    const shut = buildSettingsCatalog(FIXTURE, { category: 'network' })

    expect(shut.rows.map((row) => row.key)).not.toContain('network.testOnlyBudget')
    expect(shut.withheldAdvanced).toBe(1)
    expect(shut.sections[0]?.advancedTotal).toBe(1)
  })

  it('draws them once it is open', () => {
    const open = buildSettingsCatalog(FIXTURE, { category: 'network', advanced: { network: true } })

    expect(open.rows.map((row) => row.key)).toContain('network.testOnlyBudget')
    expect(open.withheldAdvanced).toBe(0)
  })

  it('opens for a query, so a search cannot hide what it just found', () => {
    const found = buildSettingsCatalog(FIXTURE, { query: 'obscure', advanced: {} })

    expect(found.rows.map((row) => row.key)).toEqual(['network.testOnlyBudget'])
    expect(found.withheldAdvanced).toBe(0)
  })
})

describe('the section being shown', () => {
  it('falls back to the first one when nothing has been chosen', () => {
    expect(buildSettingsCatalog(SETTINGS_REGISTRY).category).toBe('audio')
  })

  it('falls back when the chosen one has lost its last key', () => {
    // A rail pointing at a category that no longer holds anything would render
    // a blank body with no way back to a section that does.
    const catalog = buildSettingsCatalog(FIXTURE, { category: 'audio' })

    expect(catalog.category).toBe('network')
    expect(catalog.rows.length).toBeGreaterThan(0)
  })

  it('shows only that section when one is chosen', () => {
    const catalog = buildSettingsCatalog([...SETTINGS_REGISTRY, ...FIXTURE], {
      category: 'network',
      advanced: { network: true }
    })

    expect(new Set(catalog.rows.map((row) => row.category))).toEqual(new Set(['network']))
  })
})
