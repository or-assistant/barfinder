/* Barfinder — Dienstarbeiter (Service Worker).
 *
 * Zweck: die App laesst sich aufs Handy legen und startet auch dann, wenn das
 * Netz gerade weg ist. In der Projektdokumentation stand das unter den
 * bekannten Luecken ("Kein Offline-Support: Keine Service Worker, kein
 * PWA-Manifest"), Abschnitt 10.3.
 *
 * Bewusst zurueckhaltend:
 *   - Schnittstellenaufrufe (/api/) werden NIE zwischengespeichert. Ein
 *     Ausgehtipp von gestern ist schlimmer als gar keiner.
 *   - Die Seite selbst kommt zuerst aus dem Netz. Nur wenn das scheitert,
 *     wird die letzte gespeicherte Fassung gezeigt. Sonst haette man die App
 *     nach einer Aenderung nicht mehr aktualisiert bekommen.
 *   - Schriften, Stilvorlagen und Symbole kommen zuerst aus dem Speicher,
 *     die aendern sich praktisch nie.
 */

const SPEICHER = 'barfinder-v1';
const HUELLE = './';

self.addEventListener('install', (ereignis) => {
  ereignis.waitUntil(
    caches.open(SPEICHER)
      .then((c) => c.addAll([HUELLE]).catch(() => { /* offline installiert: egal */ }))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (ereignis) => {
  ereignis.waitUntil(
    caches.keys()
      .then((namen) => Promise.all(namen.filter((n) => n !== SPEICHER).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (ereignis) => {
  const anfrage = ereignis.request;
  if (anfrage.method !== 'GET') return;

  const adresse = new URL(anfrage.url);
  if (adresse.origin !== self.location.origin) return;      // Karten-Kacheln, Leaflet: durchlassen
  if (adresse.pathname.includes('/api/')) return;           // nie zwischenspeichern
  if (adresse.pathname.includes('/admin')) return;

  // Die Seite selbst: erst Netz, dann Speicher.
  if (anfrage.mode === 'navigate') {
    ereignis.respondWith(
      fetch(anfrage)
        .then((antwort) => {
          const kopie = antwort.clone();
          caches.open(SPEICHER).then((c) => c.put(HUELLE, kopie)).catch(() => {});
          return antwort;
        })
        .catch(() => caches.match(HUELLE).then((t) => t || new Response(
          '<meta charset="utf-8"><body style="background:#0a0a0a;color:#eee;font-family:system-ui;padding:2rem">' +
          '<h1>🍸 Barfinder</h1><p>Gerade keine Verbindung. Sobald das Netz wieder da ist, laedt die Karte neu.</p>',
          { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
        )))
    );
    return;
  }

  // Schriften, Stilvorlagen, Symbole: erst Speicher, dann Netz.
  if (adresse.pathname.includes('/static/')) {
    ereignis.respondWith(
      caches.match(anfrage).then((treffer) => treffer || fetch(anfrage).then((antwort) => {
        if (antwort.ok) {
          const kopie = antwort.clone();
          caches.open(SPEICHER).then((c) => c.put(anfrage, kopie)).catch(() => {});
        }
        return antwort;
      }))
    );
  }
});
