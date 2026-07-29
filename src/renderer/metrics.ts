/**
 * Records renderer-side library timings for the M3 exit probe.
 *
 * User Timing entries are observable through CDP without widening the preload
 * bridge, and the bounded buffer prevents a long session from retaining every
 * browse interaction.
 */
export async function measureLibraryQuery<T>(name: string, query: () => Promise<T>): Promise<T> {
  const started = performance.now()
  try {
    return await query()
  } finally {
    performance.measure(`fermata:library:${name}`, {
      start: started,
      end: performance.now()
    })
    const entries = performance.getEntriesByName(`fermata:library:${name}`)
    if (entries.length > 100) performance.clearMeasures(`fermata:library:${name}`)
  }
}
