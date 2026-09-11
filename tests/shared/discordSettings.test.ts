import { describe, expect, it } from 'vitest'
import {
  auditRegistry,
  buildSettingsProfile,
  DISCORD_DISPLAY,
  DISCORD_ENABLED,
  DISCORD_SETTINGS,
  DISCORD_SETTINGS_DEFAULTS,
  DISCORD_SHOW_ALBUM_ART,
  DISCORD_SHOW_TIMESTAMP,
  DISCORD_WHEN_PAUSED,
  getSetting,
  NETWORK_EXTERNAL_LOOKUPS_KEY,
  SETTINGS_REGISTRY,
  settingsInCategory,
  type SettingDescriptor
} from '../../src/shared/settings'

/**
 * W20-3's operator-control surface. The descriptors define *what* the operator
 * can set; the mapping (W20-4) and the cover lookup (W20-5) read the values.
 * These are the properties a wrong entry turns into a privacy regression, so
 * they are pinned here rather than left to the generated UI to reveal.
 */

const DISCORD_KEYS = [
  DISCORD_ENABLED,
  DISCORD_DISPLAY,
  DISCORD_SHOW_ALBUM_ART,
  DISCORD_SHOW_TIMESTAMP,
  DISCORD_WHEN_PAUSED
]

function descriptorFor(key: string): SettingDescriptor {
  const descriptor = getSetting(key)
  if (!descriptor) throw new Error(`no descriptor for ${key}`)
  return descriptor
}

function selectValues(key: string): readonly unknown[] {
  const control = descriptorFor(key).control
  if (control?.kind !== 'select') throw new Error(`${key} is not a select`)
  return control.options.map((option) => option.value)
}

describe('the Discord presence descriptors', () => {
  it('registers all five keys as network rows, in order', () => {
    for (const key of DISCORD_KEYS) {
      expect(getSetting(key)?.category).toBe('network')
    }
    // They cluster together after the scrobbling keys and before the standalone
    // consent toggle, in declared order.
    const network = settingsInCategory('network').map((descriptor) => descriptor.key)
    const discord = network.filter((key) => key.startsWith('discord.'))
    expect(discord).toEqual([
      DISCORD_ENABLED,
      DISCORD_DISPLAY,
      DISCORD_SHOW_ALBUM_ART,
      DISCORD_SHOW_TIMESTAMP,
      DISCORD_WHEN_PAUSED
    ])
    expect(auditRegistry()).toEqual([])
  })

  it('resolves the privacy-shaped defaults off by default', () => {
    // A wrong default here is a privacy regression, not a preference: presence
    // must be silent, cover art must not reach the network, and a paused track
    // must not announce itself, all until the operator says otherwise.
    expect(descriptorFor(DISCORD_ENABLED).default).toBe(false)
    expect(descriptorFor(DISCORD_SHOW_ALBUM_ART).default).toBe(false)
    expect(descriptorFor(DISCORD_WHEN_PAUSED).default).toBe('hide')
    expect(descriptorFor(DISCORD_DISPLAY).default).toBe('title-artist')
    expect(descriptorFor(DISCORD_SHOW_TIMESTAMP).default).toBe(true)
  })

  it('keeps the descriptor defaults and the mapping defaults in step', () => {
    // The registry and `buildActivity` read the same values object, so a change
    // to one cannot silently diverge from the other.
    expect(descriptorFor(DISCORD_ENABLED).default).toBe(DISCORD_SETTINGS_DEFAULTS.enabled)
    expect(descriptorFor(DISCORD_DISPLAY).default).toBe(DISCORD_SETTINGS_DEFAULTS.display)
    expect(descriptorFor(DISCORD_SHOW_ALBUM_ART).default).toBe(
      DISCORD_SETTINGS_DEFAULTS.showAlbumArt
    )
    expect(descriptorFor(DISCORD_SHOW_TIMESTAMP).default).toBe(
      DISCORD_SETTINGS_DEFAULTS.showTimestamp
    )
    expect(descriptorFor(DISCORD_WHEN_PAUSED).default).toBe(DISCORD_SETTINGS_DEFAULTS.whenPaused)
  })

  it('offers exactly the values the W20-4 mapping switches on', () => {
    // Guards against a value/label drift: `activity.ts` branches on these
    // literals, so an option the mapping does not handle would be a choice that
    // does nothing.
    expect(selectValues(DISCORD_DISPLAY)).toEqual(['title-artist', 'title-only', 'generic'])
    expect(selectValues(DISCORD_WHEN_PAUSED)).toEqual(['hide', 'paused'])
  })

  it('gates album art on the D14 consent key, and nothing else on any key', () => {
    const gate = descriptorFor(DISCORD_SHOW_ALBUM_ART).gatedBy
    expect(gate?.key).toBe(NETWORK_EXTERNAL_LOOKUPS_KEY)
    expect(gate?.note.trim()).not.toBe('')

    for (const key of DISCORD_KEYS) {
      if (key === DISCORD_SHOW_ALBUM_ART) continue
      expect(descriptorFor(key).gatedBy).toBeNull()
    }
  })

  it('is not portable, so no Discord key rides the export bundle', () => {
    for (const descriptor of DISCORD_SETTINGS) {
      expect(descriptor.portable).toBe(false)
    }

    // Prove it through the exporter the way an export actually runs: every key
    // stored and changed, and none survives into the profile.
    const values: Record<string, unknown> = {}
    for (const descriptor of SETTINGS_REGISTRY) values[descriptor.key] = descriptor.default
    const { profile, excluded } = buildSettingsProfile({
      descriptors: SETTINGS_REGISTRY,
      values,
      storedKeys: DISCORD_KEYS
    })

    for (const key of DISCORD_KEYS) {
      expect(profile.settings[key]).toBeUndefined()
      expect(excluded).toContain(key)
    }
  })

  it('states the online cost of album art in its help', () => {
    // The one network-reaching toggle must say so where the operator flips it,
    // the way the consent key and the other network settings do.
    expect(descriptorFor(DISCORD_SHOW_ALBUM_ART).help.toLowerCase()).toContain('online')
  })
})
