# Barfinder Hamburg — Projektdokumentation

> **Version:** 1.0 | **Stand:** 2026-02-16 | **Autor:** Auto-generiert aus Quellcode-Analyse

---

## Inhaltsverzeichnis

1. [Projektübersicht](#1-projektübersicht)
2. [Architektur](#2-architektur)
3. [Backend (server.js)](#3-backend-serverjs)
4. [Frontend (index.html)](#4-frontend-indexhtml)
5. [Datenmodell](#5-datenmodell)
6. [Daten-Pipeline](#6-daten-pipeline)
7. [Konfiguration](#7-konfiguration)
8. [Deployment](#8-deployment)
9. [Qualitätssicherung](#9-qualitätssicherung)
10. [Bekannte Einschränkungen](#10-bekannte-einschränkungen)
11. [Architektur-Review](#11-architektur-review)

---

## 1. Projektübersicht

### Was ist der Barfinder?

Der Barfinder ist eine **Single-Page Web-App**, die Bars, Kneipen, Clubs und Locations in Hamburg (und Umgebung) auf einer interaktiven Karte zeigt und mit Echtzeit-Scores bewertet. Der Fokus liegt auf der Frage: **„Wo triffst du JETZT Leute?"**

### Zielgruppe

- Primär: Einzelperson in Hamburg, die spontan ausgehen möchte
- Sekundär: Networking-Interessierte (Startup, Tech, Business Events)
- Tertiär: Besucher in ländlichen Gebieten (Lentföhrden, Bad Bramstedt)

### Vision

Ein persönlicher Bar-Berater, der:
- Weiß, welche Bars gerade voll/leer sind (geschätzt)
- Events und Networking-Möglichkeiten aggregiert
- Wetter, Großevents und Tageszeit einbezieht
- Aus User-Feedback lernt (Favoriten, Thumbs up/down)
- Curated Highlights mit OpenStreetMap-Daten kombiniert

### Kern-Features

| Feature | Beschreibung |
|---------|-------------|
| **VibeScore** | 0–100: Wahrscheinlichkeit, Leute zu treffen |
| **HotScore** | 0–100: Allgemeine Beliebtheit/Belebtheit |
| **Busyness** | 0–100: Geschätzte aktuelle Auslastung |
| **Discovery** | Zufällige Empfehlungen (nicht-Favoriten) |
| **Nearby** | GPS-basiert, max 1 km Umkreis |
| **Events** | Aggregierte Networking/Social Events |
| **Wetter-Integration** | Open-Meteo Wetterdaten beeinflussen Scores |
| **Großevent-Boost** | Hafengeburtstag, OMR etc. boosten Stadt-Score |

---

## 2. Architektur

### Systemarchitektur

```
┌─────────────────────────────────────────────────────────────┐
│                        CLIENT (Browser)                      │
│  ┌───────────────────────────────────────────────────────┐  │
│  │              index.html (Single-File SPA)              │  │
│  │  ┌─────────┐ ┌──────────┐ ┌───────┐ ┌────────────┐  │  │
│  │  │  Heute   │ │  Karte   │ │Events │ │  Quellen   │  │  │
│  │  │  Feed    │ │ (Leaflet)│ │ Feed  │ │  Status    │  │  │
│  │  └─────────┘ └──────────┘ └───────┘ └────────────┘  │  │
│  │  localStorage: Favoriten                              │  │
│  └───────────────────────────────────────────────────────┘  │
└────────────────────────────┬────────────────────────────────┘
                             │ HTTP (Port 3002)
                             │ Cloudflare Tunnel
┌────────────────────────────┴────────────────────────────────┐
│                    NODE.JS SERVER (server.js)                 │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  HTTP Server (node:http)                              │   │
│  │                                                       │   │
│  │  ┌──────────┐  ┌───────────┐  ┌──────────────────┐  │   │
│  │  │ Overpass  │  │  Score    │  │  Cache Manager   │  │   │
│  │  │ Client   │  │  Engine   │  │  (JSON Files)    │  │   │
│  │  └────┬─────┘  └─────┬─────┘  └────────┬─────────┘  │   │
│  │       │              │                   │            │   │
│  │  ┌────┴─────┐  ┌─────┴─────┐  ┌────────┴─────────┐  │   │
│  │  │OpenStreet│  │ HotScore  │  │ 18+ JSON Caches  │  │   │
│  │  │Map API   │  │ VibeScore │  │ (Scraper Output) │  │   │
│  │  └──────────┘  │ Busyness  │  └──────────────────┘  │   │
│  │                │ Weather   │                          │   │
│  │                │ Events    │                          │   │
│  │                └───────────┘                          │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  SQLite Database (barfinder.db via better-sqlite3)    │   │
│  │  places | events | feedback | rating_history |        │   │
│  │  scrape_runs | learned_prefs                          │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  highlights.json (336 curated locations)               │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                             │
              ┌──────────────┴──────────────┐
              │     CRON / SCRAPER LAYER     │
              │                              │
              │  nightly_update.sh (04:00)   │
              │  daily_scraper_cron.sh (06:00)│
              │  weekly_quality_check.sh     │
              │                              │
              │  20+ Node.js Scraper         │
              │  → JSON Cache Files          │
              └──────────────────────────────┘
                             │
         ┌───────────────────┼───────────────────┐
         │                   │                   │
    ┌────┴────┐      ┌──────┴──────┐     ┌──────┴──────┐
    │Overpass │      │ Google Maps │     │ Event Sites │
    │  API    │      │ (Scraping)  │     │ (Luma, EB,  │
    │  (OSM)  │      │ Yelp, OT   │     │  Meetup...) │
    └─────────┘      └─────────────┘     └─────────────┘
```

### Technologie-Stack

| Komponente | Technologie |
|-----------|-------------|
| **Runtime** | Node.js v22 |
| **Server** | `node:http` (kein Express) |
| **Database** | SQLite via `better-sqlite3` |
| **Frontend** | Vanilla JS, CSS, HTML (Single File) |
| **Karte** | Leaflet.js + CartoDB Dark Tiles |
| **Schriften** | Google Fonts (Inter) |
| **Scraping** | `cheerio`, `jsdom`, `playwright-core` |
| **Geo-Daten** | Overpass API (OpenStreetMap) |
| **Wetter** | Open-Meteo API |
| **Deployment** | Cloudflare Tunnel, systemd |

### Datenfluss

```
1. Scraper (Cron)     → JSON Cache Files
2. Server-Start       → Lädt alle JSON Caches in Memory
3. Client Request     → Server berechnet Scores on-the-fly
4. Overpass API       → Live OSM-Daten + Cache (1h TTL)
5. highlights.json    → Override: Curated > Overpass
6. Feedback (POST)    → SQLite → beeinflusst VibeScore
```

---

## 3. Backend (server.js)

### 3.1 API-Endpoints

Siehe [API_REFERENCE.md](API_REFERENCE.md) für die vollständige Referenz.

### 3.2 Score-Algorithmen

#### HotScore (0–100)

Misst die allgemeine Beliebtheit/Belebtheit eines Ortes.

**Komponenten:**

| Faktor | Max. Punkte | Gewicht |
|--------|------------|---------|
| Geschätzte Popularität (Kategorie × Zeit) | 60 | 40% |
| Event-Boost (Typ-spezifisch) | 40 | variabel |
| Tages-Score (Kategorie × Wochentag) | 38 | variabel |
| Highlight-Bonus | 12 | fix |
| Kategorie-Zeit-Adjustment | ±18 | variabel |
| Beschreibungs-Keywords | 18 | variabel |
| Random-Faktor (Name-Hash) | ±5 | Rauschen |

**Event-Type-Boosts:**

| Event-Typ | Boost |
|-----------|-------|
| Football (Bundesliga etc.) | 35 |
| Live-Musik | 30 |
| Quiz | 25 |
| DJ | 22 |
| Party/Karaoke | 20 |
| Happy Hour | 18 |
| After Work | 15 |

#### VibeScore (0–100)

Misst die **Wahrscheinlichkeit, auf Leute zu treffen** — absolut, nicht relativ.

**Bedeutung der Werte:**
- 80–100: Volle Bar, Freitagabend, jeder redet
- 50–70: Gute Abendgesellschaft, leicht ins Gespräch zu kommen
- 30–50: Einige Leute, möglich aber nicht garantiert
- 10–30: Ruhig, meist Paare/Einzelne
- 0–10: Leer oder geschlossen

**Berechnungsschritte:**

1. **Soziale Kategorie-Basis** (0–20): Irish Pub 20, Biergarten 20, Pub 18, Weinbar 18, Cocktailbar 16, Bar 16, Nightclub 15, Café 5
2. **Zeit-Block** (0–45): Prime Time (20–24h) = 45, Late Night = 35, Early Evening = 30, Afternoon = 8, Morning = 2
3. **Event-Boost** (0–10): Events heute = +5 bis +10
4. **Beschreibungs-Keywords** (0–12): Live-Musik +4, After Work +5, Stammtisch +4, etc.
5. **Highlight-Bonus**: +3
6. **Smoker-Bonus**: +6 (Stammkneipe-Effekt)
7. **Google/Yelp Rating**: 4.5+ = +10, Review-Count-Bonus bis +6
8. **Busyness-Boost**: >60% = +4
9. **Wetter-Faktor**: Multiplikator (Regen → Indoor +10%, Outdoor -30%)
10. **Gelernter Vibe-Bonus**: Aus User-Feedback in DB (±10)
11. **Globale Tag/Zeit-Dämpfung**: Matrix aus Wochentag × Zeitblock
    - Fr/Sa Prime Time: ×1.0
    - Mo Prime Time: ×0.45
    - Di Morgens: ×0.25

#### Busyness (0–100)

Geschätzte Auslastung basierend auf:

1. **Kategorie-Peak-Kurven**: Jede Kategorie hat definierte Peak-Stunden
   - Cocktailbar: Peak 22–01h (70%)
   - Pub: Peak 20–23h (60%)
   - Café: Peak 10–12h + 15–17h (50%)
   - Biergarten: Peak 17–21h (55%)
2. **Wochentag-Multiplikator**: Fr/Sa ×1.3, Mi/Do ×1.0, So–Di ×0.75
3. **Google Rating Boost**: 4.5+ → ×1.10
4. **Event-Boost**: ×1.20
5. **Smoker-Bonus**: ×1.05
6. **Biergarten Winter-Check**: Okt–März → ×0.3
7. **Wetter-Faktor**: Dynamisch via Open-Meteo
8. **Großevent-Boost**: z.B. Hafengeburtstag ×1.5

#### isOpenSmart

Intelligente Öffnungszeiten-Prüfung:
- Parst OSM-Format (`Mo-Fr 18:00-02:00; Sa 20:00-04:00`)
- Unterstützt Mitternachts-Crossing
- **Fallback bei fehlenden Daten**: Schätzt basierend auf Kategorie
  - Café: 08:00–19:00
  - Bar/Pub: Mo–Do 18–01, Fr–Sa 18–03, So 18–00

#### Discovery-Algorithmus

Generiert 3 zufällige Empfehlungen pro Request:
1. Filtert Favoriten raus
2. Gewichtet nach Google Rating (4.5+ = ×4)
3. Seeded PRNG (Mulberry32) mit Timestamp
4. Kategorie-Vielfalt: Versucht verschiedene Kategorien
5. Enrichment mit aktuellen Scores

### 3.3 Caching-Strategie

| Cache | TTL | Beschreibung |
|-------|-----|-------------|
| Overpass API | 1h (3.600.000ms) | Pro lat/lon/radius/category Key |
| Wetter | 30 min | Open-Meteo Forecast |
| JSON Caches | Bis Scraper-Lauf | 18+ Files, beim Start geladen |
| Google Ratings (Live) | Per Request | Einzelabfrage bei Favorit-Add |

**Rate Limiting:** Overpass-Requests min. 30s Abstand.

### 3.4 Datenquellen (In-Memory beim Start)

| Quelle | Variable | Fallback |
|--------|----------|----------|
| `highlights.json` | `HIGHLIGHTS` | — (Pflicht) |
| `google_ratings_cache.json` | `googleRatingsCache` | `populartimes_cache.json` → `google_popular_times_cache.json` |
| `yelp_cache.json` | `yelpCache` | — |
| `yelp_reviews_cache.json` | `yelpReviewsCache` | — |
| `events_cache.json` | `eventsCache` | — |
| `events_pipeline_cache.json` | `pipelineEventsCache` | — |
| `eventbrite_events_cache.json` | `eventbriteEventsCache` | — |
| `new_sources_events_cache.json` | `newSourcesEventsCache` | — |
| `mitvergnuegen_cache.json` | `mitvergnuegenCache` | — |
| `hamburgwork_events_cache.json` | `hamburgworkEventsCache` | — |
| `rural_events_cache.json` | `ruralEventsCache` | — |
| `afterwork_events_cache.json` | `afterworkEventsCache` | — |
| `opentable_cache.json` | `opentableCache` | — |
| `hamburg_events_cache.json` | `hamburgEventsCache` | — (disabled) |
| `network_events_cache.json` | (in `getNetworkEvents()`) | — |
| `popular_times_cache.json` | `popularTimesData` | — |
| `realtime_cache.json` | `realTimeData` | — |

### 3.5 Wetter-Integration

- **API**: Open-Meteo (kostenlos, kein API-Key)
- **Refresh**: Alle 30 Minuten
- **Einfluss auf Scores**:
  - Starker Regen (Code ≥61): Outdoor ×0.5, Indoor ×1.1
  - Niesel (51–60): Outdoor ×0.7, Indoor ×1.1
  - Sonnig + Warm (>20°C): Outdoor ×1.2, Indoor ×0.95
  - Frost (<0°C): Alle ×0.8

### 3.6 Großevent-System

Konfiguriert in `events_config.json`. Bei aktiven Events:
- **Hafengeburtstag**: ×1.5
- **OMR Festival**: ×1.4
- **Reeperbahn Festival**: ×1.4
- **Hamburger DOM**: ×1.2
- **Silvester**: ×1.5
- **Ländliche Events** (Osterfeuer, Stoppelfeeten): ×1.3–1.4

### 3.7 Fuzzy Name Matching

`fuzzyMatchRating(placeName)` sucht in 4 Quellen:
1. Google Ratings Cache
2. Yelp Cache (Legacy)
3. Yelp Reviews Cache (smry.ai)
4. OpenTable Cache

Normalisiert: lowercase, nur alphanumerisch, Substring-Match in beide Richtungen.

---

## 4. Frontend (index.html)

### 4.1 Übersicht

**Single-File SPA** (~1.655 Zeilen HTML/CSS/JS). Kein Build-Schritt, kein Framework.

### 4.2 Tabs / Views

| Tab | ID | Beschreibung |
|-----|-----|-------------|
| **Heute** | `feedHeute` | Hauptfeed: Favoriten, Hero-Cards, Quick-Filter, Tonight-Feed |
| **Karte** | `mapTab` | Leaflet-Karte mit Markern, Search, Chips, Bottom Sheet |
| **Events** | `feedEvents` | Netzwerk & Social Events mit Kategorie- und Zeitfiltern |
| **Quellen** | `feedSources` | Daten-Pipeline Status aller Scraper |

### 4.3 UI-Komponenten

#### Header & Greeting
- Dynamisch je Tageszeit: Morgens, Nachmittags, Abends, Nacht
- Wetter-Integration im Greeting-Text

#### Location Toggle
- **Zuhause** (Default): Eimsbüttel, 3 km
- **GPS-Standort**: Auto-Radius (urban 3km, rural 20km)
- **Lentföhrden**: 20 km Radius
- **Ostsee**: 15 km Radius

#### Radius Slider
- Range: 1–25 km
- Löst `loadAll()` bei Änderung aus

#### Favoriten (localStorage)
- Horizontal scrollbare Cards
- ❤️ Toggle in jeder Card
- Automatischer Google-Rating-Refresh beim Hinzufügen
- Persistiert in `barfinder_favorites` (Array von lowercase Namen)

#### Hero Section ("Hier triffst du Leute")
- Top 5 nach VibeScore
- Horizontal scrollbare Cards mit Glow-Animation bei hohem Vibe
- Zeigt nur offene / heute öffnende Bars

#### Quick Filter (Multi-Select)
- 🍺 Kneipen, 🍀 Irish Pub, 🍸 Cocktails, 🍷 Wein, 🪩 Afterwork, 🌿 Biergarten, ☕ Café, 🎵 Live-Musik, 🔥 Beliebtheit
- Client-seitige Filterung, kein neuer API-Call

#### Day Picker
- 7 Tage (Heute bis +6)
- Ändert die Tonight-Feed-Anzeige (welche Bars an dem Tag öffnen)

#### Vibe / Discovery / Nearby Buttons
- **Vibe**: Overlay mit Top-3 Empfehlungen, Route-Links
- **Discovery**: 3 zufällige Nicht-Favoriten via `/api/discovery`
- **Nearby**: GPS + `/api/places?radius=1000`, sortiert nach Entfernung

#### Sort Bar
- Vibe (Default), Entfernung, Bewertung, Hot
- Beeinflusst Tonight-Feed-Sortierung

#### Tonight Feed
- Hauptliste aller Bars
- Tags: Offen/Zu, Schließt bald, Öffnet bald, Raucher, Live-Musik, Event
- Quick-Links: Maps Route, Google Maps, Website
- Adaptive Logik: Spät nachts → "Tote Hose"-Meldung, Filter leer → Reload-Hint

#### Detail Sheet
- Bottom Sheet mit Score-Ringen (HotScore + VibeScore)
- Öffnungszeiten, Peak Hours Heatmap, Wochenübersicht
- Action-Buttons: Route, Maps, Web/Google
- Favorit-Toggle

#### Events Tab
- Zeitfilter: Alle, Heute, Morgen, Diese Woche, Später
- Vibe-Filter: 🤖 AI & Tech, 🚀 Startups, 💼 Business, 🤝 Networking
- Gruppiert nach Kategorie, dann nach Datum
- Quality-Score-Badge (0–100%)
- Open Access Badge (🔓)

#### Quellen Tab
- Zeigt alle Datenquellen mit Status (✅/⚠️/❌)
- Anzahl Einträge, Letzte Aktualisierung, Priorität

#### Methodik Section
- Aufklappbare Erklärung der Score-Berechnung
- Datenquellen-Tags

### 4.4 State Management

Globaler State in `S`-Objekt:
```javascript
const S = {
  lat, lon,         // Aktuelle Position
  radius,           // Suchradius in Metern
  category,         // Aktiver Kategoriefilter (Karte)
  places: [],       // Geladene Places
  hot: [],          // Hot-Locations
  markers: [],      // Leaflet-Marker
  currentLoc,       // 'home' | 'gps' | 'parents' | 'ostsee'
  filter: ''        // Suchfilter
};
```

Weitere State-Variablen:
- `currentTab`, `selectedDay`, `currentSort`
- `activeFilters` (Set), `activeVibes` (Set), `activeEventTime`
- `_weatherData`, `_discoveryData`

### 4.5 Auto-Refresh

- Initial: `loadAll()` sofort + GPS im Hintergrund
- GPS-Korrektur: Wenn >200m vom Default → automatischer Reload
- Background: Alle 15 Minuten (`setInterval`, nur wenn Tab sichtbar)

---

## 5. Datenmodell

### 5.1 highlights.json (336 Einträge)

Curated Locations, höchste Priorität:

```json
{
  "name": "Aalhaus",
  "lat": 53.5645,
  "lon": 9.9571,
  "address": "Bahrenfelder Str. 155",
  "category": "pub",
  "description": "Kultige Eppendorfer Kneipe — Raucher-Bar mit Kicker...",
  "opening_hours": "Mo-Sa 18:00-02:00; Su 18:00-01:00",
  "smoker": true,
  "tags": ["kneipe", "raucher", "kicker", "eppendorf"],
  "source": "osm+manual",
  "created_at": "2025-...",
  "last_verified": "2025-..."
}
```

### 5.2 SQLite-Tabellen

#### `places`
| Spalte | Typ | Beschreibung |
|--------|-----|-------------|
| id | INTEGER PK | Auto-Increment |
| name | TEXT NOT NULL | Name des Ortes |
| slug | TEXT UNIQUE | Normalisiert (für Dedup) |
| lat, lon | REAL NOT NULL | Koordinaten |
| category | TEXT | pub, bar, cocktailbar, wine, etc. |
| subcategory | TEXT | Weitere Klassifikation |
| address | TEXT | Straße + Hausnummer |
| opening_hours | TEXT | OSM-Format |
| opening_hours_estimated | BOOLEAN | Geschätzt? |
| phone, website | TEXT | Kontakt |
| description | TEXT | Freitext-Beschreibung |
| tags | TEXT (JSON) | Array von Tags |
| smoker | BOOLEAN | Raucher erlaubt |
| highlight | BOOLEAN | Curated? |
| source | TEXT | 'manual', 'osm', 'osm+manual' |
| google_rating, google_reviews | REAL/INT | Google-Bewertung |
| yelp_rating, yelp_reviews | REAL/INT | Yelp-Bewertung |
| vibe_base_score | REAL | Basis-Vibe |
| times_recommended | INTEGER | Empfehlungs-Counter |
| times_positive/negative_feedback | INTEGER | Feedback-Counter |
| last_verified | DATETIME | Letzte Prüfung |
| last_rating_check | DATETIME | Letzter Rating-Check |
| created_at, updated_at | DATETIME | Timestamps |

**Unique Constraint**: `(name, lat, lon)` + `slug` (UNIQUE)

#### `events`
| Spalte | Typ | Beschreibung |
|--------|-----|-------------|
| id | INTEGER PK | Auto-Increment |
| title | TEXT NOT NULL | Event-Titel |
| place_id | INTEGER FK | Referenz auf places |
| location_name | TEXT | Ort (Freitext) |
| lat, lon | REAL | Koordinaten |
| date | TEXT | ISO-Datum |
| time, end_time | TEXT | Uhrzeit |
| description | TEXT | Beschreibung |
| category | TEXT | quiz, live_music, etc. |
| price | TEXT | Preis |
| url | TEXT | Link |
| source | TEXT NOT NULL | Datenquelle |
| source_id | TEXT | ID in Quelle |
| event_quality | INTEGER | Qualitäts-Score 0–100 |
| is_recurring | BOOLEAN | Wiederkehrend? |
| tags | TEXT (JSON) | Tags |

**Unique Constraint**: `(title, date, source)`

#### `rating_history`
Zeitreihe von Bewertungen pro Place.

#### `feedback`
User-Feedback mit Typen: `thumbs_up`, `thumbs_down`, `favorite`, `visited`, `dismissed`.
Beeinflusst Vibe-Score mit exponentiellem Decay (Halbwertszeit 90 Tage).

#### `scrape_runs`
Log aller Scraper-Läufe mit Status, Counts, Dauer, Fehlermeldungen.

#### `learned_prefs`
Key-Value-Store für gelernte Präferenzen mit Confidence-Wert.

### 5.3 Overpass-Datenformat

Places von OSM:
```json
{
  "id": 12345678,
  "name": "Bar XY",
  "lat": 53.55,
  "lon": 9.99,
  "category": "bar",
  "address": "Straße 1",
  "opening_hours": "Mo-Fr 18:00-02:00",
  "website": "https://...",
  "outdoor_seating": true,
  "wheelchair": "yes",
  "smoker": false
}
```

---

## 6. Daten-Pipeline

### 6.1 Scraper-Übersicht

| Scraper | Datei | Quelle | Methode | Output |
|---------|-------|--------|---------|--------|
| Bar Events | `scrape_bar_events.js` | Bar-Websites (Aalhaus etc.) | HTTPS fetch + HTML Parse | `bar_events_cache.json` |
| Hamburg Events | `scrape_hamburg_events.js` | szene-hamburg.de, hamburg.de | cheerio HTML | `hamburg_events_cache.json` |
| Hamburg Sources | `scrape_hamburg_sources.js` | Meetup, Prinz.de | cheerio | `hamburg_new_events_cache.json` |
| Events Pipeline | `scrape_events_pipeline.js` | Google News RSS, Abendblatt, Tourism, Meetup | RSS + HTML | `events_pipeline_cache.json` |
| Eventbrite | `scrape_eventbrite.js` | eventbrite.de | Playwright | `eventbrite_events_cache.json` |
| Ecosystem Events | `scrape_ecosystem_events.js` | nextMedia, ARIC, Kreativ Gesellschaft | JSDOM | `ecosystem_events_cache.json` |
| New Sources | `scrape_new_sources.js` | startupcity.hamburg, MOPO, Handelskammer | cheerio | `new_sources_events_cache.json` |
| Mit Vergnügen | `scrape_mitvergnuegen.js` | hamburg.mitvergnuegen.com | Playwright | `mitvergnuegen_cache.json` |
| Hamburg@Work | `scrape_hamburgwork.js` | hamburg-startups.net | RSS + cheerio | `hamburgwork_events_cache.json` |
| Rural Events | `scrape_rural_events.js` | lentfoehrden.de, Wolters Gasthof | cheerio + fetch | `rural_events_cache.json` |
| Afterwork | `scrape_afterwork_events.js` | Diverse via smry.ai Proxy | HTTPS + smry.ai | `afterwork_events_cache.json` |
| Google Ratings | `scrape_ratings_batch.js` | Google Maps (hidden endpoint) | HTTPS Scraping | `google_ratings_cache.json` |
| Google Popular Times | `scrape_google_popular_times.js` | Google Maps | Playwright | `google_popular_times_cache.json` |
| Yelp | `scrape_yelp.js` | yelp.de | Playwright | `yelp_cache.json` |
| Yelp Reviews | `scrape_yelp_reviews.js` | yelp.de via smry.ai | Playwright | `yelp_reviews_cache.json` |
| OpenTable | `scrape_opentable.js` | opentable.de | Playwright | `opentable_cache.json` |
| Facebook Events | `scrape_facebook_events.js` | Facebook Pages | Playwright (Mobile) | `facebook_events_cache.json` |
| Reddit Events | `scrape_reddit_events.js` | r/hamburg | JSON API | `reddit_events_cache.json` |
| Popular Times | `scrape_populartimes.js` | Google Maps (hidden endpoint) | HTTPS | `populartimes_cache.json` |
| Data Enrichment | `enrich_data.js` | Nominatim (Reverse Geocode) | HTTPS | `highlights.json` (Update) |

### 6.2 Cron-Zeitpläne

| Job | Zeitplan | Datei |
|-----|---------|-------|
| **Nightly Update** | Täglich 04:00 CET | `nightly_update.sh` |
| **Daily Scraper** | Täglich 06:00 CET | `daily_scraper_cron.sh` |
| **Weekly Quality** | Wöchentlich | `weekly_quality_check.sh` |
| **Google Ratings** | Nur Sonntags (im Nightly) | `scrape_ratings_batch.js` |

#### Nightly Update Flow:
1. Alle Scraper sequentiell ausführen (je 5 Min Timeout)
2. Google Ratings nur Sonntags
3. Server Restart (`systemctl restart barfinder-server`)
4. Tests ausführen (`test_barfinder.js`)
5. Location-Plausibilitätscheck (`validate_locations.js`)
6. Data Enrichment (`enrich_data.js`)
7. Quality Check (`quality_check.js`)
8. DB Re-Sync (`migrate_to_db.js`)
9. Log-Rotation (max 50 Logs)

### 6.3 Event-Enrichment im Server

`getNetworkEvents()` merged alle Event-Caches und:
1. Klassifiziert Kategorien (networking, startup, social, workshop, conference, culture, community)
2. Berechnet Quality-Score (0–100) basierend auf:
   - Open-Access-Keywords (+30)
   - Networking-Keywords (+25)
   - Source-Bonus (startupcity +10, meetup +10, mopo -10)
   - Negative Signale (online -20, webinar -25, teuer -15)
3. Filtert aggressiv: Online-Events, Kinder-Events, Sport, Frauen-Events, Vereinsversammlungen etc.
4. Lentföhrden-Gemeindeverwaltung explizit ausgeschlossen

---

## 7. Konfiguration

### 7.1 barfinder_config.json

| Key | Beschreibung | Default |
|-----|-------------|---------|
| `DEFAULT_LAT/LON` | Fallback-Koordinaten | 53.5775, 9.9785 (Eimsbüttel) |
| `PORT` | Server-Port | 3002 |
| `SAVED_LOCS` | Gespeicherte Orte mit Radius | home, parents, ostsee |
| `CACHE_FILES` | Pfade zu allen Cache-Dateien | 18+ Einträge |
| `SCORE_WEIGHTS` | Alle Score-Gewichtungen | Siehe unten |
| `USER_AGENTS` | Rotation für Scraping | 2 Chrome UAs |
| `OVERPASS_HOSTS` | Overpass API Hosts | overpass-api.de, overpass.kumi.systems |
| `CACHE_TTL` | Overpass Cache TTL | 3.600.000ms (1h) |
| `MIN_REQUEST_INTERVAL` | Overpass Rate Limit | 30.000ms |
| `GOOGLE_SCRAPE_TIMEOUT` | Google Scrape Timeout | 15.000ms |
| `WEATHER_REFRESH_INTERVAL` | Wetter-Refresh | 1.800.000ms (30min) |
| `WEATHER_LAT/LON` | Wetter-Position | 53.55, 10.0 |

#### Score Weights Detail:

- `estimated_popularity_weight`: 0.4
- `max_event_boost`: 40
- `highlight_bonus`: 12
- `max_description_bonus`: 18
- `random_range`: 11
- `event_type_boosts`: Siehe Event-Type-Tabelle oben
- `vibe_social_base`: Kategorie → Basis-Vibe (4–20)
- `vibe_day_multiplier`: So=0.4, Mo=0.5, ..., Fr/Sa=1.0
- `vibe_time_base`: prime=45, after_work=30, late_night=35, etc.
- `busyness_peak_curves`: Peak-Stunden und -Werte pro Kategorie
- `rating_vibe_bonus`: Rating → Bonus-Mapping

### 7.2 events_config.json

- `major_events`: Hamburger Großevents mit Datum, Boost-Faktor, optional Region
- `static_events`: Wiederkehrende Events (Wine Tasting, After Work etc.)
- `network_static_events`: Statische Networking-Events als Fallback

---

## 8. Deployment

### 8.1 Server

```bash
npm start  # → node server.js
```

- Läuft als `barfinder-server` systemd Service
- Port: 3002
- Kein Cluster, kein PM2 — einfacher Single-Process

### 8.2 Cloudflare Tunnel

Externer Zugriff über Cloudflare Tunnel (kein offener Port nötig).

### 8.3 Prozess-Management

- Nightly Update startet Server via `systemctl restart barfinder-server`
- PID-File Lock verhindert parallele Scraper-Läufe
- Scraper-Timeout: 300s pro Scraper (via `timeout` Command)

### 8.4 Verzeichnisstruktur

```
barfinder/
├── server.js              # Haupt-Server (2.034 Zeilen)
├── index.html             # Frontend SPA (1.655 Zeilen)
├── db.js                  # SQLite-Modul
├── barfinder_config.json  # Hauptkonfiguration
├── events_config.json     # Events & Großevents
├── highlights.json        # 336 curated Locations
├── package.json           # Dependencies
├── barfinder.db           # SQLite Database
├── cache.json             # Overpass Cache
│
├── scrape_*.js            # 18 Scraper
├── enrich_data.js         # Daten-Anreicherung
│
├── nightly_update.sh      # Nightly Cron
├── daily_scraper_cron.sh  # Daily Cron
├── weekly_quality_check.sh# Weekly QA
│
├── *_cache.json           # 18+ Cache-Dateien
└── logs/                  # Scraper-Logs
```

---

## 9. Qualitätssicherung

### 9.1 Koordinaten-Validierung

- `validate_locations.js` prüft alle Highlights auf plausible Koordinaten
- Ergebnis in `location_issues.json`
- TOOLS.md Regel: **NEVER guess coordinates** — immer via Nominatim/OSM verifizieren

### 9.2 Duplikat-Erkennung

- `slugify()` in db.js: Normalisiert Namen (Umlaute, Sonderzeichen)
- `UNIQUE(slug)` Constraint in DB
- `UNIQUE(name, lat, lon)` als sekundärer Constraint
- Im Server: `fuzzyMatchRating()` mit Substring-Match

### 9.3 Datenqualitäts-Regeln

1. **Highlights Override**: Curated Daten haben Vorrang vor Overpass
2. **Overpass-Filter**: Nur Places MIT Namen werden behalten
3. **Event-Filter**: Aggressives Regex-Filtering gegen irrelevante Events
4. **Rating-Fallback**: Google → Yelp → Yelp Reviews → OpenTable
5. **Nightly Tests**: `test_barfinder.js`, `test_data_quality.js`
6. **Weekly Smoke Tests**: Scraper Dry-Runs + Server Health Check

### 9.4 Event-Qualitäts-Score

Jedes Event erhält automatisch einen Quality-Score (0–100):
- **Positive Signale**: Open Access (+30), Networking (+25), Startup/Business (+15)
- **Negative Signale**: Online-only (-20), Webinar (-25), Teuer >50€ (-15)
- **Source-Bonus/Malus**: startupcity +10, meetup +10, mopo -10

---

## 10. Bekannte Einschränkungen

### 10.1 Daten

- **Keine Real-Time-Daten**: Busyness und VibeScore sind **geschätzt**, nicht gemessen
- **Popular Times**: Google Popular Times Scraper oft geblockt
- **Facebook Events**: Login-Wall blockiert öffentlichen Zugang
- **Reddit**: Blockt Server/Cloud IPs
- **Yelp**: Nur via smry.ai Proxy möglich
- **Öffnungszeiten**: Viele Bars haben keine in OSM → Fallback-Schätzung
- **Hamburg-zentrisch**: Scoring-Algorithmen optimiert für Hamburg

### 10.2 Architektur

- **Single-File Frontend**: 1.655 Zeilen in einer HTML-Datei
- **Kein Build-System**: Kein Bundling, Minification, Tree-Shaking
- **Kein Auth**: Komplett öffentliche API
- **Kein Rate Limiting**: Außer Overpass (30s Minimum)
- **Memory-basierte Caches**: Alle JSON-Dateien beim Start geladen
- **Single Process**: Kein Clustering, kein Worker
- **Kein HTTPS**: Nur via Cloudflare Tunnel
- **Hybrid-Datenmodell**: SQLite + JSON Files parallel

### 10.3 UX

- **Kein Offline-Support**: Keine Service Worker, kein PWA-Manifest
- **Kein User-Account**: Favoriten nur lokal im Browser
- **Keine Push-Notifications**: Kein Alerting bei Events
- **Bilder fehlen**: Keine Fotos der Bars

---

## 11. Architektur-Review

### 11.1 Stärken

1. **Zero-Dependency Frontend**: Kein React/Vue-Overhead, schneller Initial-Load
2. **Clever Scoring**: Mehrdimensionale Bewertung (Vibe + Hot + Busyness + Wetter + Events)
3. **Curated + Automated**: Highlights als Quality-Backbone, OSM für Breite
4. **Resilient**: Server läuft auch wenn alle Caches fehlen
5. **Einfaches Deployment**: Ein Prozess, ein Port, Cloudflare Tunnel

### 11.2 Schwächen & Verbesserungsvorschläge

#### Frontend aufsplitten?

**Problem**: 1.655 Zeilen HTML/CSS/JS in einer Datei → schwer wartbar.

**Empfehlung**: Ja, aber vorsichtig:
- CSS in separate `style.css`
- JS Module: `state.js`, `api.js`, `render.js`, `map.js`, `events.js`
- Einfaches Build-Script (esbuild) für Bundling
- **Kein** komplettes Framework (React etc.) — der Vanilla-Ansatz ist ein Feature

#### Datenbank vs JSON?

**Problem**: Hybrides System — SQLite existiert, aber der Server nutzt primär JSON-Caches.

**Empfehlung**: Migration zu DB-First:
- Scraper schreiben in SQLite (tun sie teilweise schon via `db.js`)
- Server liest aus SQLite statt JSON
- JSON-Caches als Import-Zwischenformat (Scraper → JSON → DB Migration)
- Highlights in DB migrieren

#### Caching verbessern

**Problem**: Alle Caches im Memory, kein invalidation mechanism.

**Empfehlung**:
- Redis oder SQLite als Cache-Layer
- Cache-Header für Client (ETags, Last-Modified)
- Hot-Reload: Scraper-Finish → Server-Reload der betroffenen Caches (ohne Restart)

#### Rate Limiting

**Problem**: API komplett ungeschützt.

**Empfehlung**:
- Token-Bucket Rate Limiter (einfach in Node.js)
- Overpass-Proxy-Endpoint braucht striktes Limiting
- Google Scrape Endpoint (`/api/refresh-place`) besonders schützen

#### Auth

**Problem**: Keine Authentifizierung.

**Empfehlung**: Für Personal-Use-Projekt akzeptabel. Bei Public Launch:
- API-Key für Schreib-Endpoints (Feedback)
- Optional: Simple Basic Auth für Admin-Endpoints (Stats, Health)

#### Weitere Verbesserungen

| Bereich | Vorschlag |
|---------|-----------|
| **Testing** | Automatische Integration-Tests für alle Endpoints |
| **Monitoring** | Health-Check Endpoint → Uptime-Monitoring |
| **SSE/WebSocket** | Live-Updates statt 15-Min-Polling |
| **PWA** | Service Worker + Manifest für Offline + Install |
| **Bilder** | Google Places Photos API oder Unsplash Integration |
| **i18n** | Englische Version für Expats/Touristen |
| **Analytics** | Anonyme Usage-Statistiken (welche Bars werden angeschaut) |
| **Scraper-Orchestrierung** | Queue-basiert statt sequentiell im Bash-Script |
| **Error Reporting** | Sentry oder ähnlich für Scraper- und Server-Fehler |

### 11.3 Gesamtbewertung

Der Barfinder ist ein **beeindruckend funktionsfähiger Prototyp** mit durchdachtem Scoring-System und breiter Datenabdeckung. Die Hauptrisiken liegen in der **Wartbarkeit** (Single-File Frontend, hybrides Datenmodell) und **Skalierbarkeit** (Single Process, Memory Caches). Für den aktuellen Einsatz als Personal Tool ist die Architektur angemessen. Für einen Public Launch wären die oben genannten Verbesserungen nötig.

---

*Generiert am 2026-02-16 aus Quellcode-Analyse. Diese Dokumentation dient als Basis für Refactoring, Lastenheft-Erstellung oder Neuaufbau.*
