import type { DiscoverAlbumItem, DiscoverTrackItem } from '@shared/discover'
import { DAY_MS, SHELF_ITEM_CAP, SHELF_ITEM_TARGET } from './constants'

export interface AlbumCard {
  albumId: number
  title: string
  artist: string | null
  year: number | null
  trackCount: number
  artworkHash: string | null
}

export interface TrackCard {
  trackId: number
  title: string
  artist: string | null
  albumTitle: string | null
  artworkHash: string | null
}

export function toAlbumItem(card: AlbumCard, why: string): DiscoverAlbumItem {
  return {
    grain: 'album',
    albumId: card.albumId,
    title: card.title,
    artist: card.artist,
    year: card.year,
    trackCount: card.trackCount,
    artworkHash: card.artworkHash,
    why
  }
}

export function toTrackItem(card: TrackCard, why: string): DiscoverTrackItem {
  return {
    grain: 'track',
    trackId: card.trackId,
    title: card.title,
    artist: card.artist,
    albumTitle: card.albumTitle,
    artworkHash: card.artworkHash,
    why
  }
}

export function unplayedWhy(trackCount: number): string {
  return `Unplayed · ${trackCount} tracks`
}

export function playedFractionWhy(played: number, total: number): string {
  return `${played} of ${total} played`
}

export function lastPlayedWhy(nowMs: number, lastPlayedAt: number): string {
  return `Last played ${relativePast(nowMs, lastPlayedAt)}`
}

export function heartedWhy(nowMs: number, lastPlayedAt: number | null): string {
  if (lastPlayedAt === null) return 'Hearted · never played'
  return `Hearted · last played ${relativePast(nowMs, lastPlayedAt)}`
}

function relativePast(nowMs: number, thenMs: number): string {
  const days = Math.max(0, Math.floor((nowMs - thenMs) / DAY_MS))
  if (days === 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 14) return `${days} days ago`
  const weeks = Math.floor(days / 7)
  if (days < 45) return weeks === 1 ? '1 week ago' : `${weeks} weeks ago`
  const months = Math.floor(days / 30)
  if (months < 18) return months === 1 ? '1 month ago' : `${months} months ago`
  const years = Math.floor(days / 365)
  return years === 1 ? '1 year ago' : `${years} years ago`
}

/**
 * Take a ranked list: aim for `SHELF_ITEM_TARGET`, fill to the cap while the
 * next card is the same quality as the last one taken. Hash is not quality.
 */
export function pickShelf<T>(ranked: readonly T[], scoreOf: (item: T) => number): T[] {
  const picked: T[] = []
  for (const item of ranked) {
    if (picked.length >= SHELF_ITEM_CAP) break
    const previous = picked[picked.length - 1]
    if (
      previous !== undefined &&
      picked.length >= SHELF_ITEM_TARGET &&
      scoreOf(item) < scoreOf(previous)
    ) {
      break
    }
    picked.push(item)
  }
  return picked
}

/**
 * One pass of unique keys, then the repeats — so a table ordered by id does
 * not fill a shelf with one artist's first ten albums.
 */
export function spread<T>(ranked: readonly T[], keyOf: (item: T) => number | string | null): T[] {
  const seen = new Set<number | string>()
  const unique: T[] = []
  const repeats: T[] = []
  for (const item of ranked) {
    const key = keyOf(item)
    if (key !== null && seen.has(key)) repeats.push(item)
    else {
      unique.push(item)
      if (key !== null) seen.add(key)
    }
  }
  return unique.concat(repeats)
}

export function jsonIds(ids: Iterable<number>): string {
  return JSON.stringify([...ids])
}

export function jsonKeys(keys: readonly string[]): string {
  return JSON.stringify(keys)
}
