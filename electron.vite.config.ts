import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import type { Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import ui from '@nuxt/ui/vite'

const shared = resolve(__dirname, 'src/shared')

/*
 * `style-src 'unsafe-inline'` is required: Vue SFCs and Nuxt UI emit inline
 * style attributes. Scripts get no such exemption — that is the one that matters.
 * `media-src blob:` is here for W3's audio; the custom protocol chosen in W1-3
 * gets added when it lands.
 */
const BASE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: fermata:",
  "font-src 'self' data:",
  // `fermata:` is the custom protocol main registers to serve track bytes.
  // The renderer fetches it for decodeAudioData; it never sees a real path.
  "media-src 'self' blob: fermata:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  // `frame-src`, not `frame-ancestors`: the latter is ignored when delivered via
  // <meta> (Chromium logs an error), and a top-level BrowserWindow cannot be
  // framed anyway. Blocking frames we might embed is the useful direction.
  "frame-src 'none'"
]

// The dev server needs a websocket back to Vite for HMR. Production must not
// carry that allowance, so the policy is built per mode rather than shared.
const devCsp = [
  ...BASE_CSP,
  "connect-src 'self' fermata: ws://localhost:* http://localhost:*"
].join('; ')
const prodCsp = [...BASE_CSP, "connect-src 'self' fermata:"].join('; ')

function cspPlugin(): Plugin {
  return {
    name: 'fermata:csp',
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        const policy = ctx.server ? devCsp : prodCsp
        return html.replace(
          '<!--CSP-->',
          `<meta http-equiv="Content-Security-Policy" content="${policy}" />`
        )
      }
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': shared } },
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': shared } },
    build: {
      // CommonJS, deliberately: Electron does not support an ESM preload when
      // sandbox is enabled, and sandbox stays on (design section 6).
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].js' }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    // Relative base is load-bearing: the packaged renderer loads over file://,
    // where Vite's default absolute '/assets/...' resolves to filesystem root
    // and 404s. Verified in the R4 spike.
    base: './',
    resolve: {
      alias: {
        '@renderer': resolve(__dirname, 'src/renderer'),
        '@shared': shared
      }
    },
    plugins: [
      cspPlugin(),
      vue(),
      ui({
        // Without clientBundle the Iconify runtime fetches icon data from
        // api.iconify.design on demand: icons vanish offline and the app makes
        // an unsolicited third-party request on cold start. Also verified in R4.
        icon: { clientBundle: { scan: true } }
      })
    ],
    build: {
      outDir: resolve(__dirname, 'out/renderer'),
      emptyOutDir: true,
      rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } }
    }
  }
})
