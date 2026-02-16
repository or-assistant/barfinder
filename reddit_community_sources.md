# Reddit & Community Event Sources for Barfinder Hamburg

**Datum:** 2026-02-15  
**Status:** Recherche abgeschlossen

---

## 🔴 Reddit JSON API – BLOCKED from Servers

**Ergebnis:** Reddit blockiert seit 2023 alle Requests von Cloud/Server-IPs mit 403.  
Betrifft: `www.reddit.com`, `old.reddit.com`, alle `.json` Endpoints.

### Relevante Subreddits (wenn Zugang besteht)

| Subreddit | Mitglieder | Event-Relevanz | Beschreibung |
|-----------|-----------|----------------|--------------|
| **r/hamburg** | ~120k | ⭐⭐⭐ | Hauptsub, regelmäßig Event-Posts, Meetup-Anfragen, Stammtisch |
| **r/de** | ~700k | ⭐ | Selten Hamburg-spezifisch, aber große Reichweite |
| **r/germany** | ~500k | ⭐ | Expat-Community, englischsprachig |
| **r/hamburgfood** | ~5k | ⭐⭐ | Bar/Restaurant Reviews, manchmal Events |

### Workarounds für Reddit-Zugang
1. **Lokaler Scraper** – Script von Heim-PC/Laptop ausführen (residential IP)
2. **Reddit RSS** – `reddit.com/r/hamburg/search.rss?q=event` (auch geblockt)
3. **Pushshift/Arctic** – Historische Reddit-Daten (limited access seit 2023)
4. **Google Cache** – `site:reddit.com/r/hamburg event` über Google suchen
5. **Reddit API mit Auth** – Kostenlos mit App-Registrierung (erfordert Account)

### Scraper erstellt: `scrape_reddit_events.js`
- Sucht r/hamburg, r/germany, r/de, r/hamburgfood
- Queries: after-work, networking, meetup, wine tasting, bar events, startup
- Filtert irrelevante Themen (Konzerte, DJ, Brettspiele, Pub Quiz, Theater)
- Speichert in `reddit_events_cache.json`
- **Funktioniert nur von residential IPs** oder mit Auth-Token

---

## ✅ Alternative Community-Quellen (funktionieren)

### 1. ⭐⭐⭐ Meetup.com
- **URL:** `meetup.com/find/?location=Hamburg&source=EVENTS`
- **API:** Kein freier API-Zugang mehr (GraphQL, Auth required)
- **Scraping:** HTML funktioniert, aber JS-gerendert → braucht Browser
- **Relevante Gruppen:**
  - Hamburg Startup Drinks
  - Hamburg Founders Meetup
  - Hamburg After Work / Social Events
  - Hamburg Wine & Dine
  - Hamburg Business Network
- **Empfehlung:** Browser-basierter Scraper oder manuell kuratieren

### 2. ⭐⭐⭐ Eventbrite
- **URL:** `eventbrite.de/d/germany--hamburg/networking/`
- **Status:** Blockiert (Human Verification / 405)
- **Bereits vorhanden:** `scrape_eventbrite.js` existiert im Projekt
- **Empfehlung:** Browser-Scraper verwenden

### 3. ⭐⭐ Hamburg Startups (hamburg-startups.net)
- **Typ:** Blog/News mit Event-Kalender
- **Fokus:** Startup Events, Founder Meetups, Pitch Events
- **Scraping:** HTML-basiert, sollte funktionieren

### 4. ⭐⭐ Startup City Hamburg (startupcity.hamburg)
- **Typ:** Offizielles Startup-Portal der Stadt
- **Fokus:** Networking Events, Gründer-Events, Workshops
- **Empfehlung:** Event-Kalender prüfen

### 5. ⭐⭐ betahaus Hamburg
- **URL:** hamburg.betahaus.de
- **Typ:** Coworking Space mit öffentlichen Events
- **Fokus:** Networking, After-Work, Founder Events

### 6. ⭐⭐ Hamburg Kreativ Gesellschaft
- **URL:** kreativgesellschaft.org
- **Typ:** Offizielle Kreativwirtschaftsförderung
- **Fokus:** Networking Events, Branchentreffpunkte

### 7. ⭐ Xing Events / Xing Groups
- **URL:** xing.com (Login required)
- **Typ:** Business-Networking Platform
- **Fokus:** After-Work, Business Networking Hamburg
- **Limitation:** Login-Wall, nicht scrapbar

### 8. ⭐ LinkedIn Events
- **URL:** linkedin.com/events (Login required)
- **Typ:** Professional Events
- **Limitation:** Login-Wall

### 9. ⭐ Telegram/WhatsApp Gruppen
- Existieren für Hamburg Expats, Nightlife, Events
- Nicht automatisiert scrapbar
- Mögliche Quellen:
  - "Hamburg Events" Telegram Channel
  - "Hamburg Expats" Groups
  - "Hamburg Founders" WhatsApp

### 10. ⭐ Facebook Groups (bereits geprüft)
- **Status:** Login-Wall, kaum scrapbar
- **Bereits vorhanden:** `scrape_facebook_events.js` existiert
- Relevante Gruppen: "Hamburg Events", "Hamburg Nightlife"

---

## 📊 Zusammenfassung

| Quelle | Zugang | Automatisierbar | Priorität |
|--------|--------|-----------------|-----------|
| Reddit r/hamburg | ❌ Server blocked | ⚠️ Nur lokal/Auth | Mittel |
| Meetup.com | ⚠️ JS-required | ⚠️ Browser nötig | Hoch |
| Eventbrite | ❌ Captcha | ⚠️ Browser nötig | Mittel |
| Hamburg Startups | ✅ HTML | ✅ Ja | Hoch |
| Startup City HH | ✅ HTML | ✅ Ja | Mittel |
| betahaus | ✅ HTML | ✅ Ja | Mittel |
| Xing/LinkedIn | ❌ Login | ❌ Nein | Niedrig |
| Telegram/WhatsApp | ⚠️ Manuell | ❌ Nein | Niedrig |

### Empfehlung nächste Schritte
1. **hamburg-startups.net** scrapen (HTML, kein Auth) → neuer Scraper
2. **Reddit Auth Token** besorgen (kostenlos, braucht nur Reddit Account + App)
3. **Meetup** über Browser-Automation (Playwright/Puppeteer) scrapen
4. **scrape_reddit_events.js** lokal testen (von Heim-PC)
