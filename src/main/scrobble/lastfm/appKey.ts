/**
 * The application key — **D19**'s accepted cost, stated where it is paid.
 *
 * ## Provenance
 *
 * > Registered at <https://www.last.fm/api/account/create> on **Monday 3 August
 * > 2026, 23:38**, under the Last.fm account **`mdelally`**. Rotating, revoking
 * > or raising a quota on this pair means signing in as that account — there is
 * > no other route to it, which is the whole reason this paragraph exists.
 *
 * That block is the deliverable, not decoration. A shipped credential with no
 * record of whose account it belongs to is a credential nobody can rotate,
 * because nobody can log in to rotate it.
 *
 * ## Why it is a literal
 *
 * These two strings ship inside `app.asar` and anyone can read them out of it.
 * D19 accepts that, and the reason it can is the distinction this whole stream
 * is built on: the app key says *which application is asking*, and asking is all
 * it can do. Scrobbling requires a session key bound to one account, obtained by
 * that account's owner typing their own password on Last.fm's own login page.
 * An extracted app key buys someone the ability to write a scrobbler that calls
 * itself Fermata. It buys them no account, no listening history and no library.
 *
 * Hiding it would therefore be theatre — an obfuscation that costs a build step
 * and defeats nobody who can run `npx asar extract`. What it would cost is the
 * ability to read this file and see exactly what ships.
 *
 * ## The override
 *
 * `lastfm.apiKey` / `lastfm.apiSecret` (empty by default) replace this pair.
 * That is the escape hatch for the day Last.fm rate-limits or withdraws
 * Oscine's registration, and it is the reason D19 does not have to be reopened
 * on that day.
 */

import { LASTFM_API_KEY, LASTFM_API_SECRET } from '@shared/settings'
import type { SettingsService } from '../../settings'

/**
 * The registered application's key. Identifies Oscine; scrobbles for nobody.
 *
 * Annotated `: string` rather than left to inference, and not as a style
 * preference: without it TypeScript narrows this to its own literal type and the
 * `=== ''` guard in `resolveLastfmAppKey` becomes a compile error for comparing
 * two types with no overlap. The guard has to stay live, because the state it
 * checks for is reachable — a build made after this key is withdrawn blanks
 * these two lines and nothing else, and it must degrade to "no application key
 * configured" rather than to a signature failure against a dead key.
 */
export const SHIPPED_LASTFM_API_KEY: string = '471404f0fbcd043e841af5712343851d'

/** Its shared secret — the other half of *which application*, not of *who*. */
export const SHIPPED_LASTFM_API_SECRET: string = '3476522a884403ee5f069064b5426bbb'

export interface LastfmAppKey {
  readonly apiKey: string
  readonly apiSecret: string
  /** Whether this came from the operator's settings rather than the bundle. */
  readonly fromOverride: boolean
}

/** Only `get` is needed, so a test passes a one-line stand-in. */
export type AppKeySettingsSource = Pick<SettingsService, 'get'>

/**
 * The pair to sign with, or `null` when there is none to sign with.
 *
 * **A half-filled override is treated as absent**, and deliberately not as an
 * error at the point of typing. Someone pasting two fields will briefly have one
 * of them filled, and a validator that rejected that state would fight them
 * mid-paste; someone who fills one and stops has made a mistake that shows up
 * here, once, as "no application key configured" rather than as a signature
 * failure at `auth.getSession` that looks exactly like a wrong secret.
 *
 * Falling back to the shipped pair when the override is half-filled would be
 * worse than either: it would work, silently, against a key the operator
 * believed they had replaced.
 */
export function resolveLastfmAppKey(settings: AppKeySettingsSource): LastfmAppKey | null {
  const overrideKey = settings.get<string>(LASTFM_API_KEY).trim()
  const overrideSecret = settings.get<string>(LASTFM_API_SECRET).trim()

  if (overrideKey !== '' && overrideSecret !== '') {
    return { apiKey: overrideKey, apiSecret: overrideSecret, fromOverride: true }
  }
  // One of the two filled in: the operator meant to override and has not
  // finished. Not the shipped pair — see above.
  if (overrideKey !== '' || overrideSecret !== '') return null

  if (SHIPPED_LASTFM_API_KEY === '' || SHIPPED_LASTFM_API_SECRET === '') return null
  return {
    apiKey: SHIPPED_LASTFM_API_KEY,
    apiSecret: SHIPPED_LASTFM_API_SECRET,
    fromOverride: false
  }
}

/**
 * What to tell an operator who has no usable pair.
 *
 * Two different situations, and telling them apart matters: a build that shipped
 * without a key is Oscine's problem and the operator's workaround, while a
 * half-filled override is a field they can see and fix.
 */
export function missingAppKeyMessage(settings: AppKeySettingsSource): string {
  const overrideKey = settings.get<string>(LASTFM_API_KEY).trim()
  const overrideSecret = settings.get<string>(LASTFM_API_SECRET).trim()

  if (overrideKey !== '' || overrideSecret !== '') {
    return 'Last.fm needs both an API key and its shared secret. Fill in the other field in Settings › Network, or clear both to use the key Oscine ships with.'
  }
  return 'This build of Oscine has no Last.fm application key, so it cannot connect. Register an application at last.fm/api/account/create and paste its key and shared secret into Settings › Network.'
}
