import { WAVEFORM_SAMPLE_COUNT, type WaveformBuffer } from './AudioEngine'

/**
 * The left/right tap behind `readStereoWaveform` (W23-13, D35.10).
 *
 * `readWaveform`'s analyser mixes its input down to mono, which is right for a
 * ribbon and useless for an X/Y scope. This splits the same tap point into its
 * two channels and reads each through its own analyser.
 *
 * Built lazily, on the `EqualizerRouter.subscribeClip` precedent: the splitter
 * and both analysers exist only while at least one subscriber holds the tap, and
 * come down when the last one lets go. Two analysers on every track forever, for
 * one effect, is not free. Every node here is a leaf — the splitter feeds the
 * analysers and the analysers feed nothing — so attaching the tap never adds a
 * route to the destination and detaching it never removes one.
 *
 * Both paths own one of these: `DecodedAudioEngine` points it at each source's
 * transition gain as the source is built, and the streaming platform points it
 * at its one normalization gain. The engine decides whether anything is audible;
 * the tap only knows whether it is attached.
 */

/** The slice of a Web Audio node the tap touches. A real `AudioNode` satisfies it. */
export interface StereoTapNode {
  connect(destination: StereoTapNode, output?: number, input?: number): unknown
  /** No argument drops every edge; a node argument drops just that one. */
  disconnect(destination?: StereoTapNode): void
}

export interface StereoTapAnalyser extends StereoTapNode {
  fftSize: number
  getFloatTimeDomainData(array: Float32Array<ArrayBuffer>): void
}

export interface StereoTapSplitter extends StereoTapNode {
  channelInterpretation: string
}

/** The slice of `AudioContext` the tap needs. */
export interface StereoTapContext {
  createChannelSplitter(numberOfOutputs?: number): StereoTapSplitter
  createAnalyser(): StereoTapAnalyser
}

interface Attached {
  splitter: StereoTapSplitter
  left: StereoTapAnalyser
  right: StereoTapAnalyser
}

export class StereoTap {
  readonly #context: StereoTapContext
  #subscribers = 0
  #attached: Attached | null = null
  /** The node whose output is tapped, connected to the splitter iff attached. */
  #source: StereoTapNode | null = null

  constructor(context: StereoTapContext) {
    this.#context = context
  }

  /** Whether the splitter and analysers currently exist. */
  get attached(): boolean {
    return this.#attached !== null
  }

  /**
   * Hold the tap open. The first subscriber builds the nodes; the last release
   * removes them. The release is idempotent, so an unmount hook can call it
   * without bookkeeping and a double call cannot strand the nodes attached.
   */
  subscribe(): () => void {
    this.#subscribers += 1
    if (this.#subscribers === 1) this.#attach()
    let released = false
    return () => {
      if (released) return
      released = true
      this.#subscribers -= 1
      if (this.#subscribers === 0) this.#detach()
    }
  }

  /**
   * Point the tap at a node, or at nothing.
   *
   * Does not disconnect the previous node. The decoded path calls this as it
   * replaces a source whose gains it has already disconnected wholesale, and
   * dropping an edge that no longer exists throws.
   */
  setSource(node: StereoTapNode | null): void {
    this.#source = node
    if (node && this.#attached) node.connect(this.#attached.splitter)
  }

  /**
   * Fill both buffers from the analysers. False when the tap is not attached,
   * with both buffers untouched.
   *
   * `mono` copies the left reading into the right rather than reading the right
   * analyser. The splitter's speaker up-mix already duplicates a mono input
   * into both channels (see `#attach`); a caller that knows its source is mono
   * passes this to skip a read whose answer it already has.
   */
  read(left: WaveformBuffer, right: WaveformBuffer, mono = false): boolean {
    const attached = this.#attached
    if (!attached) return false
    attached.left.getFloatTimeDomainData(left)
    if (mono) right.set(left)
    else attached.right.getFloatTimeDomainData(right)
    return true
  }

  /** Tear the nodes down regardless of subscribers. The tap is unusable after. */
  dispose(): void {
    this.#detach()
    this.#source = null
    this.#subscribers = 0
  }

  #attach(): void {
    if (this.#attached) return
    const splitter = this.#context.createChannelSplitter(2)
    // A splitter interprets its input as discrete channels by default, which
    // up-mixes mono by filling channel 0 and leaving channel 1 silent — a scope
    // that drew a flat right channel for every mono file. Speaker
    // interpretation copies mono into both and folds anything wider than
    // stereo down to it, which is what the scope should see.
    splitter.channelInterpretation = 'speakers'
    const left = this.#context.createAnalyser()
    const right = this.#context.createAnalyser()
    left.fftSize = WAVEFORM_SAMPLE_COUNT
    right.fftSize = WAVEFORM_SAMPLE_COUNT
    splitter.connect(left, 0)
    splitter.connect(right, 1)
    this.#attached = { splitter, left, right }
    this.#source?.connect(splitter)
  }

  #detach(): void {
    const attached = this.#attached
    if (!attached) return
    this.#attached = null
    if (this.#source) {
      // Just this edge — the source's route onward to the master gain must
      // survive, or closing the scope would silence the track.
      try {
        this.#source.disconnect(attached.splitter)
      } catch {
        // Already disconnected wholesale by a teardown that raced the release.
      }
    }
    attached.splitter.disconnect()
  }
}
