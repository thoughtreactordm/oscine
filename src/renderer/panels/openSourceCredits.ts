/**
 * The Open Source credits, hand-curated — G7 (settled).
 *
 * Deliberately not a generated dependency dump: this is the notable stack Oscine
 * leans on, chosen for recognition rather than completeness, each with its
 * licence and a link to the project. Add a project here when it becomes load
 * bearing, not when it appears in the lockfile — the point is the shape of what
 * Oscine is built on, which a full `node_modules` listing only obscures.
 *
 * Licences are the project's own SPDX identifier, not a per-version reading; if
 * one relicenses, it is corrected here by hand like everything else in the list.
 */
export interface OpenSourceCredit {
  name: string
  /** One short phrase on what it does for Oscine. */
  purpose: string
  /** SPDX licence identifier. */
  license: string
  url: string
}

export const OPEN_SOURCE_CREDITS: readonly OpenSourceCredit[] = [
  {
    name: 'Electron',
    purpose: 'The desktop application shell',
    license: 'MIT',
    url: 'https://www.electronjs.org'
  },
  {
    name: 'Vue',
    purpose: 'The renderer UI framework',
    license: 'MIT',
    url: 'https://vuejs.org'
  },
  {
    name: 'Nuxt UI',
    purpose: 'The component library',
    license: 'MIT',
    url: 'https://ui.nuxt.com'
  },
  {
    name: 'Pinia',
    purpose: 'Renderer state management',
    license: 'MIT',
    url: 'https://pinia.vuejs.org'
  },
  {
    name: 'Vue Router',
    purpose: 'Shell tab navigation',
    license: 'MIT',
    url: 'https://router.vuejs.org'
  },
  {
    name: 'Tailwind CSS',
    purpose: 'The styling engine',
    license: 'MIT',
    url: 'https://tailwindcss.com'
  },
  {
    name: 'VueUse',
    purpose: 'Composition utilities',
    license: 'MIT',
    url: 'https://vueuse.org'
  },
  {
    name: 'better-sqlite3',
    purpose: 'The library database',
    license: 'MIT',
    url: 'https://github.com/WiseLibs/better-sqlite3'
  },
  {
    name: 'music-metadata',
    purpose: 'Reading tags from audio files',
    license: 'MIT',
    url: 'https://github.com/borewit/music-metadata'
  },
  {
    name: 'node-web-audio-api',
    purpose: 'ReplayGain analysis off the main thread',
    license: 'MIT',
    url: 'https://github.com/ircam-ismm/node-web-audio-api'
  },
  {
    name: 'sharp',
    purpose: 'Cover artwork processing',
    license: 'Apache-2.0',
    url: 'https://sharp.pixelplumbing.com'
  },
  {
    name: 'Tabler Icons',
    purpose: 'The icon set',
    license: 'MIT',
    url: 'https://tabler.io/icons'
  },
  {
    name: 'Vite',
    purpose: 'The build tool',
    license: 'MIT',
    url: 'https://vite.dev'
  },
  {
    name: 'electron-vite',
    purpose: 'Electron build integration',
    license: 'MIT',
    url: 'https://electron-vite.org'
  }
]
