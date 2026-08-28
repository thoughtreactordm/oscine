/**
 * Renders the application icon set from the Oscine mark: the sound-wave songbird
 * on a filled disc, the same two paths `AppLogo.vue` draws in the title bar.
 *
 * The vector source is `build/oscine-logo.svg`. The mark is a component in the
 * app, where the disc takes `--ui-primary` and the wave `--ui-text-inverted` and
 * both theme at runtime; an icon is a raster artefact and cannot carry a token,
 * so this bakes the disc to the Tailwind amber ramp behind `--ui-primary` and
 * the wave to a fixed dark stone, and rasterises every size the two platforms
 * ask for.
 *
 * Each size is rendered from the vector at exactly that pixel size rather than
 * downscaled from one master raster: librsvg resolving the paths at the target
 * resolution stays crisp where a resample would blur, and the ICO path below
 * needs raw pixels whose dimensions match the directory entry that declares
 * them. The wave is a filled shape, not a stroke, so — unlike the glyph badge
 * this replaced — there is no per-size stroke weight to hint; the disc fills the
 * canvas edge to edge at every size.
 *
 *   npm run icons
 */
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const buildDir = join(root, 'build')
const iconsDir = join(buildDir, 'icons')

/*
 * The disc takes Tailwind's amber ramp, which is what `colors.primary: 'amber'`
 * in electron.vite.config.ts resolves `--ui-primary` to. Converted from the
 * oklch source values to sRGB once, here, because an icon is a raster artefact:
 * it cannot carry a token and be resolved later.
 *
 *   amber-400  oklch(82.8% 0.189 84.429)
 *   amber-600  oklch(66.6% 0.179 58.318)
 *
 * The disc runs 400 → 600 top to bottom, which brackets the amber-500 the title
 * bar renders flat, and reads as depth at 512 px without shifting the hue.
 */
const DISC_TOP = '#ffb900'
const DISC_BOTTOM = '#e17100'

/*
 * The wave takes a fixed dark stone rather than the `text-inverted` the title
 * bar flips per theme. A raster cannot flip, so it takes the value that stays
 * legible everywhere: near-black stone-950 on amber is ~9:1, which survives at
 * 16 px on a taskbar over an arbitrary wallpaper where a light wave (~2:1) would
 * dissolve into the disc.
 */
const WAVE = '#0c0a09'

/*
 * The Oscine mark, from `build/oscine-logo.svg`. The disc geometry is normalised
 * to plain `cx/cy/r` filling the 1354.467 design square; the wave keeps its
 * native path under the one translate it was authored with, which is cheaper and
 * safer than rebaking every coordinate. Both are design units — the per-size
 * `width`/`height` on the <svg> is what scales them to the target canvas.
 */
const VIEWBOX = 1354.467
const DISC_CENTER = 677.2335
const WAVE_TRANSFORM = 'translate(-598.58913,-19.030152)'
const WAVE_PATH =
  'M 1271.0557,1308.4772 C 741.17898,1300.5229 660.50918,836.35762 659.88847,671.06575 679.01264,242.13636 1006.5391,79.342604 1297.8645,80.320666 c 287.8771,1.999713 578.1381,285.266774 585.0415,599.231634 1.8271,83.09344 -87.4357,74.08921 -135.9221,73.67694 C 1625.0317,752.1923 1564.8036,520.11148 1496.6137,490.707 1394.7409,446.77798 1408.915,995.74836 1276.2005,995.36418 1136.1883,994.95891 1197.1081,757.53559 1112.1331,709.26659 1042.6225,680.78906 895.63262,722.65572 896.55917,653.7796 c 1.32376,-98.40319 168.87113,-35.26362 270.89343,-17.69712 82.2508,14.16219 32.5252,226.31273 107.4051,226.17704 84.8037,-0.15367 34.7098,-281.18693 153.7278,-443.05095 143.6896,-195.41712 211.2257,262.43113 334.0382,256.85152 120.8637,-4.07975 12.4601,-172.84518 -32.3796,-239.95212 -93.2309,-139.52905 -235.7971,-238.9368 -435.17,-253.12107 -653.94281,43.98741 -603.58575,1020.6215 -11.5658,1029.8941 329.8012,5.1655 424.3939,-224.53758 514.5889,-380.86778 20.7702,-35.99999 73.678,-65.17349 67.0985,7.83207 -15.4265,171.17161 -201.7082,474.52301 -594.14,468.63191 z'

// The hicolor sizes a desktop actually installs. 1024 is not one of them; it is
// the master that ships as build/icon.png.
const LINUX_SIZES = [16, 24, 32, 48, 64, 128, 256, 512]
// Windows reads 16/32/48 from Explorer and small taskbars, 256 for the large
// views and the installer, and the rest cover the 125–200% scaling steps.
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

function svgFor(size) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${VIEWBOX} ${VIEWBOX}">
  <defs>
    <linearGradient id="disc" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${DISC_TOP}"/>
      <stop offset="1" stop-color="${DISC_BOTTOM}"/>
    </linearGradient>
  </defs>
  <circle cx="${DISC_CENTER}" cy="${DISC_CENTER}" r="${DISC_CENTER}" fill="url(#disc)"/>
  <g transform="${WAVE_TRANSFORM}">
    <path d="${WAVE_PATH}" fill="${WAVE}"/>
  </g>
</svg>
`
}

/*
 * No `density`: the SVG carries explicit pixel width and height, so librsvg
 * rasterises it at exactly that size. Passing a density scales the result
 * relative to a 72 dpi baseline instead, which silently turns a 16 px request
 * into an 85 px image — and, in the ICO path below, a DIB whose payload no
 * longer matches the size its directory entry declares.
 */
function render(size) {
  return sharp(Buffer.from(svgFor(size))).png({ compressionLevel: 9 })
}

async function renderRaw(size) {
  const { data, info } = await render(size)
    .raw()
    .ensureAlpha()
    .toBuffer({ resolveWithObject: true })
  // Deliberately fatal rather than resized to fit: a mismatch here means the
  // rasteriser disagreed with the SVG, and quietly rescaling would give back the
  // blurry downscale the per-size rendering exists to avoid.
  if (info.width !== size || info.height !== size) {
    throw new Error(`rendered ${info.width}x${info.height} for a ${size}px icon`)
  }
  return data
}

/*
 * ICO entries are stored as either a PNG blob or a bottom-up 32-bit DIB. Windows
 * has read PNG entries since Vista, but only for the large sizes is that the
 * convention — icon editors still emit DIB below 128, and so does this, because
 * the installer chrome that consumes the 16 and 32 is the oldest code that will
 * ever open the file.
 */
async function dibEntry(size) {
  const raw = await renderRaw(size)
  const rowBytes = size * 4
  const pixels = Buffer.alloc(rowBytes * size)
  for (let y = 0; y < size; y += 1) {
    // DIB rows run bottom-up, and the channel order is BGRA rather than RGBA.
    const source = (size - 1 - y) * rowBytes
    for (let x = 0; x < size; x += 1) {
      const from = source + x * 4
      const to = y * rowBytes + x * 4
      pixels[to] = raw[from + 2]
      pixels[to + 1] = raw[from + 1]
      pixels[to + 2] = raw[from]
      pixels[to + 3] = raw[from + 3]
    }
  }

  // The 1-bit AND mask predates the alpha channel and is ignored when one is
  // present, but the header still has to account for its rows, padded to 4 bytes.
  const mask = Buffer.alloc(Math.ceil(size / 32) * 4 * size)

  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0)
  header.writeInt32LE(size, 4)
  // Doubled: the height field covers the colour rows and the mask rows together.
  header.writeInt32LE(size * 2, 8)
  header.writeUInt16LE(1, 12)
  header.writeUInt16LE(32, 14)
  header.writeUInt32LE(pixels.length + mask.length, 20)

  return Buffer.concat([header, pixels, mask])
}

async function buildIco(sizes) {
  const images = await Promise.all(
    sizes.map((size) => (size >= 128 ? render(size).toBuffer() : dibEntry(size)))
  )

  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(sizes.length, 4)

  let offset = 6 + sizes.length * 16
  const directory = sizes.map((size, index) => {
    const entry = Buffer.alloc(16)
    // 256 is written as 0: the field is one byte wide.
    entry.writeUInt8(size >= 256 ? 0 : size, 0)
    entry.writeUInt8(size >= 256 ? 0 : size, 1)
    entry.writeUInt16LE(1, 4)
    entry.writeUInt16LE(32, 6)
    entry.writeUInt32LE(images[index].length, 8)
    entry.writeUInt32LE(offset, 12)
    offset += images[index].length
    return entry
  })

  return Buffer.concat([header, ...directory, ...images])
}

await rm(iconsDir, { recursive: true, force: true })
await mkdir(iconsDir, { recursive: true })

// The master SVG is checked in so the mark can be inspected and edited as
// vector art; nothing in the build reads it.
await writeFile(join(buildDir, 'icon.svg'), svgFor(1024))

async function writePng(size, file) {
  const info = await render(size).toFile(file)
  if (info.width !== size || info.height !== size) {
    throw new Error(`wrote ${info.width}x${info.height} to ${file}, expected ${size}px`)
  }
}

await writePng(1024, join(buildDir, 'icon.png'))
for (const size of LINUX_SIZES) {
  await writePng(size, join(iconsDir, `${size}x${size}.png`))
}
await writeFile(join(buildDir, 'icon.ico'), await buildIco(ICO_SIZES))

console.log(`icon.png    1024x1024`)
console.log(`icons/      ${LINUX_SIZES.join(', ')}`)
console.log(`icon.ico    ${ICO_SIZES.join(', ')}`)
