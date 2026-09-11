/**
 * The Linux extraResources copy does not preserve the executable bit. Without
 * this, the first rip fails with a confusing EACCES on the bundled `flac`.
 */
import { chmod } from 'node:fs/promises'
import { join } from 'node:path'

export default async function chmodFlac(context) {
  if (context.electronPlatformName !== 'linux') return
  await chmod(join(context.appOutDir, 'resources', 'bin', 'flac'), 0o755)
}
