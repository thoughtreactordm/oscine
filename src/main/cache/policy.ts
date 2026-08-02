/**
 * What the cache keeps, for how long, and how much of it.
 *
 * Every number in this file is in one place so that it can be argued with. The
 * alternative — a `30 * DAY` at the call site that fetches an artist — puts the
 * decision where nobody compares it against the other seven, and the first
 * symptom of getting one wrong is a rate-limit ban (R5) rather than a test
 * failure.
 *
 * Nothing here is per-machine state, so none of it is a settings key. The two
 * questions an operator actually has about a cache are "how much disk is this
 * costing" and "forget what you know about this artist", and those are a number
 * to display and a button to press (W7-9's deck header, W8's storage view), not
 * eight duration fields. The policy is an argument to `createCacheService`
 * instead, which is what tests use and what a settings key would drive if one is
 * ever justified.
 */

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * The things the cache holds, as a closed union.
 *
 * Closed for `NET_SCOPES`' reason: a new entity is a TTL decision, and a free
 * string would let one be cached with an unconsidered lifetime. Adding a member
 * is a compile error until it has a row in `DEFAULT_CACHE_TTLS`, which is the
 * point at which somebody has to think about it.
 *
 * The names are the *shape of the document*, not the URL that produced it. Two
 * endpoints that answer with the same thing share an entity; one endpoint whose
 * answer means two different things does not.
 */
export const CACHE_ENTITIES = [
  /** Artist name → MusicBrainz search candidates. R5's once-per-artist lookup. */
  'musicbrainz.artist-search',
  /** MBID → the artist document, with its relations and outbound links. */
  'musicbrainz.artist',
  /** Artist name + our album titles → who MusicBrainz credits those albums to. */
  'musicbrainz.release-group',
  /** MBID or wiki title → the Wikidata entity that links the two worlds. */
  'wikidata.entity',
  /** Wikidata sitelink → the Wikipedia lead extract shown in the deck. */
  'wikipedia.extract'
] as const

export type CacheEntity = (typeof CACHE_ENTITIES)[number]

export interface EntityTtl {
  /** How long an answer stays fresh. */
  readonly freshMs: number
  /**
   * How long "the service has nothing for this" stays fresh.
   *
   * Always the shorter of the two. A negative entry is a statement about the
   * *absence* of a record, and absences are filled in by other people; a
   * positive entry is a statement about a record that exists, and records
   * change slowly.
   */
  readonly negativeMs: number
}

/**
 * The defaults, and why each one is what it is.
 *
 * The shape of the whole table: MusicBrainz identity data is edited slowly and
 * gets thirty days; Wikipedia prose is edited constantly and gets fourteen;
 * every negative gets seven, because seven days is the shortest interval that
 * still collapses a week of shuffle-heavy listening into one request per
 * unmatchable artist, which is precisely the failure R5 names.
 */
export const DEFAULT_CACHE_TTLS: Readonly<Record<CacheEntity, EntityTtl>> = {
  /**
   * Thirty days positive. The mapping from a tag string to a candidate set only
   * moves when MusicBrainz gains, merges or renames an artist, and a successful
   * search is promoted to an MBID on the `artists` row anyway (R5) — so this TTL
   * mostly governs re-searches after a library rescan rather than steady state.
   *
   * Seven days negative, and this is the single most load-bearing number in the
   * file. An unmatchable artist — a mistyped tag, a bandcamp one-off, "Various
   * Artists" — is queried on *every* play without it, which over a shuffle
   * session is exactly the sustained one-per-second traffic that gets a client
   * banned. Seven days is long enough for that to be one request a week, and
   * short enough that an artist added to MusicBrainz on Monday is found by the
   * following Monday without the operator doing anything.
   */
  'musicbrainz.artist-search': { freshMs: 30 * DAY_MS, negativeMs: 7 * DAY_MS },

  /**
   * Thirty days positive. Relations and outbound links are curated edits, not a
   * feed; a month-old list of a band's members is not a defect anybody notices,
   * and the deck shows this document on every play of every track by the artist.
   *
   * Seven days negative. A 404 on an MBID we resolved ourselves means the artist
   * was merged away, and the merge target is reachable by re-searching — worth
   * re-checking weekly rather than treating as permanent.
   */
  'musicbrainz.artist': { freshMs: 30 * DAY_MS, negativeMs: 7 * DAY_MS },

  /**
   * Thirty days positive, matching the search it disambiguates. The question
   * being cached — "who does MusicBrainz credit these albums to" — moves only
   * when a release group is re-credited, which is a curated edit and a rare one.
   *
   * Seven days negative, and this one is load-bearing in a way the others are
   * not: a negative here means MusicBrainz knows none of the albums we hold for
   * this artist, which is the *normal* state of a bootleg, a local band or a
   * misfiled folder. Those are also the artists whose name search is ambiguous,
   * so without the negative entry every play of them would spend two requests
   * rather than one — the opposite of what corroboration is for.
   */
  'musicbrainz.release-group': { freshMs: 30 * DAY_MS, negativeMs: 7 * DAY_MS },

  /**
   * Fourteen days. Wikidata is the join between MusicBrainz and Wikipedia and
   * changes about as often as the sitelink it carries — rarely, but a broken
   * join blanks the biography pane entirely, so it refreshes on the same cadence
   * as the prose it points at rather than on MusicBrainz's.
   */
  'wikidata.entity': { freshMs: 14 * DAY_MS, negativeMs: 7 * DAY_MS },

  /**
   * Fourteen days, the shortest positive TTL here. The extract is the most
   * visible text in the deck and the most frequently edited thing we fetch — a
   * biography that still describes a band as active two years after they split
   * is the kind of staleness an operator reads as the app being wrong.
   */
  'wikipedia.extract': { freshMs: 14 * DAY_MS, negativeMs: 7 * DAY_MS }
}

/**
 * How much disk the cache may occupy, measured as the payload bytes it stores.
 *
 * Sixty-four mebibytes, against a library database that is itself tens of
 * megabytes at the 100k-track scale target. A derived cache that can outgrow the
 * thing it decorates is a bug, and this is comfortably more than that: D14 sends
 * artist *images* to the existing thumbnail cache rather than storing blobs
 * here, so every row is a JSON document of a few kilobytes and 64 MiB holds
 * several thousand artists — far more than a working set.
 *
 * Payload bytes rather than file size, because the file is what SQLite decides
 * and the payload is what we chose to store. The two track each other closely
 * enough for a cap whose purpose is "do not grow without bound", and measuring
 * the file would mean a `stat` on every write.
 */
export const DEFAULT_CACHE_MAX_BYTES = 64 * 1024 * 1024

/**
 * Where eviction stops, as a fraction of the cap.
 *
 * Evicting down to exactly the cap means the next write is over it again, so
 * every subsequent write pays for an eviction: a cache at its limit would spend
 * the rest of its life doing an LRU scan per lookup. Freeing a tenth at a time
 * turns that into one eviction per tenth of a cache, which is the standard
 * low-water-mark fix and the reason this constant exists at all.
 */
export const DEFAULT_CACHE_EVICT_TO_FRACTION = 0.9

/**
 * The largest single entry worth keeping.
 *
 * One mebibyte, matching the client's own body ceiling — a reply bigger than
 * this never arrives, so this is a floor under the assumption rather than a
 * second opinion about it. An entry near the cap would evict most of the cache
 * to make room for itself, which is a worse outcome than not caching it.
 */
export const DEFAULT_CACHE_MAX_ENTRY_BYTES = 1024 * 1024

/**
 * Charged against every row on top of its payload.
 *
 * Without it a negative entry costs nothing, and a library full of unmatchable
 * tags could store an unbounded number of them under a byte cap that never
 * trips. A negative entry is not free — it is a row, a key and two indexes — and
 * 128 bytes is roughly what one costs.
 */
export const CACHE_ROW_OVERHEAD_BYTES = 128

export interface CachePolicy {
  readonly ttls: Readonly<Record<CacheEntity, EntityTtl>>
  readonly maxBytes: number
  readonly evictToBytes: number
  readonly maxEntryBytes: number
  readonly rowOverheadBytes: number
}

export const DEFAULT_CACHE_POLICY: CachePolicy = {
  ttls: DEFAULT_CACHE_TTLS,
  maxBytes: DEFAULT_CACHE_MAX_BYTES,
  evictToBytes: Math.floor(DEFAULT_CACHE_MAX_BYTES * DEFAULT_CACHE_EVICT_TO_FRACTION),
  maxEntryBytes: DEFAULT_CACHE_MAX_ENTRY_BYTES,
  rowOverheadBytes: CACHE_ROW_OVERHEAD_BYTES
}
