import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { createRouter, createWebHashHistory } from 'vue-router'
import ui from '@nuxt/ui/vue-plugin'
import App from './App.vue'
import { shellRoutes } from './shell/routes'
import './theme/main.css'
import { installTheme } from './theme'

// Hash history, not web history: the packaged renderer loads over file://,
// where there is no server to resolve a path-style route. Verified in the R4 spike.
const router = createRouter({
  history: createWebHashHistory(),
  routes: shellRoutes
})

// Before createApp, not inside it. Electron shows the window on
// `ready-to-show`, which fires after the first paint — so a theme applied here
// is applied before anything is visible, and one applied during app setup is
// not.
installTheme()

createApp(App).use(createPinia()).use(router).use(ui).mount('#app')
