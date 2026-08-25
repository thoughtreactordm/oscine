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
  // No remote origin, including for Discover's Apple catalogue thumbnails:
  // those are proxied through main over `oscine:` so the renderer never opens
  // a socket (D14) and the operator's IP never reaches Apple.
  "img-src 'self' data: blob: oscine:",
  "font-src 'self' data:",
  // `oscine:` is the custom protocol main registers to serve track bytes.
  // The renderer fetches it for decodeAudioData; it never sees a real path.
  "media-src 'self' blob: oscine:",
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
const devCsp = [...BASE_CSP, "connect-src 'self' oscine: ws://localhost:* http://localhost:*"].join(
  '; '
)
const prodCsp = [...BASE_CSP, "connect-src 'self' oscine:"].join('; ')

function cspPlugin(): Plugin {
  return {
    name: 'oscine:csp',
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

/*
 * `music-metadata` is pure ESM (`"type": "module"`, no CJS entry), and main is
 * built as CommonJS. Left external, the bundle would `require()` it and fail at
 * runtime — in the packaged build, on the first scan. Bundling it instead is
 * safe because it is plain JavaScript with no native addon, unlike
 * better-sqlite3, which must stay external for exactly that reason.
 */
const BUNDLED_ESM_DEPS = ['music-metadata']

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: BUNDLED_ESM_DEPS })],
    resolve: { alias: { '@shared': shared } },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          artworkWorker: resolve(__dirname, 'src/main/library/artworkWorker.ts'),
          replayGainWorker: resolve(__dirname, 'src/main/replaygain/worker.ts')
        }
      }
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
        ui: {
          colors: {
            primary: 'amber',
            neutral: 'taupe'
          },
          icons: {
            arrowDown: 'i-tabler-arrow-down',
            arrowLeft: 'i-tabler-arrow-left',
            arrowRight: 'i-tabler-arrow-right',
            arrowUp: 'i-tabler-arrow-up',
            caution: 'i-tabler-alert-circle',
            check: 'i-tabler-check',
            chevronDoubleLeft: 'i-tabler-chevrons-left',
            chevronDoubleRight: 'i-tabler-chevrons-right',
            chevronDown: 'i-tabler-chevron-down',
            chevronLeft: 'i-tabler-chevron-left',
            chevronRight: 'i-tabler-chevron-right',
            chevronUp: 'i-tabler-chevron-up',
            close: 'i-tabler-x',
            copy: 'i-tabler-copy',
            copyCheck: 'i-tabler-copy-check',
            dark: 'i-tabler-moon-filled',
            drag: 'i-tabler-grip-vertical',
            ellipsis: 'i-tabler-dots',
            error: 'i-tabler-circle-x',
            external: 'i-tabler-arrow-up-right',
            eye: 'i-tabler-eye',
            eyeOff: 'i-tabler-eye-off',
            file: 'i-tabler-file',
            folder: 'i-tabler-folder',
            folderOpen: 'i-tabler-folder-open',
            hash: 'i-tabler-hash',
            info: 'i-tabler-info-circle',
            light: 'i-tabler-sun-high-filled',
            loading: 'i-tabler-loader-2',
            menu: 'i-tabler-menu-2',
            minus: 'i-tabler-minus',
            panelClose: 'i-tabler-layout-sidebar-left-collapse',
            panelOpen: 'i-tabler-layout-sidebar-left-expand',
            plus: 'i-tabler-plus',
            reload: 'i-tabler-rotate',
            search: 'i-tabler-search',
            star: 'i-tabler-star',
            stop: 'i-tabler-square',
            success: 'i-tabler-circle-check',
            system: 'i-tabler-device-desktop',
            tip: 'i-tabler-bulb',
            upload: 'i-tabler-upload',
            warning: 'i-tabler-alert-triangle'
          },
          // Nuxt UI's tooltip is a single-line pill: `h-6` on the content and
          // `truncate` on the text. That is right for a label restating a
          // button's name and wrong for every explanatory tooltip in the app —
          // constrain the width and the sentence ellipsises instead of
          // wrapping, so the caveat you hovered to read is the half you cannot
          // see.
          //
          // `text-clip` rather than `whitespace-normal` to undo it: `truncate`
          // is three declarations behind one class, and tailwind-merge only
          // drops it for another member of its own group. `whitespace-normal`
          // sits in a different group, so both would survive the merge and
          // which one won would come down to Tailwind's emission order.
          //
          // `h-auto` only replaces the fixed height; the default `py-1` and
          // `text-xs` line box still add up to the same 24px for a one-line
          // tooltip, so the hundred short ones in the app are unchanged and
          // only a hint long enough to wrap grows.
          tooltip: {
            slots: {
              content: 'h-auto max-w-72 text-pretty',
              text: 'text-clip'
            }
          }
        },
        // Without clientBundle the Iconify runtime fetches icon data from
        // api.iconify.design on demand: icons vanish offline and the app makes
        // an unsolicited third-party request on cold start. Also verified in R4.
        //
        // `scan` picks up icons used directly in components.  Icons that
        // only live in the ui.icons config (consumed at runtime via appConfig)
        // must be listed explicitly — Nuxt UI's extraIcons filter trusts only
        // its own default collection (lucide), silently dropping tabler names.
        icon: {
          clientBundle: {
            // The default glob is `.vue` and friends, which does not include
            // plain `.ts` — and the shell's tab table names its icons in
            // `shell/routes.ts`. A name only found there resolved to an empty
            // <svg> in the packaged build and to nothing visible on screen,
            // with no build warning, so the glob is widened rather than the
            // table split in two to suit the scanner.
            scan: { globInclude: ['**/*.{vue,ts,jsx,tsx,md,mdc,mdx,yml,yaml}'] },
            icons: [
              'i-tabler-arrow-down',
              'i-tabler-arrow-left',
              'i-tabler-arrow-right',
              'i-tabler-arrow-up',
              'i-tabler-alert-circle',
              'i-tabler-check',
              'i-tabler-chevrons-left',
              'i-tabler-chevrons-right',
              'i-tabler-chevron-down',
              'i-tabler-chevron-left',
              'i-tabler-chevron-right',
              'i-tabler-chevron-up',
              'i-tabler-x',
              'i-tabler-copy',
              'i-tabler-copy-check',
              'i-tabler-moon-filled',
              'i-tabler-grip-vertical',
              'i-tabler-dots',
              'i-tabler-circle-x',
              'i-tabler-arrow-up-right',
              'i-tabler-eye',
              'i-tabler-eye-off',
              'i-tabler-file',
              'i-tabler-folder',
              'i-tabler-folder-open',
              'i-tabler-hash',
              'i-tabler-info-circle',
              'i-tabler-sun-high-filled',
              'i-tabler-loader-2',
              'i-tabler-menu-2',
              'i-tabler-minus',
              'i-tabler-layout-sidebar-left-collapse',
              'i-tabler-layout-sidebar-left-expand',
              'i-tabler-plus',
              'i-tabler-rotate',
              'i-tabler-search',
              'i-tabler-star',
              'i-tabler-square',
              'i-tabler-circle-check',
              'i-tabler-device-desktop',
              'i-tabler-bulb',
              'i-tabler-upload',
              'i-tabler-alert-triangle',
              // The settings category rail, from `SETTING_CATEGORIES` in
              // `src/shared/settings/kernel.ts`. Same failure as the tab table
              // above and one the widened glob cannot fix: the scan is rooted at
              // the renderer, and the category table is a cross-process contract
              // that lives in `src/shared` because main reads it too. Four of the
              // six happened to resolve anyway, because a component elsewhere
              // names the same icon — which is worse than none of them, since it
              // makes the gap look like a bad icon name rather than a missing
              // scan root.
              'i-tabler-wave-sine',
              'i-tabler-player-play',
              'i-tabler-library',
              'i-tabler-layout-2',
              'i-tabler-palette',
              'i-tabler-microphone',
              'i-tabler-world'
            ]
          }
        }
      })
    ],
    build: {
      outDir: resolve(__dirname, 'out/renderer'),
      emptyOutDir: true,
      rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } }
    }
  }
})
