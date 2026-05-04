// IMPORTANTE: Incrementar CACHE_VERSION a cada novo deploy para invalidar cache antigo.
// Formato sugerido: 'horsesmart-vN' onde N é o número sequencial do deploy.
const CACHE_VERSION = 'horsesmart-v2';
const CACHE_URLS = [
  '/',
  '/index.html',
  '/login.html',
  '/cadastro.html',
  '/dashboard.html',
  '/firebase.js',
  'https://cdn.tailwindcss.com',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css',
  'https://fonts.googleapis.com/css2?family=Poppins:wght@300;400;600;800&display=swap',
  'https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js',
  'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js',
  'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js'
];

// ============================================================
// 1. INSTALAÇÃO E CACHE
// ============================================================
self.addEventListener('install', (event) => {
  console.log('[Service Worker] Instalando...');
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => {
      console.log('[Service Worker] Cache aberto');
      return cache.addAll(CACHE_URLS).catch(err => {
        console.warn('[Service Worker] Alguns recursos não puderam ser cacheados:', err);
      });
    }).then(() => self.skipWaiting())
  );
});

// ============================================================
// 2. ATIVAÇÃO E LIMPEZA DE CACHES ANTIGOS
// ============================================================
self.addEventListener('activate', (event) => {
  console.log('[Service Worker] Ativando...');
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter(name => name !== CACHE_VERSION)
          .map(name => {
            console.log('[Service Worker] Deletando cache antigo:', name);
            return caches.delete(name);
          })
      );
    }).then(() => self.clients.claim())
  );
});

// ============================================================
// 3. ESTRATÉGIA: NETWORK FIRST COM CACHE FALLBACK
// G3: rotas /api/, /stripe-webhook e /admin nunca são cacheadas
// ============================================================
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Ignorar requisições não-GET
  if (request.method !== 'GET') {
    return;
  }

  // G3: Nunca cachear rotas de API, webhook ou admin — network only
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname === '/stripe-webhook' ||
    url.pathname.startsWith('/admin') ||
    url.pathname.startsWith('/proprietarios')
  ) {
    return;
  }

  // Ignorar requisições externas a APIs (Stripe, Firebase, etc)
  if (url.hostname !== self.location.hostname &&
      !url.hostname.includes('gstatic.com') &&
      !url.hostname.includes('cdnjs.cloudflare.com') &&
      !url.hostname.includes('fonts.googleapis.com') &&
      !url.hostname.includes('cdn.tailwindcss.com')) {
    return;
  }

  event.respondWith(
    fetch(request)
      .then((response) => {
        // Cachear respostas bem-sucedidas
        if (response && response.status === 200) {
          const responseClone = response.clone();
          caches.open(CACHE_VERSION).then((cache) => {
            cache.put(request, responseClone);
          });
        }
        return response;
      })
      .catch(() => {
        // Se offline, retornar do cache
        return caches.match(request).then((cachedResponse) => {
          if (cachedResponse) {
            console.log('[Service Worker] Offline - retornando do cache:', request.url);
            return cachedResponse;
          }
          // Se não tiver no cache, retornar página genérica offline
          return caches.match('/').catch(() => {
            return new Response('Você está offline. Por favor, reconecte à internet.', {
              status: 503,
              statusText: 'Service Unavailable',
              headers: new Headers({ 'Content-Type': 'text/plain' })
            });
          });
        });
      })
  );
});

// ============================================================
// 4. SINCRONIZAÇÃO DE BACKGROUND
// ============================================================
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-data') {
    console.log('[Service Worker] Sincronizando dados com o servidor...');
    event.waitUntil(syncData());
  }
});

async function syncData() {
  try {
    const clients = await self.clients.matchAll();
    clients.forEach(client => {
      client.postMessage({
        type: 'SYNC_START',
        timestamp: new Date().toISOString()
      });
    });

    console.log('[Service Worker] Sincronização concluída');

    clients.forEach(client => {
      client.postMessage({
        type: 'SYNC_COMPLETE',
        timestamp: new Date().toISOString()
      });
    });
  } catch (error) {
    console.error('[Service Worker] Erro na sincronização:', error);
    const clients = await self.clients.matchAll();
    clients.forEach(client => {
      client.postMessage({
        type: 'SYNC_ERROR',
        error: error.message
      });
    });
  }
}

// ============================================================
// 5. PUSH NOTIFICATIONS (Opcional para futuro)
// ============================================================
self.addEventListener('push', (event) => {
  if (!event.data) return;

  const data = event.data.json();
  const options = {
    body: data.body || 'HorseSmart',
    icon: '/data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192"><rect fill="%232D5A4E" width="192" height="192"/><text x="50%" y="50%" font-size="80" font-weight="bold" fill="%23D2B48C" text-anchor="middle" dominant-baseline="middle">HS</text></svg>',
    badge: '/data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect fill="%232D5A4E" width="96" height="96"/><circle cx="48" cy="48" r="30" fill="%23D2B48C"/></svg>',
    tag: data.tag || 'horsesmart-notification',
    requireInteraction: data.requireInteraction || false
  };

  event.waitUntil(
    self.registration.showNotification(data.title || 'HorseSmart', options)
  );
});

// ============================================================
// 6. MESSAGE LISTENER (Comunicação com página)
// ============================================================
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

console.log('[Service Worker] Script carregado e aguardando eventos...');
