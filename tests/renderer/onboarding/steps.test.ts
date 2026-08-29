import { describe, expect, it } from 'vitest'
import {
  AUDIO_OUTPUT_DEVICE,
  AUDIO_REPLAY_GAIN_COMPUTE_WHEN_MISSING,
  AUDIO_REPLAY_GAIN_FALLBACK_DB,
  AUDIO_REPLAY_GAIN_MODE,
  AUDIO_REPLAY_GAIN_PREAMP_DB,
  NETWORK_EXTERNAL_LOOKUPS_KEY,
  SETTINGS_REGISTRY,
  THEME_MODE_KEY,
  THEME_NAME_KEY,
  type SettingDescriptor
} from '../../../src/shared/settings'
import {
  buildOnboardingSteps,
  buildOnboardingSurface,
  ONBOARDING_STEPS
} from '../../../src/renderer/onboarding/steps'
import { buildSettingsCatalog } from '../../../src/renderer/panels/settings/catalog'

/**
 * The surface renderer is a projection of the settings view, not a second one.
 * Same claim as W8-8's gears: the row a wizard step draws is the row the full
 * view draws, descriptor by identity.
 */

function everyFullViewRow() {
  const built = buildSettingsCatalog(SETTINGS_REGISTRY, {
    changed: new Set(SETTINGS_REGISTRY.map((descriptor) => descriptor.key)),
    changedOnly: true
  })
  return new Map(built.rows.map((row) => [row.key, row]))
}

function expectSurfaceMatchesFullView(step: { keys: readonly string[] }): void {
  const surface = buildOnboardingSurface(step)
  const fullView = everyFullViewRow()

  expect(surface.unknown).toEqual([])
  expect(surface.rows.map((row) => row.key)).toEqual([...step.keys])
  for (const row of surface.rows) {
    const inView = fullView.get(row.key)
    expect(inView, `${row.key} is not on the full settings view`).toBeDefined()
    expect(row).toEqual(inView)
    expect(row.descriptor).toBe(inView?.descriptor)
  }
}

describe('onboarding steps', () => {
  it('ships a linear walk that starts at the root and ends at scan', () => {
    expect(ONBOARDING_STEPS.map((step) => step.id)).toEqual([
      'root',
      'theme',
      'audio',
      'network',
      'scan'
    ])
    expect(ONBOARDING_STEPS[0]?.skippable).toBe(false)
    expect(
      ONBOARDING_STEPS.filter((step) => step.id !== 'root').every((step) => step.skippable)
    ).toBe(true)
  })

  it('does not wait for indexing before Finish is available', () => {
    expect(ONBOARDING_STEPS.at(-1)).toMatchObject({ id: 'scan', skippable: true, kind: 'special' })
  })

  it('draws the theme surface from the rows the settings view draws', () => {
    const theme = ONBOARDING_STEPS.find((step) => step.id === 'theme')
    expect(theme?.keys).toEqual([THEME_MODE_KEY, THEME_NAME_KEY])
    expectSurfaceMatchesFullView(theme!)
  })

  it('draws the audio surface from output device and ReplayGain mode only', () => {
    const audio = ONBOARDING_STEPS.find((step) => step.id === 'audio')
    expect(audio?.keys).toEqual([AUDIO_OUTPUT_DEVICE.key, AUDIO_REPLAY_GAIN_MODE.key])
    expect(audio?.keys).not.toContain(AUDIO_REPLAY_GAIN_PREAMP_DB.key)
    expect(audio?.keys).not.toContain(AUDIO_REPLAY_GAIN_FALLBACK_DB.key)
    expect(audio?.keys).not.toContain(AUDIO_REPLAY_GAIN_COMPUTE_WHEN_MISSING.key)
    expectSurfaceMatchesFullView(audio!)
  })

  it('draws the network surface from W7’s consent key', () => {
    const network = ONBOARDING_STEPS.find((step) => step.id === 'network')
    expect(network?.keys).toEqual([NETWORK_EXTERNAL_LOOKUPS_KEY])
    expectSurfaceMatchesFullView(network!)
  })

  it('omits the network step when W7’s key is not registered', () => {
    const without = SETTINGS_REGISTRY.filter(
      (descriptor) => descriptor.key !== NETWORK_EXTERNAL_LOOKUPS_KEY
    )
    expect(buildOnboardingSteps(without).map((step) => step.id)).toEqual([
      'root',
      'theme',
      'audio',
      'scan'
    ])
  })

  it('omits the network step when W7’s key cannot be surfaced', () => {
    const hidden: SettingDescriptor[] = SETTINGS_REGISTRY.map((descriptor) =>
      descriptor.key === NETWORK_EXTERNAL_LOOKUPS_KEY
        ? { ...descriptor, internal: true, control: null }
        : descriptor
    )
    expect(buildOnboardingSteps(hidden).map((step) => step.id)).not.toContain('network')
  })

  it('names a key it cannot draw rather than inventing a control', () => {
    const surface = buildOnboardingSurface({ keys: ['theme.mode', 'no.such.key'] })
    expect(surface.rows.map((row) => row.key)).toEqual(['theme.mode'])
    expect(surface.unknown).toEqual(['no.such.key'])
  })
})
