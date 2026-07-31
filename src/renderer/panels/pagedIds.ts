/**
 * One id page, whatever the query behind it was.
 *
 * The shape every `list*Ids` response in `@shared/library` already has, named
 * here so the walk below does not have to know which of them it is walking.
 */
export interface IdPage {
  ids: number[]
  /** Total matching rows, ignoring offset and limit. */
  total: number
}

/**
 * Walks an id query to the end, in request order.
 *
 * The page ceilings exist so the renderer cannot ask main for an unbounded
 * result, and `MAX_TRACK_ID_PAGE` is 10,000 — which a right-click on a prolific
 * artist, or on nine of them, goes past in a library of the size D1 targets. A
 * single-page read would silently add the first ten thousand and call it done,
 * and "silently the wrong selection" is the failure mode this whole layer is
 * written to avoid.
 *
 * Sequential and concatenated in request order, for the reason
 * `queueCommands.resolve` is: the order is the point, and racing the pages would
 * settle it by whichever returned first.
 *
 * `total` is what ends it rather than a short page, because an exact final page
 * is not short. The empty-page check is the backstop: without it, a `total` that
 * disagreed with what the query can actually return — a row deleted between two
 * pages — would spin forever.
 */
export async function collectPagedIds(
  pageSize: number,
  fetchPage: (offset: number, limit: number) => Promise<IdPage>
): Promise<number[]> {
  const ids: number[] = []
  for (;;) {
    const page = await fetchPage(ids.length, pageSize)
    if (page.ids.length === 0) return ids
    ids.push(...page.ids)
    if (ids.length >= page.total) return ids
  }
}
