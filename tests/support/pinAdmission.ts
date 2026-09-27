import { afterEach, beforeEach } from 'vitest'
import { tagField } from '@shared/tagFields'

/**
 * Pins registry admission for every test in the calling suite, and restores the
 * registry's own afterwards.
 *
 * Admission follows the W16-16 corpus gate (Decision D), so it moves as triage
 * cards land: W16-19 and W16-20 each admitted the field the held-key tests had
 * been using. A test about how a *held* field is refused pins one rather than
 * counting on the gate still holding something.
 */
export function pinAdmission(pinned: Readonly<Record<string, boolean>>): void {
  const original = new Map<string, boolean>()
  beforeEach(() => {
    for (const [key, admitted] of Object.entries(pinned)) {
      const entry = tagField(key) as { admitted: boolean } | undefined
      if (entry === undefined) throw new Error(`pinAdmission: ${key} is not a registry field`)
      original.set(key, entry.admitted)
      entry.admitted = admitted
    }
  })
  afterEach(() => {
    for (const [key, admitted] of original)
      (tagField(key) as { admitted: boolean }).admitted = admitted
    original.clear()
  })
}
