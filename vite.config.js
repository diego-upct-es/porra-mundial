import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // injectManifest: usamos nuestro propio SW (src/sw.js) para poder
      // manejar Push Notifications además del precache de Workbox.
      strategies: 'injectManifest',
      srcDir:     'src',
      filename:   'sw.js',

      // autoUpdate: el SW se actualiza en segundo plano sin preguntar.
      registerType: 'autoUpdate',

      manifest: {
        name:             'Porra Mundial 2026',
        short_name:       'Porra 26',
        description:      'Predicciones del Mundial de Fútbol 2026',
        theme_color:      '#0c0b22',
        background_color: '#0c0b22',
        display:          'standalone',
        start_url:        '/',
        scope:            '/',
        lang:             'es',
        icons: [
          {
            src:     '/favicon.svg',
            sizes:   'any',
            type:    'image/svg+xml',
            purpose: 'any',
          },
        ],
      },

      // Activa el SW también en desarrollo (para probar push localmente)
      devOptions: {
        enabled: true,
        type:    'module',
      },
    }),
  ],
})
