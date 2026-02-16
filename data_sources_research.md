# Barfinder Hamburg – Datenquellen-Research

**Datum:** 2026-02-15
**Ziel:** Umfassende Datenbank für Bars, Cocktailbars, Weinbars und Clubs in Hamburg

---

## Zusammenfassung & Empfehlung

| Priorität | Quelle | Datenmenge | Aufwand | Empfehlung |
|-----------|--------|-----------|---------|------------|
| ⭐⭐⭐ | **OpenStreetMap Overpass** | ~859 Einträge | Gering | **PRIMÄRQUELLE** – JSON API, strukturiert, kostenlos |
| ⭐⭐⭐ | **Yelp Hamburg** | ~200+ Bars | Mittel | **TOP-Quelle** – Reviews, Ratings, Preiskategorie |
| ⭐⭐ | **Foursquare Places API** | Hoch | Mittel | Kostenloser Tier verfügbar, gute Kategorien |
| ⭐⭐ | **PRINZ.de Hamburg** | ~100+ Locations | Mittel | Location-DB vorhanden, URL-Struktur unklar |
| ⭐ | **szene-hamburg.com** | Artikel-basiert | Hoch | Nur redaktionelle Inhalte, kein Verzeichnis |
| ⭐ | **hamburg-magazin.de** | Artikel-basiert | Hoch | Nur redaktionelle Inhalte |
| ❌ | **TripAdvisor** | Viel | Sehr hoch | 403 – JS-required, Anti-Scraping |
| ❌ | **hamburg.de** | - | - | Kein Nachtleben-Verzeichnis gefunden (404) |
| ❌ | **golocal.de** | - | - | Bar-Verzeichnis gibt 404 |
| ❌ | **typisch-hamburg.de** | - | - | Domain nicht erreichbar |
| ❌ | **kneipenfinder.de** | - | - | Domain nicht erreichbar |
| ❌ | **barfinder.de** | - | - | Domain nicht erreichbar |
| ❌ | **Instagram Locations** | - | - | Login-Wall, nicht scrapbar |

---

## Detaillierte Analyse

### 1. ⭐⭐⭐ OpenStreetMap Overpass API

**Status:** ✅ Funktioniert perfekt
**URL:** `https://overpass-api.de/api/interpreter`
**Format:** JSON (strukturiert)
**Datenmenge:** **859 Einträge** (bar + nightclub + pub)

**Getestete Query:**
```
[out:json][timeout:30];
area["name"="Hamburg"]["admin_level"="4"]->.a;
(
  nwr["amenity"="bar"](area.a);
  nwr["amenity"="nightclub"](area.a);
  nwr["amenity"="pub"](area.a);
);
out center;
```

**Verfügbare Datenfelder:**
- Name, Adresse (city, street, housenumber, postcode)
- Koordinaten (lat/lon)
- Öffnungszeiten
- Website, Email, Telefon
- Wheelchair-Zugang
- Smoking-Policy
- Kapazität

**Zusätzliche Tags (wenig genutzt):**
- `cuisine~"cocktail"` oder `bar="cocktail"` → nur **2 Treffer** (schlecht getaggt)
- Nightclub-Kategorie ist im `amenity="nightclub"` enthalten

**Bewertung:** Beste Primärquelle. Kostenlos, strukturiert, umfassend. Cocktail/Weinbar-Unterscheidung fehlt meist.

---

### 2. ⭐⭐⭐ Yelp Hamburg

**Status:** ✅ Erreichbar und scrapbar
**URL:** `https://www.yelp.de/search?find_desc=bars&find_loc=Hamburg`
**Format:** HTML (strukturierte Listeneinträge)

**Extrahierbare Daten:**
- Name + Yelp-Slug
- Rating (z.B. 4.6) + Anzahl Reviews
- Preiskategorie (€, €€, €€€)
- Kurze Review-Snippets

**Getestete Kategorien:**
- `bars` → Ergebnisse vorhanden (Le Lion, Boilerman Bar, Chug Club etc.)
- `cocktailbar` → Ergebnisse vorhanden (Tower Bar, Campari Bar etc.)
- `weinbar`, `nightclub` → ebenfalls möglich

**Einschränkungen:**
- Pagination nötig (10 pro Seite)
- Rate-Limiting wahrscheinlich
- Yelp Fusion API als Alternative (kostenloser Tier: 500 calls/day)

**Bewertung:** Exzellente Ergänzung zu OSM. Liefert Qualitätsdaten (Reviews, Ratings) die OSM nicht hat.

---

### 3. ⭐⭐ Foursquare Places API

**Status:** ✅ API verfügbar
**URL:** `https://docs.foursquare.com/developer/reference/places-api-get-started`
**Format:** JSON API

**Kostenloser Tier:**
- Account erforderlich (Sign-Up)
- Places API mit Kategoriefilter (Cocktail Bar, Wine Bar, Nightclub etc.)
- Gute Kategorisierung

**Bewertung:** Gute Ergänzungsquelle, besonders für Kategorisierung. API-Key nötig.

---

### 4. ⭐⭐ PRINZ.de Hamburg

**Status:** ⚠️ Erreichbar, aber URL-Struktur unklar
**URL:** `https://prinz.de/hamburg/`
**Format:** HTML

**Beobachtungen:**
- Hat "Clubs & Bars" und "Essen & Trinken" Kategorien im Menü
- Getestete URLs `/bars-clubs/` und `/locations/clubs-bars/` → 404
- Korrekte URL-Struktur müsste recherchiert werden
- Hat Events + Locations-Datenbank

**Bewertung:** Potenziell gut, braucht URL-Discovery via Sitemap oder Browser-Scraping.

---

### 5. ⭐ szene-hamburg.com

**Status:** ✅ Erreichbar
**URL:** `https://szene-hamburg.com/essen-trinken/`
**Format:** HTML (Blog-Artikel)

**Beobachtungen:**
- Hauptsächlich Newsletter-Plattform ("Heute in Hamburg")
- Readability extrahiert fast nichts (JS-heavy oder wenig Content)
- Artikel über Gastro-Szene, aber kein strukturiertes Verzeichnis
- WhatsApp-Newsletter als Quelle für neue Bars

**Bewertung:** Nicht als Datenquelle, aber nützlich für Trend-Monitoring neuer Bars.

---

### 6. ⭐ hamburg-magazin.de

**Status:** ✅ Erreichbar
**URL:** `https://www.hamburg-magazin.de`
**Format:** HTML (Artikel)

**Beobachtungen:**
- Stadtmagazin mit Top-Themen, Events, Gewinnspiele
- Kein strukturiertes Bar-Verzeichnis erkennbar
- Redaktionelle Inhalte über Hamburger Szene

**Bewertung:** Manuell für Recherche nutzbar, nicht automatisiert scrapbar.

---

### 7. ❌ TripAdvisor

**Status:** 🚫 403 – JavaScript required
**URL:** `https://www.tripadvisor.de/Nightlife-g187331-Hamburg.html`

**Beobachtungen:**
- Erfordert JS-Rendering (Anti-Bot)
- Kein web_fetch möglich
- Würde Headless-Browser (Puppeteer/Playwright) brauchen

**Bewertung:** Zu aufwändig für den Nutzen. Yelp liefert ähnliche Daten.

---

### 8. ❌ hamburg.de

**Status:** 🚫 404 auf allen getesteten Nachtleben-URLs
- `/nachtleben/` → 404
- `/stadtleben/nachtleben/` → 404

**Bewertung:** Kein nutzbares Verzeichnis.

---

### 9. ❌ golocal.de

**Status:** 🚫 404
- `/hamburg/bars/` → 404
- `/hamburg/bar/` → 404

**Bewertung:** Verzeichnis scheint nicht mehr aktiv oder umstrukturiert.

---

### 10. ❌ typisch-hamburg.de

**Status:** 🚫 Nicht erreichbar (fetch failed)

---

### 11. ❌ kneipenfinder.de / barfinder.de

**Status:** 🚫 Beide nicht erreichbar (fetch failed)
**Bewertung:** Domains existieren nicht oder sind offline.

---

### 12. ❌ Instagram Location Pages

**Status:** 🚫 Login-Wall
**Beobachtungen:** Gibt leere Seite ohne Authentifizierung zurück.
**Bewertung:** Nicht nutzbar ohne API-Zugang (Instagram Graph API = Business-Account nötig).

---

## Empfohlene Strategie

### Phase 1: Basis-Datenbank (sofort)
1. **OSM Overpass** → Alle 859 Bars/Pubs/Clubs mit Koordinaten, Adressen, Öffnungszeiten
2. Kategorisierung durch OSM-Tags soweit möglich

### Phase 2: Anreicherung (Woche 1)
3. **Yelp Scraping/API** → Ratings, Reviews, Preiskategorien matchen
4. **Foursquare API** → Kategorisierung (Cocktailbar vs. Weinbar vs. Club)

### Phase 3: Qualitätssicherung
5. **Manuelles Tagging** der Top-100 Bars mit Kategorien
6. **PRINZ.de** → URL-Struktur finden und als Vergleichsquelle nutzen

### Datenmodell-Vorschlag
```json
{
  "name": "Le Lion",
  "type": "cocktail_bar",  // bar | cocktail_bar | wine_bar | pub | nightclub
  "address": { "street": "Rathausstraße 3", "zip": "20095", "city": "Hamburg" },
  "coordinates": { "lat": 53.5511, "lon": 9.9937 },
  "opening_hours": "Di-Sa 18:00-02:00",
  "rating": { "yelp": 4.6, "yelp_reviews": 235 },
  "price_range": "€€€",
  "website": "https://www.lelion.net",
  "phone": "+49 40 ...",
  "source": ["osm", "yelp"],
  "tags": ["craft-cocktails", "speakeasy", "st-georg"]
}
```
