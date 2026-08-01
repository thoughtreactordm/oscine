import { describe, expect, it } from 'vitest'
import { isReactive, reactive } from 'vue'
import {
  AUDIO_CROSSFADE_MS,
  AUDIO_OUTPUT_DEVICE,
  SETTINGS_PROFILE_FORMAT,
  type SettingsProfile
} from '../../../src/shared/settings'
import {
  formatSettingValue,
  importAppliesSomething,
  importPreviewEntries,
  importSummaryLine,
  IMPORT_STATUS_META
} from '../../../src/renderer/panels/settings/profileDiff'
import { settingsStoreFixture } from './fixture'

/**
 * W8-13's renderer half: the preview the operator decides on, and the apply that
 * follows it.
 *
 * The plan itself is proved in `tests/shared/settingsProfile.test.ts` against
 * the pure function. What is left here is the two claims only the store can
 * make: that the preview is computed from the surface as it stands, and that an
 * applied import reaches the surface by the broadcast rather than by the store
 * writing its own answer.
 */

const CROSSFADE = AUDIO_CROSSFADE_MS.key
const DEVICE = AUDIO_OUTPUT_DEVICE.key
const ACTIVATION = 'interface.trackActivation'
/** A view key: it can be named by a file, and can never be applied from one. */
const GROUPING = 'view.trackGroupingEnabled'

function profile(settings: SettingsProfile['settings']): SettingsProfile {
  return { format: SETTINGS_PROFILE_FORMAT, formatVersion: 1, settings }
}

describe('previewImport', () => {
  it('compares against the surface as it stands, not against the defaults', async () => {
    const { settings } = settingsStoreFixture()
    await settings.ready
    await settings.set(CROSSFADE, 2000)

    const plan = settings.previewImport(
      profile({ [CROSSFADE]: { value: 2000, version: 1 } }),
      'merge'
    )

    expect(plan.entries).toHaveLength(1)
    expect(plan.entries[0]).toMatchObject({ key: CROSSFADE, status: 'unchanged' })
  })

  it('previews a view key as excluded, with a reason, rather than in silence', async () => {
    const { settings } = settingsStoreFixture()
    await settings.ready

    const plan = settings.previewImport(
      profile({ [GROUPING]: { value: false, version: 1 } }),
      'merge'
    )

    expect(plan.entries[0]).toMatchObject({ key: GROUPING, status: 'excluded' })
    expect(plan.entries[0].reason).toBeTruthy()
    expect(plan.apply).toEqual([])
  })

  it('redraws when the mode changes', async () => {
    const { settings } = settingsStoreFixture({ stored: { [ACTIVATION]: 'queue' } })
    await settings.ready

    const file = profile({ [CROSSFADE]: { value: 2000, version: 1 } })
    expect(settings.previewImport(file, 'merge').clear).toEqual([])
    expect(settings.previewImport(file, 'replace').clear).toEqual([ACTIVATION])
  })
})

describe('importProfile', () => {
  it('reaches the surface, and the row behind it', async () => {
    const { settings, bridge } = settingsStoreFixture()
    await settings.ready

    const plan = await settings.importProfile(
      profile({ [CROSSFADE]: { value: 2000, version: 1 } }),
      'merge'
    )

    expect(plan.apply).toEqual([{ key: CROSSFADE, value: 2000, version: 1 }])
    expect(settings.get(CROSSFADE)).toBe(2000)
    expect(settings.isStored(CROSSFADE)).toBe(true)
    expect(bridge.rows.get(CROSSFADE)).toBe(2000)
  })

  /**
   * A write the debounce is still holding is one main has not been told about,
   * and an import that ran first would be planned against a store that is a
   * moment out of date. Under replace that is not cosmetic: main would sweep
   * without seeing the row, and the pending write would land *after* the sweep
   * and survive an operation that was supposed to have cleared it.
   */
  it('flushes a pending write before asking main to import', async () => {
    const { settings, bridge } = settingsStoreFixture({ debounceMs: 50 })
    await settings.ready

    void settings.set(CROSSFADE, 4000)
    await settings.importProfile(
      profile({ [ACTIVATION]: { value: 'queue', version: 1 } }),
      'replace'
    )

    expect(bridge.calls.set).toHaveLength(1)
    expect(settings.get(ACTIVATION)).toBe('queue')
    expect(bridge.rows.has(CROSSFADE)).toBe(false)
    expect(settings.get(CROSSFADE)).toBe(0)
  })

  /**
   * The renderer holds the picked file in a component, and a `ref` around an
   * object hands out a reactive proxy. `ipcRenderer.invoke` serialises with
   * structured cloning, which refuses a `Proxy` outright — so a profile that
   * arrived wrapped fails the import with "an object could not be cloned"
   * rather than with anything about settings.
   */
  it('hands main a profile that can cross the boundary', async () => {
    const { settings, bridge } = settingsStoreFixture()
    await settings.ready

    const wrapped = reactive(profile({ [CROSSFADE]: { value: 2000, version: 1 } }))
    await settings.importProfile(wrapped as SettingsProfile, 'merge')

    const sent = bridge.calls.importProfile[0].profile
    expect(isReactive(sent)).toBe(false)
    expect(() => structuredClone(sent)).not.toThrow()
  })

  it('leaves the machine-local key alone in both directions', async () => {
    const { settings, bridge } = settingsStoreFixture()
    await settings.ready
    await settings.set(DEVICE, 'Speakers')

    await settings.importProfile(
      profile({ [DEVICE]: { value: 'Someone else', version: 1 } }),
      'replace'
    )

    expect(settings.get(DEVICE)).toBe('Speakers')

    await settings.exportProfile()
    expect(bridge.exported.at(-1)?.settings[DEVICE]).toBeUndefined()
  })

  it('exports what the surface holds, after flushing what it was still holding', async () => {
    const { settings, bridge } = settingsStoreFixture({ debounceMs: 50 })
    await settings.ready

    void settings.set(CROSSFADE, 3000)
    const result = await settings.exportProfile()

    expect(result?.keyCount).toBe(1)
    expect(bridge.exported.at(-1)?.settings[CROSSFADE]).toEqual({ value: 3000, version: 1 })
  })

  it('hands back what the dialog offered, and null when it was dismissed', async () => {
    const { settings, bridge } = settingsStoreFixture()
    await settings.ready

    expect(await settings.readProfile()).toBeNull()

    const file = { fileName: 'theirs.json', profile: profile({}) }
    bridge.offerProfile(file)
    expect(await settings.readProfile()).toEqual(file)
  })
})

describe('the preview’s presentation', () => {
  it('puts what will happen above what will not', () => {
    const order = importPreviewEntries({
      mode: 'merge',
      apply: [],
      preserve: [],
      clear: [],
      entries: [
        { key: 'z.unknown', status: 'unknown' },
        { key: 'a.excluded', status: 'excluded' },
        { key: 'm.changed', status: 'changed' },
        { key: 'b.new', status: 'new' }
      ]
    }).map((entry) => entry.key)

    expect(order).toEqual(['m.changed', 'b.new', 'a.excluded', 'z.unknown'])
  })

  it('summarises a plan by what it does, and says so when it does nothing', () => {
    expect(
      importSummaryLine({
        mode: 'replace',
        apply: [],
        preserve: [],
        clear: [],
        entries: [
          { key: 'a', status: 'changed' },
          { key: 'b', status: 'new' },
          { key: 'c', status: 'cleared' },
          { key: 'd', status: 'excluded' },
          { key: 'e', status: 'invalid' }
        ]
      })
    ).toBe('1 changed · 1 new · 1 back to default · 2 not applied')

    const empty = { mode: 'merge', apply: [], preserve: [], clear: [], entries: [] } as const
    expect(importSummaryLine(empty)).toBe('This file changes nothing here.')
    expect(importAppliesSomething(empty)).toBe(false)
  })

  it('renders every kind of setting value as one line', () => {
    expect(formatSettingValue(true)).toBe('on')
    expect(formatSettingValue(false)).toBe('off')
    expect(formatSettingValue(0)).toBe('0')
    expect(formatSettingValue('')).toBe('empty')
    expect(formatSettingValue('Speakers')).toBe('Speakers')
    expect(formatSettingValue(null)).toBe('none')
    expect(formatSettingValue(undefined)).toBe('—')
    expect(formatSettingValue({ a: 1 })).toBe('{"a":1}')
    expect(formatSettingValue([1, 2, 3])).toBe('3 items')
    // A token map is not a diff line. The file is where it is read in full.
    expect(
      formatSettingValue(Object.fromEntries([...Array(9).keys()].map((n) => [`k${n}`, n])))
    ).toBe('9 entries')
  })

  it('has a badge for every status the planner can produce', () => {
    for (const status of [
      'new',
      'changed',
      'unchanged',
      'cleared',
      'excluded',
      'incompatible',
      'invalid',
      'unknown'
    ] as const) {
      expect(IMPORT_STATUS_META[status].label).toBeTruthy()
    }
  })
})
