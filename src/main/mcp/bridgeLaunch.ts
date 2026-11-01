import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AgentBridgeLaunch } from '@shared/agentAccess'

/**
 * Where the stdio bridge is and what starts it — **W24-10**, `oscine-mcp` →
 * D36.1.
 *
 * The bridge is `resources/mcp/oscine-mcp-bridge.cjs`, copied into the package
 * by `electron-builder.yml`'s `extraResources` and run by the app's own binary
 * under `ELECTRON_RUN_AS_NODE`, so the operator never needs Node installed.
 *
 * - **Packaged:** `process.resourcesPath/mcp/<script>`, started by
 *   `process.execPath` (the installed `Oscine.exe`, or `/opt/Oscine/oscine`
 *   from the deb).
 * - **Dev:** the repository's `resources/mcp/<script>`, started by the dev
 *   Electron binary — enough to try a client against `npm run dev`.
 * - **AppImage:** both of those paths live under a mount point that changes
 *   on every launch, so a pasted config would break at the next restart. The
 *   command is the `.AppImage` file itself (`$APPIMAGE`), whose runtime passes
 *   the environment and arguments through to the binary, and the script is
 *   copied to a fixed place in user data.
 *
 * Every path is joined with `node:path`, so it comes out in the host's own
 * form; the snippet JSON-encodes it, which escapes Windows backslashes for us.
 */
export const BRIDGE_SCRIPT_NAME = 'oscine-mcp-bridge.cjs'

export interface BridgeLayout {
  readonly isPackaged: boolean
  readonly execPath: string
  readonly resourcesPath: string
  /** `app.getAppPath()` — the repository root in dev. */
  readonly appRoot: string
  /** `process.env.APPIMAGE`, set only when running from an AppImage. */
  readonly appImage?: string | undefined
  /** Where an AppImage's bridge is copied to: `<userData>/mcp`. */
  readonly stableDir: string
}

/** The bridge script as shipped with this build, before any AppImage copy. */
export function shippedBridgeScript(layout: BridgeLayout): string {
  return layout.isPackaged
    ? join(layout.resourcesPath, 'mcp', BRIDGE_SCRIPT_NAME)
    : join(layout.appRoot, 'resources', 'mcp', BRIDGE_SCRIPT_NAME)
}

/** Pure: the launch a client config should name, without touching the disk. */
export function bridgeLaunchFor(layout: BridgeLayout): AgentBridgeLaunch {
  if (layout.appImage) {
    return {
      command: layout.appImage,
      args: [join(layout.stableDir, BRIDGE_SCRIPT_NAME)]
    }
  }
  return { command: layout.execPath, args: [shippedBridgeScript(layout)] }
}

export interface BridgeFs {
  exists(path: string): boolean
  read(path: string): Buffer
  copy(from: string, to: string): void
  mkdir(path: string): void
}

const nodeFs: BridgeFs = {
  exists: existsSync,
  read: (path) => readFileSync(path),
  copy: copyFileSync,
  mkdir: (path) => mkdirSync(path, { recursive: true })
}

/**
 * The launch, with the script in place: null when this install has no bridge
 * script to point at (a broken package), so the Settings block says so rather
 * than pasting a config that cannot start. For an AppImage the shipped script
 * is copied to the stable path whenever it differs, so an update replaces it.
 */
export function resolveBridgeLaunch(
  layout: BridgeLayout,
  fs: BridgeFs = nodeFs
): AgentBridgeLaunch | null {
  const shipped = shippedBridgeScript(layout)
  if (!fs.exists(shipped)) return null
  const launch = bridgeLaunchFor(layout)
  if (layout.appImage) {
    const stable = launch.args[0]
    const current = fs.read(shipped)
    if (!fs.exists(stable) || !fs.read(stable).equals(current)) {
      fs.mkdir(dirname(stable))
      fs.copy(shipped, stable)
    }
  }
  return launch
}
