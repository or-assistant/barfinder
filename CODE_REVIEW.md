# 🔍 Code Review: Barfinder Hamburg

**Datum:** 2026-02-15  
**Dateien:** `server.js` (2322 Zeilen), `index.html` (1276 Zeilen)

---

## 🔴 HOHE PRIORITÄT

### 1. Massives HIGHLIGHTS-Array hard-coded in server.js (~200 Bars)
- **Datei:** `server.js` Zeile 166–528+
- **Was:** ~200 Bar-Einträge mit Name, Koordinaten, Adresse, Öffnungszeiten, Beschreibungen — alles inline im Code
- **Problem:** Jede Änderung (neue Bar, Korrektur) erfordert Server-Neustart. Code ist 80% Daten, 20% Logik. Unübersichtlich, fehleranfällig.
- **Lösung:** `highlights.json` auslagern, beim Start laden, optional Hot-Reload per File-Watcher. Ermöglicht auch Admin-UI oder API zum Editieren.

### 2. MAJOR_EVENTS mit hard-coded Datumswerten
- **Datei:** `server.js` Zeile 100–112
- **Was:** `{ name: 'Hafengeburtstag', startMonth: 5, startDay: 8, endDay: 10, boost: 1.5 }` — Daten für 2025/2026 hard-coded
- **Problem:** Event-Daten ändern sich jährlich. Hafengeburtstag 2027 hat andere Daten. Osterfeuer hängt vom Kalender ab.
- **Lösung:** `events_config.json` mit Jahresangabe, oder API-basiertes Laden. Mindestens: `year: 2026` pro Event, damit man weiß wann es veraltet ist.

### 3. STATIC_EVENTS mit hard-coded Wochentagen statt Daten
- **Datei:** `server.js` Zeile 545–548
- **Was:** `{ title: "Wine Tasting Abend", date: "Fr", time: "19:00" }` — Wochentag statt echtem Datum
- **Problem:** Zeigt Events die längst vorbei oder nie stattgefunden haben. Keine Möglichkeit, einmalige Events abzubilden.
- **Lösung:** Echte ISO-Daten verwenden, oder diesen Block komplett durch Cache-basierte Events ersetzen (ist teilweise schon so).

### 4. Static Network Events mit spezifischen Daten
- **Datei:** `server.js` Zeile ~580–650
- **Was:** `{ date: "2026-02-17", title: "Hamburg Startup Monday" }` — 7 statische Events mit konkreten Daten
- **Problem:** Nach dem 21.02.2026 sind alle Events veraltet. Werden trotzdem angezeigt (Date-Filter im Client ist schwach).
- **Lösung:** Recurring-Pattern mit `rrule` oder diese komplett durch echte Event-Quellen ersetzen. Mindestens Ablaufdatum + Auto-Cleanup.

### 5. Duplizierte Funktionen: estimatePopularityByCategory, getTodaysEvents, getDayFactors
- **Datei:** `server.js` Zeile ~1440 vs ~1585, ~1475 vs ~1610, ~1310 vs ~1545
- **Was:** `estimatePopularityByCategory` ist 2x definiert (identisch!), `getTodaysEvents` 2x (leicht unterschiedlich — Bug!), `getDayFactors` + `getImprovedDayFactors`, `getScoreLabel` + `getEnhancedScoreLabel`, `getDescriptionBonus` + `getEnhancedDescriptionBonus`, `getCategoryAdjustment` + `getCategoryTimeAdjustment`
- **Problem:** Die zweite `getTodaysEvents` überschreibt die erste aber nutzt `eventsData` statt `eventsCache` — inkonsistentes Verhalten. Alte "unimproved" Funktionen sind toter Code.
- **Lösung:** Duplikate entfernen. Nur die "Enhanced/Improved" Versionen behalten. `getTodaysEvents` vereinheitlichen.

### 6. Default-Koordinaten an 4+ Stellen hard-coded
- **Datei:** `server.js` Zeilen: API defaults (~2090, ~2105), Weather-URL (Zeile 47), Google scrape pb-Parameter (Zeile 14)  
  `index.html`: `S={lat:53.5775,lon:9.9785,...}`, `SAVED_LOCS`
- **Was:** `53.5775, 9.9785` (Eppendorf) und `53.55, 10.0` (Hamburg allgemein) mehrfach hard-coded
- **Problem:** Wenn der User umzieht, müssen ~6 Stellen geändert werden.
- **Lösung:** Eine `config.js` oder `config.json` mit `DEFAULT_LAT`, `DEFAULT_LON`. Client und Server importieren/laden dieselbe Quelle.

### 7. Google Maps Scraper pb-Parameter
- **Datei:** `server.js` Zeile 14–15
- **Was:** Riesiger `pb=...` Query-String für Google Maps Scraping, inkl. hard-coded Session-IDs
- **Problem:** Google ändert das Format regelmäßig → Scraper bricht ohne Warnung. Session-IDs (`a9fVWea_MsX8adX8j8AE`) sind Einweg-Tokens.
- **Lösung:** pb-String in Config auslagern, Error-Handling verbessern, Fallback wenn Scraping fehlschlägt. Alternativ: Google Places API (kostet, aber stabil).

---

## 🟡 MITTLERE PRIORITÄT

### 8. 15+ Cache-Dateien hard-coded referenziert
- **Datei:** `server.js` Zeile 135–200
- **Was:** `'./popular_times_cache.json'`, `'./events_cache.json'`, `'./realtime_cache.json'`, `'./google_ratings_cache.json'`, `'./populartimes_cache.json'`, `'./yelp_cache.json'`, `'./yelp_reviews_cache.json'`, `'./hamburg_events_cache.json'`, `'./events_pipeline_cache.json'`, `'./eventbrite_events_cache.json'`, `'./new_sources_events_cache.json'`, `'./mitvergnuegen_cache.json'`, `'./hamburgwork_events_cache.json'`, `'./rural_events_cache.json'`, `'./opentable_cache.json'`, `'./network_events_cache.json'`
- **Problem:** Pfade überall verstreut, teilweise mit Fallback-Ketten. Kein zentrales Cache-Management.
- **Lösung:** `CACHE_FILES` Objekt/Config zentral definieren. Loader-Funktion `loadCacheFile(key)` die Pfad, Fallback und Error-Handling kapselt.

### 9. Duplizierter Event-Merge-Code (6x fast identisch)
- **Datei:** `server.js` in `getNetworkEvents()` Zeile ~570–770
- **Was:** 6 fast identische try/catch-Blöcke die Events aus verschiedenen Caches mergen (Pipeline, Eventbrite, newSources, mitvergnuegen, hamburgwork, rural)
- **Problem:** Copy-Paste-Code. Jeder Block hat leicht andere Felder aber dieselbe Struktur.
- **Lösung:** `mergeEventsFromCache(cache, source, options)` Hilfsfunktion. Einmal schreiben, 6x aufrufen.

### 10. Magic Numbers ohne Erklärung
- **Datei:** `server.js` diverse Stellen
- **Was:** 
  - `CACHE_TTL = 3600000` (Zeile ~132) — 1h, aber warum?
  - `MIN_REQUEST_INTERVAL = 30000` (Zeile ~133) — 30s
  - `15000` Timeout für Google Scrape (Zeile 32)
  - `0.4`, `0.7`, `1.8` als Multiplikatoren überall
  - `40`, `30`, `18`, `15`, `12` Punkte-Boni in Scoring
  - `req.setTimeout(15000, ...)` 
- **Problem:** Schwer zu tunen, schwer zu verstehen warum genau diese Werte.
- **Lösung:** Benannte Konstanten: `const OVERPASS_CACHE_TTL_MS = 3600000; // 1 hour`, Score-Weights in Config-Objekt.

### 11. SAVED_LOCS in Client UND Server-Defaults redundant
- **Datei:** `index.html` Zeile (JS-Block) + `server.js` API-Defaults
- **Was:** `home: {lat:53.5775, lon:9.9785}` im Client, `53.5775` als Default in `/api/places` und `/api/hot`
- **Problem:** Änderung muss in beiden Dateien passieren.
- **Lösung:** Config-Endpoint `/api/config` der SAVED_LOCS liefert, oder gemeinsame Config-Datei.

### 12. FILTER_DEFS und VIBES hard-coded im Client
- **Datei:** `index.html` JS-Block (Zeile ~577 und ~920)
- **Was:** Kategorie-Filter (`pub`, `irish`, `cocktail`, `wine`, `club`, `cafe`, `livemusic`) und Event-Vibes (`ai_tech`, `startup`, `business`, `networking`) mit Regex-Patterns
- **Problem:** Neue Kategorien erfordern HTML-Änderung + Deployment.
- **Lösung:** Vom Server laden oder in separate JS-Config-Datei.

### 13. Inline-Styles im HTML (weatherBanner, eventBanner)
- **Datei:** `index.html` Zeile ~158–159
- **Was:** `<div id="weatherBanner" style="display:none;padding:10px 14px;border-radius:12px;...">` — komplette Styles inline
- **Problem:** Inkonsistent mit dem Rest (der CSS-Klassen nutzt). Schwer wartbar.
- **Lösung:** CSS-Klassen `.weather-banner`, `.event-banner` anlegen.

### 14. Category-Maps 4x dupliziert
- **Datei:** `index.html` JS: `getCatIcon()`, `getCatName()`, Vibe-Recommendation `catMap`, Server: `buildOverpassQuery.amenities`
- **Was:** Kategorie → Icon/Name Mapping existiert 3-4x mit leichten Unterschieden
- **Problem:** Neue Kategorie muss an 4 Stellen eingefügt werden.
- **Lösung:** Einmal definieren (z.B. `CATEGORIES` Objekt), überall referenzieren.

### 15. Weather-URL mit hard-coded Koordinaten
- **Datei:** `server.js` Zeile 47
- **Was:** `latitude=53.55&longitude=10.0` — Hamburg-Zentrum fix im Weather-API-Call
- **Problem:** Funktioniert nur für Hamburg. Wenn User GPS in Lentföhrden nutzt, zeigt das Wetter für Hamburg-Mitte.
- **Lösung:** Weather-Endpoint parametrisieren oder pro SAVED_LOC cachen.

### 16. Google Scrape User-Agents
- **Datei:** `server.js` Zeile 8–10
- **Was:** 2 User-Agent Strings mit Chrome 120/121
- **Problem:** Veralten schnell → Google blockiert.
- **Lösung:** In Config auslagern, regelmäßig aktualisieren, oder Rotation aus größerer Liste.

### 17. PORT hard-coded
- **Datei:** `server.js` Zeile 6
- **Was:** `const PORT = 3002;`
- **Problem:** Bei Port-Konflikten muss Code geändert werden.
- **Lösung:** `const PORT = process.env.PORT || 3002;`

---

## 🟢 NIEDRIGE PRIORITÄT

### 18. Overpass API Hostname hard-coded
- **Datei:** `server.js` Zeile ~865
- **Was:** `hostname: 'overpass-api.de'`
- **Problem:** Wenn Overpass down ist, kein Fallback.
- **Lösung:** Config mit Fallback-Servern: `['overpass-api.de', 'overpass.kumi.systems']`

### 19. Leaflet CDN-Version hard-coded
- **Datei:** `index.html` Zeile 11–12
- **Was:** `leaflet@1.9.4`
- **Problem:** Keine automatischen Security-Updates.
- **Lösung:** NPM-Package oder mindestens SRI-Hash + Update-Prozess.

### 20. Google Fonts Dependency
- **Datei:** `index.html` Zeile 9–10
- **Was:** `https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900`
- **Problem:** GDPR-relevant (IP wird an Google gesendet), Performance-Impact.
- **Lösung:** Font lokal hosten (self-hosted Inter).

### 21. CartoDBn Tile-Server hard-coded
- **Datei:** `index.html` JS (Map init)
- **Was:** `https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png`
- **Problem:** Kein Fallback wenn CartoDB down.
- **Lösung:** In Config, mit Fallback auf OSM-Tiles.

### 22. `fs.readFileSync` beim Server-Start (blocking)
- **Datei:** `server.js` Zeile 135–200
- **Was:** ~15 synchrone File-Reads beim Start
- **Problem:** Bei vielen/großen Cache-Dateien blockiert der Start. OK für jetzt, aber nicht skalierbar.
- **Lösung:** `Promise.all` mit `fs.promises.readFile` für paralleles Laden.

### 23. `require('fs')` innerhalb von Request-Handler
- **Datei:** `server.js` Zeile ~555 und Sources-Handler
- **Was:** `require('fs')` wird innerhalb von Funktionen erneut aufgerufen (obwohl schon top-level importiert)
- **Problem:** Unnötig, verwirrend (require cached zwar, aber es sieht nach Bug aus).
- **Lösung:** Top-level Import nutzen.

### 24. Keine Error-Boundary im Client
- **Datei:** `index.html` diverse `fetch`-Aufrufe
- **Was:** `api()` hat try/catch, returned aber `null` ohne User-Feedback
- **Problem:** Wenn Server offline → stille Fehler, leere UI.
- **Lösung:** Globaler Error-Handler, User-Toast bei Netzwerk-Fehlern.

### 25. localStorage Key hard-coded
- **Datei:** `index.html` JS
- **Was:** `'barfinder_favorites'`
- **Problem:** Minor — aber bei mehreren Instanzen könnten Keys kollidieren.
- **Lösung:** Prefix mit Version: `'barfinder_v1_favorites'`

### 26. Toter Code: getDayFactors, getCategoryAdjustment, getDescriptionBonus, getScoreLabel
- **Datei:** `server.js` Zeile ~1540–1680
- **Was:** Die "alten" Versionen der Funktionen die durch "Improved/Enhanced" ersetzt wurden
- **Problem:** Toter Code, verwirrend.
- **Lösung:** Löschen.

### 27. computeWeeklyHeatmap nutzt hard-coded Score-Werte statt die echten Algorithmen
- **Datei:** `server.js` Zeile ~1690
- **Was:** Vereinfachte Heatmap-Berechnung mit eigenen Magic Numbers statt die tatsächlichen Score-Funktionen zu nutzen
- **Problem:** Heatmap weicht von den echten Scores ab.
- **Lösung:** Die echten Scoring-Funktionen für jeden Stunden-Slot aufrufen.

---

## 📊 Zusammenfassung

| Priorität | Anzahl | Aufwand |
|-----------|--------|---------|
| 🔴 Hoch  | 7      | ~2-3 Tage |
| 🟡 Mittel | 10    | ~1-2 Tage |
| 🟢 Niedrig | 10   | ~1 Tag |

**Top 3 Quick Wins:**
1. **HIGHLIGHTS → JSON auslagern** (größter Impact, ~1h)
2. **Duplikate löschen** (Fehlerquelle beseitigen, ~30min)
3. **`PORT = process.env.PORT || 3002`** (1 Zeile, Best Practice)

**Top 3 Architektur-Verbesserungen:**
1. Config-Datei für alle Koordinaten, Pfade, Magic Numbers
2. Cache-Manager-Klasse für die 15+ Cache-Dateien
3. Event-Merge als wiederverwendbare Funktion
