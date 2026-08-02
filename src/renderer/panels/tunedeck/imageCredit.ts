import type { ArtistImageCredit } from '@shared/artistImage'

/**
 * The Commons credit, reduced to what a component renders.
 *
 * A module rather than a computed inside the header, for `artistIdentity.ts`'
 * reason: the wording is the part with rules in it, and rules are worth testing
 * without a Vue plugin. The rules are also not obvious — see below — and a
 * licence notice that quietly drops the photographer when a field is empty is
 * the kind of bug nobody notices until somebody who cares notices.
 */
export interface DescribedCredit {
  /**
   * One line, for the affordance that opens the rest.
   *
   * Always says something. A file whose metadata Commons never recorded still
   * came from Commons, and saying so is the minimum honest statement about
   * where a picture on screen came from.
   */
  summary: string
  /** The photographer, or the attribution line they required. `null` if neither. */
  name: string | null
  licence: string | null
  licenceUrl: string | null
  descriptionUrl: string
}

/**
 * The uploader's required attribution wins over the author field.
 *
 * Where both exist they usually say the same thing in different forms, and the
 * one to prefer is the one the licensor *asked* for: a photographer who wrote
 * "Photo by A. N. Other / example.com" into the attribution field has stated the
 * form their licence obliges, and substituting the bare author name for it would
 * be preferring our own tidiness to their condition.
 */
export function describeCredit(credit: ArtistImageCredit): DescribedCredit {
  const name = credit.attribution ?? credit.artist

  const summary =
    name && credit.licence
      ? `Photo: ${name} · ${credit.licence}`
      : name
        ? `Photo: ${name}`
        : credit.licence
          ? `Photo · ${credit.licence}`
          : 'Photo from Wikimedia Commons'

  return {
    summary,
    name,
    licence: credit.licence,
    licenceUrl: credit.licenceUrl,
    descriptionUrl: credit.descriptionUrl
  }
}
