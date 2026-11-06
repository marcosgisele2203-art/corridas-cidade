/* Vai de Manu — PWA passageiro. Não armazenar APIs, rotas, endereços ou dados do usuário. */
const CACHE_NAME = 'vai-manu-passageiro-shell-v1';
const STATIC = [
  '/passageiro.css', '/manu.png', '/favicon.png', '/apple-touch-icon.png',
  '/passageiro.webmanifest', '/offline-passageiro.html'
];
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC)));
  self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys
      .filter((key) => key.startsWith('vai-manu-passageiro-shell-') && key !== CACHE_NAME)
      .map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  const url = new URL(request.url);
  // Navegações sempre usam a versão online; não armazenamos páginas com dados de viagem.
  if (request.mode === 'navigate') {
    if (url.pathname !== '/passageiro.html') return;
    event.respondWith(fetch(request).catch(() => caches.match('/offline-passageiro.html')));
    return;
  }
  if (!STATIC.includes(url.pathname)) return;
  event.respondWith(fetch(request).then((response) => {
    if (response.ok) {
      const copy = response.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
    }
    return response;
  }).catch(() => caches.match(request)));
});
