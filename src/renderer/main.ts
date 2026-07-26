import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { createRouter, createWebHashHistory } from 'vue-router'
import ui from '@nuxt/ui/vue-plugin'
import App from './App.vue'
import LibraryView from './panels/LibraryView.vue'
import './theme/main.css'

// Hash history, not web history: the packaged renderer loads over file://,
// where there is no server to resolve a path-style route. Verified in the R4 spike.
const router = createRouter({
  history: createWebHashHistory(),
  routes: [{ path: '/', name: 'library', component: LibraryView }]
})

createApp(App).use(createPinia()).use(router).use(ui).mount('#app')
