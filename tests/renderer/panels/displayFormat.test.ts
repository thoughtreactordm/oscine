import { describe, expect, it } from 'vitest'
import {
  DATE_FORMAT_KEY,
  DURATION_FORMAT_KEY,
  FILE_SIZE_FORMAT_KEY,
  settingDefault,
  TRACK_DENSITY_KEY,
  type TrackDensity
} from '@shared/settings'
import {
  createDisplayFormats,
  formatDate,
  formatDuration,
  formatDurationMs,
  formatFileSize,
  formatListeningTime,
  formatPlays,
  TRACK_DENSITIES,
  TRACK_DENSITY_KEYS,
  trackRowPx
} from '../../../src/renderer/panels/displayFormat'
import { settingsStoreFixture } from '../settings/fixture'

/**
 * The four display preferences, and the row height the virtualizer is told.
 *
 * The date assertions are written to be locale-independent, because they run on
 * two CI platforms and on whatever the operator's machine is set to. What is
 * asserted is the *difference* between the formats — `short` drops the year that
 * `medium` keeps — rather than the exact string, except for ISO, which is the
 * one format that is allowed to have an exact answer.
 */

describe('durations', () => {
  it('writes minutes and seconds under an hour, whatever the format', () => {
    expect(formatDuration(245, 'auto')).toBe('4:05')
    expect(formatDuration(245, 'minutes')).toBe('4:05')
  })

  it('grows an hours field only when auto needs one', () => {
    expect(formatDuration(3845, 'auto')).toBe('1:04:05')
    expect(formatDuration(3599, 'auto')).toBe('59:59')
    expect(formatDuration(3600, 'auto')).toBe('1:00:00')
  })

  it('keeps counting minutes past sixty when told to', () => {
    expect(formatDuration(3845, 'minutes')).toBe('64:05')
    expect(formatDuration(36_000, 'minutes')).toBe('600:00')
  })

  it('always carries an hours field when told to', () => {
    expect(formatDuration(245, 'hours')).toBe('0:04:05')
    expect(formatDuration(3845, 'hours')).toBe('1:04:05')
  })

  it('rounds to the nearest second rather than truncating', () => {
    expect(formatDuration(59.6, 'auto')).toBe('1:00')
  })

  // The dash and the empty string are two different absences: a track with no
  // duration still occupies a column that has to line up, and an episode with
  // none draws no separator at all.
  it('says nothing rather than zero when there is no duration', () => {
    expect(formatDuration(null, 'auto')).toBe('—')
    expect(formatDuration(-1, 'auto')).toBe('—')
    expect(formatDuration(Number.NaN, 'auto')).toBe('—')
    expect(formatDurationMs(null, 'auto')).toBe('')
    expect(formatDurationMs(0, 'auto')).toBe('')
  })

  it('reads milliseconds the same way it reads seconds', () => {
    expect(formatDurationMs(3_845_000, 'auto')).toBe('1:04:05')
  })
})

describe('dates', () => {
  const PUBLISHED = '2026-06-03T22:30:00'

  it('writes ISO from the local calendar, not from UTC', () => {
    expect(formatDate(PUBLISHED, 'iso')).toBe('2026-06-03')
  })

  it('keeps the year in medium and drops it in short', () => {
    expect(formatDate(PUBLISHED, 'medium')).toContain('2026')
    expect(formatDate(PUBLISHED, 'short')).not.toContain('2026')
  })

  it('says nothing for a date it cannot read', () => {
    expect(formatDate(null, 'medium')).toBe('')
    expect(formatDate('', 'medium')).toBe('')
    expect(formatDate('not a date', 'medium')).toBe('')
  })
})

describe('file sizes', () => {
  it('divides by 1024 and says so', () => {
    expect(formatFileSize(4 * 1024 * 1024, 'binary')).toBe('4.0 MiB')
    expect(formatFileSize(312 * 1024 * 1024, 'binary')).toBe('312 MiB')
  })

  it('divides by 1000 and says that instead', () => {
    expect(formatFileSize(4_000_000, 'decimal')).toBe('4.0 MB')
    expect(formatFileSize(312_000_000, 'decimal')).toBe('312 MB')
  })

  it('climbs a unit rather than printing four digits', () => {
    expect(formatFileSize(3 * 1024 ** 3, 'binary')).toBe('3.0 GiB')
    expect(formatFileSize(3_000_000_000, 'decimal')).toBe('3.0 GB')
  })

  it('leaves small files in bytes', () => {
    expect(formatFileSize(900, 'binary')).toBe('900 bytes')
    expect(formatFileSize(0, 'binary')).toBe('0 bytes')
  })

  it('one decimal below ten, none above', () => {
    expect(formatFileSize(9.5 * 1024 * 1024, 'binary')).toBe('9.5 MiB')
    expect(formatFileSize(10.5 * 1024 * 1024, 'binary')).toBe('11 MiB')
  })

  it('says nothing rather than zero when there is no size', () => {
    expect(formatFileSize(null, 'binary')).toBe('—')
    expect(formatFileSize(-1, 'binary')).toBe('—')
  })
})

describe('density', () => {
  it('has a row height for every tier the descriptor allows', () => {
    // The registry decides which tiers exist and this table decides what they
    // measure; a tier added to one and not the other is what this catches.
    const control = TRACK_DENSITIES
    for (const density of TRACK_DENSITY_KEYS) {
      expect(control[density].row).toBeGreaterThan(0)
    }
    expect(trackRowPx(settingDefault<TrackDensity>(TRACK_DENSITY_KEY))).toBe(32)
  })

  it('is strictly ordered, so a tier change is always a visible one', () => {
    expect(TRACK_DENSITIES.compact.row).toBeLessThan(TRACK_DENSITIES.default.row)
    expect(TRACK_DENSITIES.default.row).toBeLessThan(TRACK_DENSITIES.roomy.row)
  })
})

describe('bound to the store', () => {
  it('reads the defaults when nothing has been stored', async () => {
    const { settings } = settingsStoreFixture()
    await settings.ready
    const formats = createDisplayFormats({ settings })

    expect(formats.rowPx.value).toBe(32)
    expect(formats.duration(3845)).toBe('1:04:05')
    expect(formats.fileSize(4 * 1024 * 1024)).toBe('4.0 MiB')
  })

  it('follows a change without being rebuilt', async () => {
    const { settings } = settingsStoreFixture()
    await settings.ready
    const formats = createDisplayFormats({ settings })

    await settings.set(DURATION_FORMAT_KEY, 'minutes')
    await settings.set(FILE_SIZE_FORMAT_KEY, 'decimal')
    await settings.set(DATE_FORMAT_KEY, 'iso')
    settings.set(TRACK_DENSITY_KEY, 'compact')

    // The whole of W8-4 in four assertions: nothing was re-read, re-mounted or
    // re-constructed, and a consumer that had snapshotted at init would fail
    // every one of them.
    expect(formats.duration(3845)).toBe('64:05')
    expect(formats.fileSize(4_000_000)).toBe('4.0 MB')
    expect(formats.date('2026-06-03T22:30:00')).toBe('2026-06-03')
    expect(formats.rowPx.value).toBe(24)
    expect(formats.density.value).toBe('compact')
  })

  it('takes the density from the view half, which needs no hydration', () => {
    // Not awaited: the row height is read while the shell is deciding what to
    // paint, and the point of its scope is that the answer is already there.
    const { settings } = settingsStoreFixture({ seed: { [TRACK_DENSITY_KEY]: 'roomy' } })
    expect(createDisplayFormats({ settings }).rowPx.value).toBe(40)
  })
})

/**
 * The listening total (W10-11), which is a quantity and not a position on a
 * clock — see the function's own note for why that makes it a second shape
 * rather than a second formatter.
 */
describe('formatListeningTime', () => {
  const MINUTE = 60_000
  const HOUR = 60 * MINUTE
  const DAY = 24 * HOUR

  it('grows a unit at a time, largest first', () => {
    expect(formatListeningTime(18 * MINUTE)).toBe('18m')
    expect(formatListeningTime(2 * HOUR + 18 * MINUTE)).toBe('2h 18m')
    expect(formatListeningTime(4 * DAY + 6 * HOUR)).toBe('4d 6h')
  })

  it('drops a minor unit that is zero', () => {
    expect(formatListeningTime(3 * HOUR)).toBe('3h')
    expect(formatListeningTime(4 * DAY)).toBe('4d')
  })

  it('rounds down to whole units, and never grows a seconds field', () => {
    // A total small enough for seconds to matter is one that has not happened
    // yet, and `0 plays` beside it has already said so.
    expect(formatListeningTime(0)).toBe('0m')
    expect(formatListeningTime(59_999)).toBe('0m')
    expect(formatListeningTime(HOUR - 1)).toBe('59m')
    expect(formatListeningTime(DAY - 1)).toBe('23h 59m')
  })

  /**
   * The reason it is not `formatDuration`. Four years of listening as a clock
   * is a number nobody takes in at a glance, and taking it in at a glance is
   * the whole point of putting it on a deck.
   */
  it('stays readable at four years of listening', () => {
    expect(formatListeningTime(392 * DAY + 9 * HOUR)).toBe('392d 9h')
  })

  it('renders the em dash for a number it cannot believe', () => {
    expect(formatListeningTime(null)).toBe('—')
    expect(formatListeningTime(-1)).toBe('—')
    expect(formatListeningTime(Number.NaN)).toBe('—')
    expect(formatListeningTime(Number.POSITIVE_INFINITY)).toBe('—')
  })
})

describe('formatPlays', () => {
  it('carries the noun, and agrees with itself about one', () => {
    expect(formatPlays(0)).toBe('0 plays')
    expect(formatPlays(1)).toBe('1 play')
    expect(formatPlays(2)).toBe('2 plays')
  })

  it('groups a five-figure count, which this library can reach', () => {
    expect(formatPlays(12_043)).toBe(`${(12_043).toLocaleString()} plays`)
  })
})
