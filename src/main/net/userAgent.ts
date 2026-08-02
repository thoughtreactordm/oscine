/**
 * The one identity Fermata presents to every host it talks to.
 *
 * One constant rather than a literal per call site: a client that identifies
 * itself differently depending on which of its own requests you look at is the
 * thing feed hosts write rate-limiting rules against. MusicBrainz goes further
 * and *requires* an identifying agent — an application name and a version — so
 * this is a policy obligation on the W7-7 path rather than only a courtesy.
 *
 * There is deliberately no contact URL. The placeholder that once stood here
 * pointed at `github.com` itself, which is worse than saying nothing. Add a
 * real one when the project has a public home; that is the courtesy feed
 * operators actually want.
 *
 * The version is read from `package.json` rather than written out, because the
 * string it replaced said `Fermata/0.1` while the package said `0.2.1` — which
 * is what a hand-maintained version in a second file does, given time.
 */

import { version } from '../../../package.json'

export const FERMATA_USER_AGENT = `Fermata/${version} (local music player)`
