const CACHE_NAME = 'almacen-v236'; // Incrementa esto cada vez que hagas cambios
const ASSETS = [
    './',
    './index.html',
    './styles.css',
    './app.js',
    './FavIcon.png',
    './logo.png',
];

// 1. Instalar y forzar al SW entrante a convertirse en el SW activo inmediatamente
self.addEventListener('install', event => {
    self.skipWaiting(); // No esperar a que se cierren las pestañas viejas
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
    );
});

// 2. Activar y LIMPIAR las cachés antiguas de versiones anteriores (ej. almacen-v220)
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames.map(cache => {
                    if (cache !== CACHE_NAME) {
                        console.log('Eliminando caché antigua:', cache);
                        return caches.delete(cache);
                    }
                })
            );
        }).then(() => self.clients.claim()) // Tomar control de las páginas inmediatamente
    );
});

// 3. Interceptar peticiones (Estrategia Network First para código de la app)
self.addEventListener('fetch', event => {
    // Excluir peticiones a Google Apps Script
    if (event.request.url.includes('script.google.com') || event.request.url.includes('google.com/favicon.ico')) {
        return;     
    }

    event.respondWith(
        // Intentar obtener de la red primero para tener siempre la última versión
        fetch(event.request)
            .then(networkResponse => {
                // Si la red responde bien, actualizamos la caché y devolvemos la respuesta
                if (networkResponse && networkResponse.status === 200 && event.request.method === 'GET') {
                    const responseClone = networkResponse.clone();
                    caches.open(CACHE_NAME).then(cache => {
                        cache.put(event.request, responseClone);
                    });
                }
                return networkResponse;
            })
            .catch(() => {
                // Si NO hay red (Offline), usamos la versión guardada en caché
                return caches.match(event.request);
            })
    );
});
