/**
 * Renders the application icon set from the mark AppTitleBar draws: the tabler
 * `wave-sine` glyph on a rounded `bg-primary` badge.
 *
 * The mark lives in a component, where it is a `<UIcon>` inside a `<span>` and
 * therefore not a file anything can package. Rather than check in a hand-drawn
 * duplicate that silently drifts from the title bar, this reproduces it from the
 * same two inputs — the tabler path and the Tailwind amber ramp behind
 * `--ui-primary` — and rasterises every size the two platforms ask for.
 *
 * Each size is rendered from its own SVG rather than downscaled from one master.
 * That is the whole point of the exercise: a 2 px stroke that reads correctly at
 * 512 px resolves to a third of a pixel at 16 px and disappears into grey mush.
 * The hint table below thickens the stroke and grows the glyph as the canvas
 * shrinks, which is what keeps the small sizes legible on a 1x panel while the
 * large ones stay faithful on a hidpi one.
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
 * Tailwind's amber ramp, which is what `colors.primary: 'amber'` in
 * electron.vite.config.ts resolves `--ui-primary` to. Converted from the oklch
 * source values to sRGB once, here, because an icon is a raster artefact: it
 * cannot carry a token and be resolved later.
 *
 *   amber-400  oklch(82.8% 0.189 84.429)
 *   amber-600  oklch(66.6% 0.179 58.318)
 *   amber-950  oklch(27.9% 0.077 45.635)
 *
 * The badge runs 400 → 600 top to bottom, which brackets the amber-500 the title
 * bar renders flat, and reads as depth at 512 px without shifting the hue.
 */
const BADGE_TOP = '#ffb900'
const BADGE_BOTTOM = '#e17100'

/*
 * The glyph takes the dark end of the ramp rather than the white the title bar
 * uses in light mode. White on amber-500 is a 2.1:1 contrast ratio, which
 * survives at 20 px in a toolbar and does not survive at 16 px on a taskbar
 * against an arbitrary wallpaper; amber-950 is 6.1:1. Both are faithful — the
 * title bar itself draws the glyph dark in dark mode, because `text-inverted`
 * flips.
 */
const GLYPH = '#451a03'

// tabler `wave-sine`, on its native 24x24 grid, already centred on (12,12).
const GLYPH_PATH =
  'M21 12h-2c-.894 0-1.662-.857-1.761-2c-.296-3.45-.749-6-2.749-6s-2.5 3.582-2.5 8s-.5 8-2.5 8s-2.452-2.547-2.749-6c-.1-1.147-.867-2-1.763-2h-2'

/*
 * `inset` is in device pixels, not a percentage, so the badge edge lands on a
 * pixel boundary at every size instead of straddling one and rendering soft.
 * `glyph` is the fraction of the canvas the 24-unit grid is scaled to, and
 * `stroke` is in those grid units.
 */
const HINTS = [
  { size: 16, inset: 0, glyph: 0.82, stroke: 3.4 },
  { size: 24, inset: 1, glyph: 0.78, stroke: 3.1 },
  { size: 32, inset: 1, glyph: 0.74, stroke: 2.9 },
  { size: 48, inset: 2, glyph: 0.7, stroke: 2.7 },
  { size: 64, inset: 3, glyph: 0.68, stroke: 2.6 },
  { size: 128, inset: 6, glyph: 0.66, stroke: 2.5 },
  { size: 256, inset: 13, glyph: 0.64, stroke: 2.4 },
  { size: 512, inset: 27, glyph: 0.64, stroke: 2.4 },
  { size: 1024, inset: 54, glyph: 0.64, stroke: 2.4 }
]

// The hicolor sizes a desktop actually installs. 1024 is not one of them; it is
// the master that ships as build/icon.png.
const LINUX_SIZES = [16, 24, 32, 48, 64, 128, 256, 512]
// Windows reads 16/32/48 from Explorer and small taskbars, 256 for the large
// views and the installer, and the rest cover the 125–200% scaling steps.
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

function hintFor(size) {
  const hint = HINTS.find((entry) => entry.size === size)
  if (!hint) throw new Error(`no hint table entry for ${size}px`)
  return hint
}

function svgFor(size) {
  const { inset, glyph, stroke } = hintFor(size)
  const box = size - inset * 2
  // 20%, matching the `rounded` on the title bar's size-5 badge.
  const radius = Math.round(box * 0.2 * 100) / 100
  const scale = (size * glyph) / 24

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <linearGradient id="badge" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${BADGE_TOP}"/>
      <stop offset="1" stop-color="${BADGE_BOTTOM}"/>
    </linearGradient>
  </defs>
  <rect x="${inset}" y="${inset}" width="${box}" height="${box}" rx="${radius}" fill="url(#badge)"/>
  <g transform="translate(${size / 2} ${size / 2}) scale(${scale}) translate(-12 -12)">
    <path d="${GLYPH_PATH}" fill="none" stroke="${GLYPH}" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round"/>
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
