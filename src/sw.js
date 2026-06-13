/**
 * Service Worker — Porra Mundial 2026
 *
 * vite-plugin-pwa (injectManifest) compila este fichero e inyecta
 * automáticamente la lista de assets en self.__WB_MANIFEST.
 *
 * Capabilities:
 *   • Precache + serve de todos los assets del build (offline)
 *   • Recepción de Push Notifications (daily-alert a las 9:00)
 *   • Apertura de la app al pulsar la notificación
 */

import { precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching';

// Inyectado por vite-plugin-pwa en el build
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// ── Push ──────────────────────────────────────────────────────
self.addEventListener('push', (event) => {
  const data   = event.data?.json() ?? {};
  const title  = data.title ?? 'Porra Mundial 2026';
  const body   = data.body  ?? '¡Hora de predecir los partidos de hoy!';

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon:      '/favicon.svg',
      badge:     '/favicon.svg',
      tag:       'porra-aviso',   // reemplaza notificación anterior (sin pila)
      renotify:  true,
    }),
  );
});

// ── Notificationclick: abre/enfoca la app ─────────────────────
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  event.waitUntil(
    clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          if ('focus' in client) return client.focus();
        }
        if (clients.openWindow) return clients.openWindow('/');
      }),
  );
});
