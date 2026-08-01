import { defineStore } from 'pinia'
import { createDisplayFormats } from '@renderer/panels/displayFormat'
import { useSettings } from '@renderer/settings'

/**
 * How this app writes a duration, a date and a size, and how tall a song row is.
 *
 * A store rather than a call per component so that the two song lists, the two
 * podcast panes and anything that grows a duration column later are demonstrably
 * reading one preference. As elsewhere, the behaviour lives in the plain module
 * and this is the one place the real settings surface is attached.
 *
 * The unified store rather than the view half: three of the four keys are
 * durable — see the scope note in `@shared/settings/interface`.
 */
export const useDisplayFormatStore = defineStore('displayFormat', () =>
  createDisplayFormats({ settings: useSettings() })
)
