import { describe, expect, it } from 'vitest'
import {
  booleanValue,
  defineSetting,
  integerValue,
  SETTINGS_REGISTRY,
  type SettingDescriptor
} from '@shared/settings'
import {
  buildSettingsCatalog,
  planSettingReveal,
  settingAnchorId
} from '../../../src/renderer/panels/settings/catalog'
import {
  buildPanelSettings,
  PANEL_SETTINGS_SURFACES,
  panelSettingsSurface,
  surfacesForKey,
  type PanelSettingsSurface
} from '../../../src/renderer/panels/settings/panelSettings'

/**
 * The claim W8-8 rests on: an inline popover is a *projection* of the settings
 * view, not a second one.
 *
 * Which is a claim about two functions rather than about two templates. The
 * components below them mount one `SettingField` over one `SettingsRow`, so if
 * the row a popover draws is the row the full view draws, the label, the help
 * and the control cannot come apart — there is nowhere left for them to come
 * apart in. So that is what these assert, plus the two ways a declaration can be
 * wrong: a key that does not exist, and a key asked for at a scope it does not
 * cascade to.
 */

/** Every surfaced row the full settings view can draw, keyed. */
function everyFullViewRow(descriptors: readonly SettingDescriptor[] = SETTINGS_REGISTRY) {
  // The changed-from-default filter is the catalog's one spanning mode that
  // discloses advanced rows across every category at once — which is exactly
  // "every row the full view is capable of drawing" when the changed set is
  // everything.
  const catalog = buildSettingsCatalog(descriptors, {
    changed: new Set(descriptors.map((descriptor) => descriptor.key)),
    changedOnly: true
  })
  return new Map(catalog.rows.map((row) => [row.key, row]))
}

describe('one definition, two renderings', () => {
  const fullView = everyFullViewRow()

  for (const surface of PANEL_SETTINGS_SURFACES) {
    it(`draws ${surface.id} from the rows the settings view draws`, () => {
      const panel = buildPanelSettings(surface)

      expect(panel.rows.length).toBeGreaterThan(0)
      for (const row of panel.rows) {
        const inView = fullView.get(row.key)
        expect(inView, `${row.key} is not on the full settings view`).toBeDefined()

        // Field for field, and then the descriptor by identity — the second is
        // the one that makes a divergent label impossible rather than merely
        // caught, because both renderings read `label`, `help` and `control` off
        // this same object.
        expect(row).toEqual(inView)
        expect(row.descriptor).toBe(inView?.descriptor)
      }
    })
  }

  it('every shipped gear declares keys that exist and can be edited where it puts them', () => {
    for (const surface of PANEL_SETTINGS_SURFACES) {
      const panel = buildPanelSettings(surface)
      expect(panel.unknown, `${surface.id} declares keys with no control`).toEqual([])
      expect(panel.unscoped, `${surface.id} declares keys it cannot override`).toEqual([])
      expect(panel.rows.map((row) => row.key)).toEqual(surface.keys)
    }
  })

  it('keeps the panel’s declared order rather than the registry’s', () => {
    const surface: PanelSettingsSurface = {
      id: 'reversed',
      title: 'Reversed',
      where: 'a test',
      icon: 'i-tabler-test-pipe',
      keys: ['audio.replayGainMode', 'audio.crossfadeMs']
    }
    expect(buildPanelSettings(surface).rows.map((row) => row.key)).toEqual([
      'audio.replayGainMode',
      'audio.crossfadeMs'
    ])
  })
})

describe('a descriptor the registry has never held', () => {
  const FAKE = defineSetting<boolean>({
    key: 'network.testOnlyInline',
    scope: 'durable',
    default: false,
    validate: booleanValue(),
    control: { kind: 'toggle' },
    category: 'network',
    label: 'Test only inline toggle',
    help: 'Exists for a test and nowhere else.',
    order: 10
  })

  const FAKE_INTERNAL = defineSetting<number>({
    key: 'network.testOnlyInternal',
    scope: 'durable',
    default: 1,
    validate: integerValue({ min: 1 }),
    category: 'network',
    label: 'Test only internal',
    help: 'Has no control, so no surface may draw it.',
    internal: true,
    order: 20
  })

  const descriptors = [...SETTINGS_REGISTRY, FAKE, FAKE_INTERNAL]

  const surface: PanelSettingsSurface = {
    id: 'fake',
    title: 'Fake',
    where: 'a test',
    icon: 'i-tabler-test-pipe',
    keys: ['network.testOnlyInline', 'network.testOnlyInternal', 'network.notAKey']
  }

  it('arrives in a popover with its own label, help and control, and nothing authored', () => {
    const [row, ...rest] = buildPanelSettings(surface, descriptors).rows

    expect(rest).toEqual([])
    expect(row?.descriptor.label).toBe('Test only inline toggle')
    expect(row?.descriptor.help).toBe('Exists for a test and nowhere else.')
    expect(row?.descriptor.control).toEqual({ kind: 'toggle' })
    expect(row?.anchorId).toBe(settingAnchorId('network.testOnlyInline'))
    // And identically to how the full view would have drawn it.
    expect(row).toEqual(everyFullViewRow(descriptors).get('network.testOnlyInline'))
  })

  it('reports what it could not draw rather than dropping it', () => {
    // Both failures are a mistake in the declaration, and a popover that
    // rendered one of the three keys it was asked for and said nothing is a bug
    // that survives review.
    expect(buildPanelSettings(surface, descriptors).unknown).toEqual([
      'network.testOnlyInternal',
      'network.notAKey'
    ])
  })
})

describe('an entity scope', () => {
  it('refuses a key that does not cascade to it', () => {
    const surface: PanelSettingsSurface = {
      id: 'scoped',
      title: 'Scoped',
      where: 'a test',
      icon: 'i-tabler-test-pipe',
      // Crossfade cascades to a playlist; volume levelling is global-only.
      keys: ['audio.crossfadeMs', 'audio.replayGainMode'],
      entity: 'playlist'
    }
    const panel = buildPanelSettings(surface)

    expect(panel.rows.map((row) => row.key)).toEqual(['audio.crossfadeMs'])
    expect(panel.unscoped).toEqual(['audio.replayGainMode'])
  })

  it('is what the shipped playlist gear uses', () => {
    const surface = panelSettingsSurface('playlist-playback')
    expect(surface.entity).toBe('playlist')
    expect(buildPanelSettings(surface).rows.map((row) => row.key)).toEqual(['audio.crossfadeMs'])
  })
})

describe('the reverse link', () => {
  it('names every gear a key appears under', () => {
    expect(surfacesForKey('audio.crossfadeMs').map((surface) => surface.id)).toEqual([
      'transport',
      'playlist-playback'
    ])
    expect(surfacesForKey('interface.theme')).toEqual([])
  })

  it('cannot name a gear that is not there', () => {
    for (const surface of surfacesForKey('audio.crossfadeMs')) {
      expect(PANEL_SETTINGS_SURFACES).toContain(surface)
    }
  })
})

describe('a deep link lands on the row', () => {
  it('selects the key’s category and points at its anchor', () => {
    const plan = planSettingReveal('audio.crossfadeMs')

    expect(plan?.category).toBe('audio')
    expect(plan?.anchorId).toBe(settingAnchorId('audio.crossfadeMs'))
    expect(plan?.discloseAdvanced).toBeNull()
  })

  it('opens the advanced disclosure for an advanced key', () => {
    // Otherwise the link would select the right section and land on a row the
    // section is not currently drawing.
    const plan = planSettingReveal('audio.replayGainPreampDb')

    expect(plan?.category).toBe('audio')
    expect(plan?.discloseAdvanced).toBe('audio')
  })

  it('drops a query the target does not answer to, and keeps one it does', () => {
    expect(planSettingReveal('audio.crossfadeMs', { query: 'watcher' })?.query).toBe('')
    expect(planSettingReveal('audio.crossfadeMs', { query: 'watcher' })?.category).toBe('audio')

    const kept = planSettingReveal('audio.crossfadeMs', { query: 'cross' })
    expect(kept?.query).toBe('cross')
    // A query spans every category, so naming one would contradict it.
    expect(kept?.category).toBeNull()
  })

  it('clears the changed filter unless the caller is jumping from inside it', () => {
    expect(planSettingReveal('audio.crossfadeMs', { changedOnly: true })?.changedOnly).toBe(false)
    expect(planSettingReveal('audio.crossfadeMs', { changedOnly: true })?.category).toBe('audio')

    const inside = planSettingReveal('audio.crossfadeMs', {
      changedOnly: true,
      keepChangedOnly: true
    })
    expect(inside?.changedOnly).toBe(true)
    expect(inside?.category).toBeNull()
  })

  it('is nothing at all for a key with no row to land on', () => {
    expect(planSettingReveal('view.shellPaneSizes')).toBeNull()
    expect(planSettingReveal('not.a.key')).toBeNull()
  })

  it('reaches every key a gear surfaces', () => {
    // The link out of an inline control is what keeps the popover small enough
    // to be worth having. A key that could be adjusted inline but not found in
    // the full view would be the one place the two surfaces disagree.
    for (const surface of PANEL_SETTINGS_SURFACES) {
      for (const key of surface.keys) {
        expect(planSettingReveal(key), `${key} has no row to link to`).not.toBeNull()
      }
    }
  })
})
