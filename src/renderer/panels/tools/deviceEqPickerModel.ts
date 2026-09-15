/**
 * The device picker's search, as pure arithmetic over the bundled library (W19-9).
 *
 * Split from the modal for the reason every list model here is: a filter over 736
 * devices is testable without a DOM, and the component is then only the windowing
 * and the click. The match is a tokenized AND — every whitespace-separated term must
 * appear in the device name — so "hd 600" narrows to the Sennheiser and "sony xm"
 * to the WH-1000XM line. Ranking favours an early match (a term at the front of the
 * name beats one buried in a parenthetical), then the shorter, then alphabetical, so
 * the plain model floats above its pad-swapped variants.
 */
import type { DeviceEqProfile } from '@shared/audio/deviceEqLibrary'

/** Lower-cased query terms; empty when the query is blank. */
export function queryTerms(query: string): string[] {
  const trimmed = query.trim().toLowerCase()
  return trimmed.length === 0 ? [] : trimmed.split(/\s+/)
}

/**
 * The match score for a name against terms, or null when any term is absent. Lower
 * is better: it sums where each term first appears, so front-of-name matches win.
 */
function scoreName(nameLower: string, terms: readonly string[]): number | null {
  let score = 0
  for (const term of terms) {
    const at = nameLower.indexOf(term)
    if (at < 0) return null
    score += at
  }
  return score
}

/**
 * The devices matching `query`, best first. A blank query returns the whole library
 * in its stored order (already name-sorted by the generator), so opening the picker
 * shows everything.
 */
export function filterDeviceProfiles(
  profiles: readonly DeviceEqProfile[],
  query: string
): DeviceEqProfile[] {
  const terms = queryTerms(query)
  if (terms.length === 0) return [...profiles]

  const scored: { profile: DeviceEqProfile; score: number }[] = []
  for (const profile of profiles) {
    const score = scoreName(profile.name.toLowerCase(), terms)
    if (score !== null) scored.push({ profile, score })
  }

  scored.sort(
    (a, b) =>
      a.score - b.score ||
      a.profile.name.length - b.profile.name.length ||
      a.profile.name.localeCompare(b.profile.name)
  )
  return scored.map((entry) => entry.profile)
}
