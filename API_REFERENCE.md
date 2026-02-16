# Barfinder Hamburg — API-Referenz

> **Base URL:** `http://localhost:3002` | **Stand:** 2026-02-16

Alle Endpoints liefern JSON. Kein Auth erforderlich. CORS ist aktiviert (`Access-Control-Allow-Origin: *`).

---

## Inhaltsverzeichnis

- [GET /api/places](#get-apiplaces)
- [GET /api/hot](#get-apihot)
- [GET /api/hotscore](#get-apihotscore)
- [GET /api/highlights](#get-apihighlights)
- [GET /api/events](#get-apievents)
- [GET /api/network-events](#get-apinetwork-events)
- [GET /api/discovery](#get-apidiscovery)
- [GET /api/weather](#get-apiweather)
- [GET /api/sources](#get-apisources)
- [GET /api/config](#get-apiconfig)
- [GET /api/refresh-place](#get-apirefresh-place)
- [GET /api/debug-categories](#get-apidebug-categories)
- [POST /api/feedback](#post-apifeedback)
- [GET /api/place/:id/history](#get-apiplaceidhistory)
- [GET /api/stats](#get-apistats)
- [GET /api/health](#get-apihealth)

---

## GET /api/places

Hauptendpoint — liefert alle Bars/Locations im Umkreis mit berechneten Scores.

### Parameter

| Name | Typ | Default | Beschreibung |
|------|-----|---------|-------------|
| `lat` | float | 53.5775 | Breitengrad |
| `lon` | float | 9.9785 | Längengrad |
| `radius` | int | 1000 | Suchradius in Metern |
| `category` | string | `all` | Filter: `all`, `bar`, `pub`, `cafe`, `cocktailbar`, `nightclub`, `wine`, `biergarten`, `irish-pub` |

### Response

```json
{
  "count": 142,
  "total": 180,
  "places": [
    {
      "id": 12345,
      "name": "Aalhaus",
      "lat": 53.5645,
      "lon": 9.9571,
      "category": "pub",
      "address": "Bahrenfelder Str. 155",
      "opening_hours": "Mo-Sa 18:00-02:00; Su 18:00-01:00",
      "website": "https://aalhaus.de",
      "smoker": true,
      "_dist": 1234.5,
      "isOpen": true,
      "openStatus": {
        "status": "open",
        "label": "Offen",
        "emoji": "🟢"
      },
      "hotScore": 72,
      "vibeScore": 65,
      "vibeLabel": "Gute Chancen",
      "vibeEmoji": "😎",
      "has_events": true,
      "googleRating": 4.3,
      "googleReviews": 245,
      "ratingSource": "google",
      "estimatedBusyness": 58,
      "busynessLabel": "Mäßig",
      "busynessColor": "#FFD60A",
      "peakInfo": {
        "peakFrom": 19,
        "peakTo": 0,
        "peakLabel": "19–00 Uhr",
        "peakDays": "Fr–Sa beste Zeit"
      }
    }
  ]
}
```

### Verhalten

- Overpass API wird für OSM-Daten abgefragt (cached 1h)
- Highlights aus `highlights.json` überschreiben Overpass-Duplikate
- Alle Highlights im Radius werden immer inkludiert
- Overpass-Ergebnisse auf 150 limitiert (nach VibeScore sortiert)
- Bei Overpass-Fehler: nur Highlights
- HTTP 429 bei Rate Limit

---

## GET /api/hot

Top 10 heißeste Locations.

### Parameter

| Name | Typ | Default | Beschreibung |
|------|-----|---------|-------------|
| `lat` | float | 53.5775 | Breitengrad |
| `lon` | float | 9.9785 | Längengrad |
| `radius` | int | 1000 | Suchradius in Metern |

### Response

Array von max. 10 Places (gleiches Schema wie `/api/places`), sortiert nach HotScore.

---

## GET /api/hotscore

Detaillierter HotScore für einen einzelnen Highlight-Place.

### Parameter

| Name | Typ | Pflicht | Beschreibung |
|------|-----|---------|-------------|
| `name` | string | ✅ | Exakter Name eines Highlights |

### Response

```json
{
  "score": 72,
  "label": "Gut besucht",
  "color": "warm",
  "has_events": true,
  "event_count": 1,
  "factors": { "estimated_popularity": 24, "event_boost": 25, "..." : "..." },
  "heatmap": [[0,0,5,10,...], ...],
  "days": ["Mo","Di","Mi","Do","Fr","Sa","So"],
  "peak": {
    "today": { "day": "Fr", "dow": 5, "open": 20, "close": 25, "label": "20:00 – 01:00" },
    "weekly": [...],
    "todayHeatmap": [{ "hour": 16, "intensity": 0 }, ...]
  }
}
```

### Fehler

- HTTP 404 wenn Name nicht in Highlights gefunden

---

## GET /api/highlights

Alle curated Highlights mit aktuellen Scores.

### Response

```json
{
  "count": 336,
  "highlights": [
    {
      "name": "Aalhaus",
      "lat": 53.5645,
      "lon": 9.9571,
      "category": "pub",
      "isOpen": true,
      "openStatus": { "status": "open", "label": "Offen", "emoji": "🟢" },
      "hotScore": 72,
      "vibeScore": 65,
      "vibeLabel": "Gute Chancen",
      "vibeEmoji": "😎"
    }
  ]
}
```

---

## GET /api/events

Statische Events (wiederkehrend) aus `events_config.json`.

### Response

```json
{
  "today": [
    {
      "title": "Wine Tasting Abend",
      "location": "Ufer Weinbar",
      "date": "Fr",
      "time": "19:00",
      "description": "...",
      "category": "tasting",
      "lat": 53.55,
      "lon": 9.98,
      "address": "..."
    }
  ],
  "all": [...]
}
```

---

## GET /api/network-events

Aggregierte Networking/Social/Startup Events aus allen Quellen.

### Response

```json
{
  "events": [
    {
      "id": "luma_Hamburg_AI_Meetup",
      "title": "Hamburg AI Meetup",
      "category": "networking",
      "type": "tech",
      "date": "2026-02-18",
      "time": "19:00",
      "location": "Google Campus Hamburg",
      "description": "...",
      "quality": "high",
      "source": "luma",
      "url": "https://lu.ma/...",
      "tags": ["tech", "AI"],
      "eventCategory": "networking",
      "eventQuality": 85,
      "isOpenAccess": true
    }
  ]
}
```

### Event-Enrichment

Jedes Event wird automatisch angereichert:
- `eventCategory`: networking, startup, social, workshop, conference, culture, community, other
- `eventQuality`: 0–100 Score
- `isOpenAccess`: Boolean

### Filter-Logik (serverseitig)

Ausgeschlossen werden: Konzerte, Kinder-Events, Sport, Frauen-spezifische Events, Online-only, Vereinsversammlungen, Theater, etc.

---

## GET /api/discovery

3 zufällige Empfehlungen (nicht-Favoriten, täglich frisch).

### Parameter

| Name | Typ | Default | Beschreibung |
|------|-----|---------|-------------|
| `favorites` | string | `""` | Komma-separierte Favoriten-Namen (lowercase) |

### Response

```json
{
  "date": "2026-02-16",
  "discoveries": [
    {
      "name": "Weinbar XY",
      "category": "wine",
      "isOpen": true,
      "vibeScore": 45,
      "vibeLabel": "Etwas los",
      "vibeEmoji": "👀",
      "googleRating": 4.2,
      "googleReviews": 89,
      "estimatedBusyness": 40,
      "busynessLabel": "Mäßig",
      "busynessColor": "#FFD60A"
    }
  ]
}
```

### Algorithmus

1. Alle Highlights minus Favoriten
2. Gewichtung nach Google Rating (4.5+ = ×4)
3. Seeded PRNG → reproduzierbar pro Request-Zeitpunkt
4. Kategorie-Diversität bevorzugt

---

## GET /api/weather

Aktuelles Wetter + aktive Großevents.

### Response

```json
{
  "weather": {
    "temperature": 12.5,
    "weathercode": 3,
    "windspeed": 15.2,
    "winddirection": 240,
    "time": "2026-02-16T20:00"
  },
  "weatherText": "Bewölkt, 12.5°C",
  "weatherEmoji": "☁️",
  "majorEvents": [
    { "name": "Hamburger DOM", "boost": 1.2 }
  ],
  "fetchedAt": 1739692800000
}
```

---

## GET /api/sources

Status aller Datenquellen und Scraper.

### Response

```json
{
  "sources": [
    {
      "name": "OpenStreetMap (Overpass)",
      "icon": "🗺️",
      "description": "Bars, Pubs, Restaurants, Cafés — Live-Abfrage pro Request",
      "priority": 1,
      "status": "ok",
      "statusText": "Live",
      "count": "~800+",
      "lastRun": "2026-02-16T08:00:00.000Z",
      "error": null
    }
  ],
  "lastCron": "2026-02-16T04:00:00.000Z",
  "cronSchedule": "Täglich 06:00 CET"
}
```

### Status-Werte

- `ok`: Funktioniert, Cache aktuell
- `partial`: Teilweise funktionsfähig
- `pending`: Geplant / In Entwicklung
- `error`: Fehler / Kein Cache

---

## GET /api/config

Client-Konfiguration.

### Response

```json
{
  "SAVED_LOCS": {
    "home": { "lat": 53.5775, "lon": 9.9785, "label": "Zuhause", "radius": 1000 },
    "parents": { "lat": 53.8760, "lon": 9.8864, "label": "Lentföhrden", "radius": 20000 },
    "ostsee": { "lat": 54.5078, "lon": 9.9704, "label": "Ostseecamp Lehmberg", "radius": 15000 }
  },
  "DEFAULT_LAT": 53.5775,
  "DEFAULT_LON": 9.9785
}
```

---

## GET /api/refresh-place

Live Google Rating Scrape für einen einzelnen Place.

### Parameter

| Name | Typ | Pflicht | Beschreibung |
|------|-----|---------|-------------|
| `name` | string | ✅ | Name des Places |

### Response

```json
{
  "ok": true,
  "name": "Aalhaus",
  "rating": {
    "name": "Aalhaus",
    "rating": 4.3,
    "rating_n": 245
  }
}
```

### Verhalten

- Scrapt live von Google Maps (hidden search endpoint)
- Updated In-Memory Cache + persistiert auf Disk
- Timeout: 15s
- ⚠️ Kein Rate Limiting — sollte sparsam verwendet werden

---

## GET /api/debug-categories

Debug: Kategorie-Verteilung der Highlights im Radius.

### Parameter

| Name | Typ | Default |
|------|-----|---------|
| `lat` | float | 53.5775 |
| `lon` | float | 9.9785 |
| `radius` | int | 3000 |

### Response

```json
{
  "totalHighlights": 336,
  "inRadius": 142,
  "categories": { "pub": 45, "bar": 38, "cocktailbar": 22, "..." : "..." },
  "radius": 3000
}
```

---

## POST /api/feedback

User-Feedback zu einem Place speichern.

### Request Body

```json
{
  "placeId": 42,
  "type": "thumbs_up",
  "comment": "Tolle Atmosphäre!",
  "context": { "from": "detail_sheet" }
}
```

### Feedback Types

| Type | Effekt |
|------|--------|
| `thumbs_up` | +1 positive feedback |
| `favorite` | +1 positive feedback |
| `visited` | +1 positive feedback |
| `thumbs_down` | +1 negative feedback |
| `dismissed` | +1 negative feedback |

### Response

```json
{ "ok": true }
```

---

## GET /api/place/:id/history

Rating-Verlauf und Feedback für einen Place.

### URL-Parameter

- `:id` — Place ID (Integer)

### Response

```json
{
  "placeId": 42,
  "ratings": [
    {
      "id": 1,
      "place_id": 42,
      "source": "google",
      "rating": 4.3,
      "review_count": 245,
      "checked_at": "2026-02-10T04:00:00.000Z"
    }
  ],
  "feedback": [
    {
      "id": 5,
      "place_id": 42,
      "feedback_type": "thumbs_up",
      "comment": "Super!",
      "created_at": "2026-02-15T21:30:00.000Z"
    }
  ],
  "vibeBonus": 2.5
}
```

---

## GET /api/stats

Datenbank-Statistiken und letzte Scraper-Läufe.

### Response

```json
{
  "places": 336,
  "events": 89,
  "feedback": 12,
  "recentScrapes": [
    {
      "id": 1,
      "scraper": "bar_events",
      "status": "success",
      "items_found": 15,
      "items_new": 3,
      "items_updated": 12,
      "duration_ms": 4500,
      "error_message": null,
      "run_at": "2026-02-16T03:00:00.000Z"
    }
  ]
}
```

---

## GET /api/health

Schneller Health-Check.

### Response

```json
{
  "places": 336,
  "highlights": 336,
  "events": 89,
  "ratings": 1024,
  "feedback": 12,
  "lastScrape": {
    "scraper": "nightly",
    "status": "success",
    "run_at": "2026-02-16T03:00:00.000Z"
  }
}
```

---

## Statische Routen

| Pfad | Response |
|------|----------|
| `/` | `index.html` |
| `/index.html` | `index.html` |
| `/v*` | `index.html` (Catch-all für Client-Side Routing) |
| Alles andere | HTTP 404 `Not found` |

### Cache-Header

- HTML: `Cache-Control: no-cache, no-store, must-revalidate`
- API: `Cache-Control: no-cache`
- CORS: `Access-Control-Allow-Origin: *`

---

*Generiert am 2026-02-16 aus server.js Quellcode-Analyse.*
