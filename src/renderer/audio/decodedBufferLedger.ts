/**
 * Conservative accounting for decoded buffers whose backing stores may still
 * be resident after the engine drops its last reference.
 *
 * `AudioBuffer` storage is external to V8's ordinary heap. Cross-platform M1
 * exit probes showed that replacing a track does not prompt collection, so
 * treating an unreachable buffer as freed immediately can overstate available
 * headroom by more than a gigabyte.
 *
 * This module deliberately knows only `object`, not `AudioBuffer`, preserving
 * the audio module's Web Audio boundary and keeping the accounting testable
 * under Node.
 */
export class DecodedBufferLedger {
  #issuedNotFreedBytes = 0

  /**
   * There is intentionally no public "release" operation. Dropping the
   * engine's reference is not proof that the backing store was reclaimed; only
   * V8 reporting the wrapper collected is enough to subtract its bytes.
   */
  readonly #collected = new FinalizationRegistry<number>((bytes) => {
    this.#issuedNotFreedBytes = Math.max(0, this.#issuedNotFreedBytes - bytes)
  })

  get issuedNotFreedBytes(): number {
    return this.#issuedNotFreedBytes
  }

  /**
   * Count a newly issued decoded buffer until collection is proven.
   *
   * Call immediately after decode, before checking whether the load was
   * superseded: a stale result still allocated its backing store and can remain
   * resident after its local reference disappears.
   */
  track(buffer: object, bytes: number): void {
    if (bytes <= 0) return
    this.#issuedNotFreedBytes += bytes
    this.#collected.register(buffer, bytes)
  }
}
