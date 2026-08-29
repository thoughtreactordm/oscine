/**
 * The first-run wizard's steps, as declarations rather than as templates.
 *
 * A step is either a *special* (root picker, scan progress) or a *surface*:
 * `{ title, blurb, keys }`, the same shape W8-8's panel gears use. Surface rows
 * come from `settingsRowFor`, so a changed default or label in the registry
 * shows up here without a second control being written.
 *
 * The walk is built, not listed: the network step is omitted when W7's D14
 * consent key is not a surfaced registry entry. Never stubbed.
 */

import { isSurfacedSetting, settingsRowFor, type SettingsRow } from '../panels/settings/catalog'
import {
  AUDIO_OUTPUT_DEVICE,
  AUDIO_REPLAY_GAIN_MODE,
  NETWORK_EXTERNAL_LOOKUPS_KEY,
  SETTINGS_REGISTRY,
  THEME_MODE_KEY,
  THEME_NAME_KEY,
  type SettingDescriptor
} from '@shared/settings'

export type OnboardingStepKind = 'special' | 'surface'

export interface OnboardingStep {
  readonly id: string
  readonly kind: OnboardingStepKind
  readonly title: string
  readonly blurb: string
  /** False only for the root step — Next waits for a folder. */
  readonly skippable: boolean
  /** Surface keys, in draw order. Empty on a special. */
  readonly keys: readonly string[]
}

/**
 * One surface's rows, in the declared order, from the same constructor the
 * settings view uses.
 *
 * Unknown or internal keys are returned rather than rendered: a step that names
 * a key the registry cannot draw is a bug in the declaration, and silently
 * dropping it would hide that.
 */
export function buildOnboardingSurface(
  step: Pick<OnboardingStep, 'keys'>,
  descriptors: readonly SettingDescriptor[] = SETTINGS_REGISTRY
): { rows: readonly SettingsRow[]; unknown: readonly string[] } {
  const rows: SettingsRow[] = []
  const unknown: string[] = []

  for (const key of step.keys) {
    const descriptor = descriptors.find((candidate) => candidate.key === key)
    if (!descriptor || !isSurfacedSetting(descriptor)) {
      unknown.push(key)
      continue
    }
    rows.push(settingsRowFor(descriptor))
  }

  return { rows, unknown }
}

function canSurfaceKey(key: string, descriptors: readonly SettingDescriptor[]): boolean {
  const descriptor = descriptors.find((candidate) => candidate.key === key)
  return descriptor !== undefined && isSurfacedSetting(descriptor)
}

const ROOT_STEP: OnboardingStep = {
  id: 'root',
  kind: 'special',
  title: 'Add your music',
  blurb: 'Oscine plays folders on this computer. Pick one to start — you can add more later.',
  skippable: false,
  keys: []
}

const THEME_STEP: OnboardingStep = {
  id: 'theme',
  kind: 'surface',
  title: 'How it looks',
  blurb:
    'Light, dark, or follow the system, and which built-in theme. Changes apply as you make them.',
  skippable: true,
  keys: [THEME_MODE_KEY, THEME_NAME_KEY]
}

const AUDIO_STEP: OnboardingStep = {
  id: 'audio',
  kind: 'surface',
  title: 'Sound',
  blurb:
    'Where audio is sent, and whether to level volume across tracks. Changes apply as you make them.',
  skippable: true,
  keys: [AUDIO_OUTPUT_DEVICE.key, AUDIO_REPLAY_GAIN_MODE.key]
}

const NETWORK_STEP: OnboardingStep = {
  id: 'network',
  kind: 'surface',
  title: 'Online lookups',
  blurb:
    'Oscine can fetch artist info and browse the podcast catalog. Off stays on this machine. Either choice is fine — you can change this later.',
  skippable: true,
  keys: [NETWORK_EXTERNAL_LOOKUPS_KEY]
}

const SCAN_STEP: OnboardingStep = {
  id: 'scan',
  kind: 'special',
  title: 'Ready',
  blurb:
    'Indexing runs in the background. Finish whenever you like — you can change any of this later in Settings.',
  // Finish is not gated on the scan completing. The step only visualizes
  // progress already underway (14c); the title-bar chip keeps that visible
  // after the modal closes.
  skippable: true,
  keys: []
}

/**
 * The walk the modal currently knows.
 *
 * Theme, audio and network are descriptor surfaces. Network is present only
 * when W7's consent key is registered and drawable. Scan is a special that
 * reads `roots.scan` and never starts indexing.
 */
export function buildOnboardingSteps(
  descriptors: readonly SettingDescriptor[] = SETTINGS_REGISTRY
): readonly OnboardingStep[] {
  const steps: OnboardingStep[] = [ROOT_STEP, THEME_STEP, AUDIO_STEP]
  if (canSurfaceKey(NETWORK_EXTERNAL_LOOKUPS_KEY, descriptors)) {
    steps.push(NETWORK_STEP)
  }
  steps.push(SCAN_STEP)
  return steps
}

export const ONBOARDING_STEPS: readonly OnboardingStep[] = buildOnboardingSteps()
