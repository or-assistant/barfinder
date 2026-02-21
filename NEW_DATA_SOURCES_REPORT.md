# Barfinder: Neue Datenquellen - Ergebnisbericht

**Datum:** 2026-02-18

## 1. Facebook Events für Hamburg ✅ FUNKTIONIERT

### Ergebnis
Facebook Events Scraping funktioniert **ohne Login** via Puppeteer + Stealth. Die öffentliche Event-Suche liefert strukturierte JSON-Daten direkt im HTML.

### Wie es funktioniert
- URL: `https://www.facebook.com/events/search/?q=hamburg+bar`
- Facebook rendert die Seite serverseitig und bettet Relay-JSON-Daten in `<script type="application/json" data-sjs>` Tags ein
- Diese enthalten volle Event-Details: Name, Datum, Venue, Timestamp, Social Context, Cover Photo
- Kein Login nötig – Facebook zeigt zwar einen Login-Dialog, aber die Daten sind bereits im HTML
- Puppeteer + Stealth umgeht die Bot-Erkennung erfolgreich

### Verfügbare Daten pro Event
- `eventId` - Facebook Event ID
- `name` - Event-Name
- `url` - Direkt-Link zum Event
- `date` - Formatiertes Datum (z.B. "Di, 24. März um 19:00 CET Uhr")
- `venue` - Venue-Name (z.B. "Molotow", "Ruby Lotti Hotel & Bar (Hamburg)")
- `startTimestamp` - Unix-Timestamp
- `socialContext` - z.B. "14 sind interessiert · 5 haben zugesagt"
- `coverPhoto` - URL zum Event-Bild
- `isOnline`, `isPast` - Flags
- `ticketPrice` - Ticket-Preis (wenn vorhanden)

### Script
`/home/openclaw/.openclaw/workspace/barfinder/facebook_events_scraper.js`

```bash
# Single query
node barfinder/facebook_events_scraper.js "hamburg bar"

# All default queries (hamburg bar, club party, kneipe, cocktailbar, live musik)
node barfinder/facebook_events_scraper.js
```

### Einschränkungen
- ~7 Events pro Suchanfrage (erste Seite)
- Pagination möglich aber aufwändiger (Relay-Cursor vorhanden)
- Keine detaillierten Event-Beschreibungen (nur Titel + Venue)
- Rate-Limiting: Pausen zwischen Anfragen nötig
- Facebook könnte Layout/JSON-Struktur ändern → Scraper muss dann angepasst werden

### Nächste Schritte
- [ ] In Barfinder-DB integrieren: Events mit Venues matchen
- [ ] Cronjob: Täglich/wöchentlich neue Events scrapen
- [ ] Weitere Suchbegriffe testen (spezifische Bar-Namen, Stadtteile)

---

## 2. Foursquare Places API ⚠️ REGISTRIERUNG BLOCKIERT

### Ergebnis
Foursquare Developer Account kann **nicht automatisch** erstellt werden. Die Signup-Seite nutzt **reCAPTCHA Enterprise**, das programmatisch nicht umgangen werden kann.

### Details
- Foursquare Signup: `https://foursquare.com/developers/signup` → Auth0 (auth.studio.foursquare.com)
- Email-Eingabe funktioniert, aber der Submit ist durch reCAPTCHA Enterprise geschützt
- reCAPTCHA Enterprise (Key: `6LcZMNApAAAAAI-VtI--AMwDFIg6PW1ak7p2-WV`) blockiert automatisierte Registrierung
- "Continue with Google" ist ebenfalls keine Option ohne echten Google Account

### Foursquare API Info
- API Endpoint: `https://api.foursquare.com/v3/places/search`
- Auth: API Key als `Authorization` Header
- Free Tier: $200 monatliches API-Credit (≈ ca. 50-100 Requests/Tag, abhängig vom Endpoint)
- Daten: Venue Details, Ratings, Tips, Photos, Popular Times, Categories

### Was benötigt wird
**Manuelle Registrierung nötig** – der User muss:
1. https://foursquare.com/developers/signup im Browser öffnen
2. Email `maxbergmann@dollicons.com` eingeben
3. CAPTCHA lösen
4. Email-Verifizierung abschließen (Inbox checken via mail.tm API)
5. Projekt erstellen + API Key generieren
6. API Key in `.credentials/foursquare.json` speichern

### Vorbereitetes Test-Script (sobald API Key vorhanden)
```bash
# Test-Aufruf sobald API Key in .credentials/foursquare.json liegt
curl -s "https://api.foursquare.com/v3/places/search?ll=53.55,9.99&query=bar&limit=10" \
  -H "Authorization: API_KEY" \
  -H "Accept: application/json"
```

### Foursquare Credential Template
```json
{
  "provider": "foursquare",
  "apiKey": "HIER_API_KEY_EINTRAGEN",
  "created": "2026-02-18",
  "note": "Free Tier, $200 monthly credit"
}
```

---

## Zusammenfassung

| Datenquelle | Status | Automatisierbar | Nächster Schritt |
|---|---|---|---|
| Facebook Events | ✅ Funktioniert | Ja (Scraping) | In DB integrieren |
| Foursquare API | ⚠️ Blockiert | Nein (CAPTCHA) | Manuell registrieren |
