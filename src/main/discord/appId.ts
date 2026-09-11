/**
 * The project-level Discord Application identity — **W20-2**.
 *
 * Rich Presence identifies the app by an Application ("client") ID and nothing
 * else. It is **public, not a secret**: it ships in the clear, needs no
 * `safeStorage`, and there is nothing here an attacker gains by reading. That is
 * the whole reason presence sits outside the credential rules scrobbling lives
 * under (D31).
 *
 * ## Registering it (once, project-level — not per user)
 *
 * 1. At https://discord.com/developers/applications create an application named
 *    "Oscine". Its **Application ID** is the value below.
 * 2. Under *Rich Presence → Art Assets*, upload the static Oscine logo under the
 *    asset key `OSCINE_LOGO_ASSET_KEY`. That is the `largeImageKey` presence
 *    falls back to whenever album art is off, unavailable, or unconsented
 *    (W20-5's tier-1 image).
 *
 * The ID and the asset are reproducible from these two steps; keep them in sync
 * with whatever Discord application the shipped build points at.
 */

/**
 * The registered Application ID for the "Oscine" Discord application.
 *
 * Public, committed in the clear (see the file header) — this is the identity the
 * RPC handshake announces, not a credential. Still make sure the logo art asset
 * (`OSCINE_LOGO_ASSET_KEY`) is uploaded under this application before W20-5 wires
 * album art, or the fallback large image will not resolve.
 */
export const DISCORD_APPLICATION_ID = '1548040763223314543'

/** The Art Asset key for the static Oscine logo — W20-5's `largeImageKey` fallback. */
export const OSCINE_LOGO_ASSET_KEY = 'oscine-logo'
