// Nombre de la caché (Cambia el "v1" a "v2", "v3" etc., cuando actualices tu código para forzar la recarga)
const CACHE_NAME = 'tpv-cache-v111';

// Archivos críticos que deben guardarse para que la app funcione sin internet
const urlsToCache = [
  './',
  './index.html',
  './styles.css',   
  './app.js',
  './manifest.json',
  // Si agregas los iconos, descomenta las siguientes líneas:
  // './icon-192x192.png',
  // './icon-512x512.png'
];

// ==========================================
// 1. FASE DE INSTALACIÓN
// ==========================================
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('SW: Archivos cacheados correctamente');
        return cache.addAll(urlsToCache);
      })
  );
  // Fuerza a que este Service Worker se active inmediatamente
  self.skipWaiting(); 
});

// ==========================================
// 2. FASE DE ACTIVACIÓN
// ==========================================
// Sirve para limpiar cachés viejas si cambiaste la versión (ej. de v1 a v2)
self.addEventListener('activate', event => {
  const cacheAllowlist = [CACHE_NAME];
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheAllowlist.indexOf(cacheName) === -1) {
            console.log('SW: Borrando caché antigua', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  // Toma el control de las páginas abiertas inmediatamente
  self.clients.claim(); 
});

// ==========================================
// 3. INTERCEPTOR DE PETICIONES (Estrategias)
// ==========================================
self.addEventListener('fetch', event => {
  // EXCEPCIÓN: Si la petición va a tu Google Apps Script (la API), NO usar caché.
  // Queremos que pase directo para que app.js maneje los datos frescos o los errores offline.
  if (event.request.url.includes('script.google.com')) {
    return; 
  }

  // ESTRATEGIA "Cache-First": Para la interfaz (HTML, CSS, JS)
  // Busca primero en la caché; si no está, va a internet.
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        // Devuelve el archivo desde la caché si existe
        if (response) {
          return response;
        }
        // Si no está cacheado, lo pide a la red
        return fetch(event.request).catch(() => {
          // Opcional: Aquí podrías retornar una página de "Error general offline"
          console.warn('SW: Recurso no encontrado en caché ni en red', event.request.url);
        });
      })
  );
});
