# Barfinder Hamburg — Datenqualitäts-Audit

**Datum:** 2026-03-28
**Auditor:** Automatisiert (Claude)
**Datenstand:** DB 4.353 Einträge, JSON 5.227 Einträge

---

## Zusammenfassung

| Kategorie | Anzahl Issues | Schweregrad |
|-----------|--------------|-------------|
| Sync-Mismatches (DB vs JSON) | 1.374 | KRITISCH |
| Fehlende Pflichtfelder | 113 | HOCH |
| Koordinaten außerhalb Hamburg | 93 | MITTEL |
| Duplikate | 38 | HOCH |
| Falsche Kategorie | 1 | NIEDRIG |
| **Gesamt** | **1.619** | |

**Hauptproblem:** Die JSON-Datei (highlights.json) enthält 874 mehr Einträge als die DB und ist massiv desynchronisiert. 470 Einträge existieren nur in der JSON, 4 nur in der DB. 395 Einträge haben Koordinaten-Abweichungen >1km.

---

## 1. Duplikate

### 1.1 Exakte Namens-Duplikate in DB (3 Gruppen)

| IDs | Name | Adressen | Empfehlung |
|-----|------|----------|------------|
| 14, 1230 | Familien-Eck | Friedensallee 9 / Friedensallee 2-4 | Prüfen ob gleiche Location |
| 16, 7070 | Holsten-Schwemme | Seilerstraße / Herrenweide 2a | Verschiedene Standorte? |
| 141, 376 | Billiard-Café | Henstedt-Ulzburg / Rathausplatz 1, Ulzburg | Beide außerhalb HH, evtl. entfernen |

### 1.2 Exakt gleiche Koordinaten (20 Paare gefunden)

Besonders kritisch — verschiedene Namen am selben Punkt:

| ID A | Name A | ID B | Name B | Koordinaten |
|------|--------|------|--------|-------------|
| 3014 | Brook | 3481 | Restaurant Brook | 53.545, 9.994 |
| 2912 | Cafe Delice | 3492 | Café Délice | 53.579, 9.947 |
| 153 | Café Bar Sonnenseite | 1887 | Sonnenseite | 53.567, 9.965 |
| 99 | Café Gnosa | 2150 | Cafe Gnosa | 53.559, 10.013 |
| 195 | Café Storch | 6866 | Butcher's Steakhouse | 53.571, 9.997 |
| 188 | Eisenstein | 2024 | Pasteleria Cafe Veloso | 53.555, 9.927 |
| 232 | Fabrik | 2072 | Eisfabrik | 53.557, 9.928 |
| 2702 | Glanz&Gloria | 3498 | Glanz & Gloria | 53.549, 9.963 |
| 157 | Goldbeker | 6229 | Der Goldbeker | 53.584, 10.012 |
| 20 | Haifisch Bar | 6024 | Haifischbar | 53.544, 9.946 |
| 196 | Harlin | 2971 | Haerlin | 53.556, 9.992 |
| 93 | Kleines Phi | 1829 | Das kleine Phi | 53.557, 9.972 |
| 1553 | Komet Musik Bar | 2369 | Komet | 53.548, 9.962 |
| 234 | Indra Club 64 | 1618 | INDRA Musikclub | ~53.549, 9.964 |
| 199 | 20up Bar | 2439 | 20up | ~53.544, 9.943 |

**Klare Duplikate zum Zusammenführen:** Brook/Restaurant Brook, Cafe Delice/Café Délice, Café Gnosa/Cafe Gnosa, Glanz&Gloria/Glanz & Gloria, Goldbeker/Der Goldbeker, Haifisch Bar/Haifischbar, Harlin/Haerlin, Kleines Phi/Das kleine Phi, Komet/Komet Musik Bar

**Zu prüfen:** Café Storch vs Butcher's Steakhouse (verschiedene Bars, gleicher Ort?), Eisenstein vs Pasteleria Cafe Veloso

### 1.3 JSON-Duplikate (266 Namens-Gruppen!)

Die highlights.json enthält 266 Fälle, wo derselbe Name mehrfach vorkommt. Beispiele:

- **Bierkrug** x4 (Eppendorfer Weg, Milchstraße, Schmuggelstieg, Geschwister-Scholl-Straße)
- **Borchers** x2 (Eppendorfer Weg vs Geschwister-Scholl-Straße)
- **Berglund** x2 (Barmbeker Straße vs Gertigstraße — verschiedene Adressen!)
- **Witwenball** x2 (Große Bleichen vs Weidenallee)
- **Goldfischglas** x2 (Eppendorfer Weg vs Bartelsstraße)

Viele davon sind Locations die umgezogen sind — alte und neue Adresse koexistieren.

---

## 2. Koordinaten-Validierung

### 2.1 Einträge außerhalb Hamburg Bounding Box

**93 Einträge** liegen außerhalb der Hamburg-Grenzen (lat 53.38–53.75, lon 9.73–10.32).

Betroffene Regionen:

| Region | Anzahl | Beispiel-IDs |
|--------|--------|-------------|
| Wedel | ~25 | 1811, 2858, 7344, 8206–8300 |
| Henstedt-Ulzburg / Quickborn | ~12 | 141, 376, 1566, 8079, 8506–8514 |
| Tornesch / Appen | ~8 | 6432, 8530–8600 |
| Seevetal / Rosengarten (Süden) | ~15 | 8442–8496 |
| Nenndorf | ~5 | 3466, 8460, 8466 |
| Bilsen / Ellerau | ~3 | 8517, 8518 |
| Sonstiges | ~25 | diverse |

**Empfehlung:** Entscheidung treffen ob Umland-Locations gewünscht sind. Falls nur Hamburg: alle 93 entfernen. Falls Metropolregion: Bounding Box auf 53.30–53.80, 9.65–10.35 erweitern.

### 2.2 Nominatim-Stichprobe (30 zufällige Einträge)

**Ergebnis: 26 OK, 4 Mismatches**

| ID | Name | Adresse | DB-Koordinaten | Nominatim-Koordinaten | Distanz | Status |
|----|------|---------|---------------|----------------------|---------|--------|
| 6439 | Tavernaki "i" Akropolis | Am Felde 51 | 53.423, 10.030 | 52.328, 7.236 | **223 km** | MISMATCH — Adresse zu ungenau, Nominatim findet Ort in Niedersachsen |
| 3151 | Cafe Vivet | Neustadt/Innenstadt | 53.552, 10.003 | 54.606, 18.230 | **549 km** | MISMATCH — Adresse "Neustadt/Innenstadt" ist kein geocodierbarer Wert |
| 5944 | Musti | Luruper Hauptstraße, Hamburg | 53.598, 9.861 | 53.590, 9.874 | **1.2 km** | MISMATCH — Straße ohne Hausnummer, Nominatim findet Straßenmitte |
| 2886 | Curcuma | Eimsbüttel | 53.578, 9.943 | 53.573, 9.958 | **1.2 km** | MISMATCH — nur Stadtteil als Adresse |

**Fazit:** Die Mismatches sind durchweg auf ungenaue Adressen zurückzuführen (fehlende Hausnummer, nur Stadtteil). Die 26 OK-Einträge haben durchschnittlich nur 12m Abweichung — die Koordinaten in der DB sind grundsätzlich sehr genau.

---

## 3. DB vs JSON Synchronisation

### 3.1 Mengenvergleich

| Quelle | Einträge |
|--------|----------|
| SQLite DB (places) | 4.353 |
| highlights.json | 5.227 |
| **Differenz** | **+874 in JSON** |

### 3.2 Nur in DB (4 Einträge)

| ID | Name |
|----|------|
| 45 | dripBAR |
| 169 | Haco36 |
| 193 | Café Eppendorfer Baum |
| 8743 | Un Dos Taco |

### 3.3 Nur in JSON (470 Einträge)

Die JSON enthält 470 Locations die nicht in der DB existieren. Kategorien-Verteilung:

| Kategorie | Anzahl |
|-----------|--------|
| mittagstisch | 276 |
| restaurant | 101 |
| cafe | 40 |
| event-location | 18 |
| fruehstueck | 15 |
| pub | 11 |
| bar | 6 |
| wine / cocktailbar / biergarten | 3 |

**Auffällig:** Die Kategorien `mittagstisch`, `event-location`, `fruehstueck` existieren NUR in der JSON, nicht in der DB. Dies deutet auf eine separate Datenquelle hin, die in die JSON aber nicht in die DB importiert wurde.

122 der 470 JSON-only Einträge liegen außerhalb der Hamburg Bounding Box.

### 3.4 Kategorien-Inkonsistenz

| Nur in JSON | Nur in DB |
|-------------|-----------|
| mittagstisch | closed |
| event-location | |
| fruehstueck | |

### 3.5 Feld-Mismatches (bei Einträgen die in beiden Quellen existieren)

| Feld | Anzahl Mismatches |
|------|-------------------|
| Koordinaten (>100m Abweichung) | ~395 |
| Adresse | ~14 |
| Kategorie | ~8 |

**Beispiele für massive Koordinaten-Abweichungen (>1km):**

| ID | Name | DB-Adresse | JSON-Adresse | Distanz |
|----|------|-----------|--------------|---------|
| 15 | Ratsherrn Klause | Schröderstiftstraße, Rotherbaum | Schanzenstraße 36, Sternschanze | ~1.2km |
| 22 | Hatari Pfälzer Stube | Eidelstedter Weg 1 | Hamburger Berg 8, St. Pauli | ~3.4km |
| 57 | Witwenball | Weidenallee 20 | Große Bleichen, Innenstadt | ~2.1km |
| 86 | Goldfischglas | Bartelsstraße 30 | Eppendorfer Weg 178 | ~2.0km |
| 139 | Kamphuis | Quickborn | Kampstraße 57 (HH) | ~19km |

**Ursache:** Die JSON matcht bei Namensgleichheit auf den ersten Eintrag, aber viele Bars haben ihren Standort gewechselt oder es gibt verschiedene Filialen.

---

## 4. Datenqualität

### 4.1 Fehlende Pflichtfelder

| Feld | Fehlend |
|------|---------|
| address | 106 |
| category | 0 |
| name | 0 |
| lat | 0 |
| lon | 0 |

Die 106 Einträge ohne Adresse konzentrieren sich auf Bergedorf (IDs 8354–8413), Seevetal (8442–8504), und weitere Umland-Regionen. Diese stammen vermutlich aus einem Bulk-Import ohne vollständige Daten.

### 4.2 Einträge ohne Tags

**7 Einträge** haben keine Tags:

| ID | Name | Kategorie |
|----|------|-----------|
| 14 | Familien-Eck | pub |
| 16 | Holsten-Schwemme | pub |
| 17 | Hong-Kong Hotel Bar | pub |
| 121 | Galerie-Café Schlossgefängnis | cafe |
| 141 | Billiard-Café | bar |
| 152 | 3-Zimmerwohnung | pub |
| 214 | Köpi-Bar | pub |

### 4.3 Verdächtige Kategorien

- **ID 169: Haco36** hat Kategorie `closed` — dies ist ein Status, keine Kategorie. Sollte die richtige Kategorie erhalten und als geschlossen markiert werden (separates Feld).

### 4.4 Kategorie-Verteilung (DB)

| Kategorie | Anzahl | Anteil |
|-----------|--------|--------|
| restaurant | 2.271 | 52,2% |
| cafe | 990 | 22,7% |
| bar | 468 | 10,8% |
| pub | 430 | 9,9% |
| nightclub | 67 | 1,5% |
| wine | 54 | 1,2% |
| cocktailbar | 32 | 0,7% |
| biergarten | 27 | 0,6% |
| irish-pub | 13 | 0,3% |
| closed | 1 | 0,0% |

**Anmerkung:** Für eine "Barfinder"-App sind 52% Restaurants auffällig hoch. Möglicherweise sollten Restaurants, die keine Bar-Funktion haben, separat markiert werden.

---

## 5. Geschlossene Locations (20 älteste unverified)

### Ergebnis: 19 offen, 1 geschlossen

| ID | Name | Status | Details |
|----|------|--------|---------|
| 1 | Zum Silbersack | Offen | Yelp Jan 2026 aktiv, reguläre Öffnungszeiten |
| 2 | Zum Goldenen Handschuh | Offen | Yelp Feb 2026 aktiv, 22h/Tag geöffnet |
| 3 | Elbschlosskeller | Offen | Website aktiv, nur kurze Renovierung Feb 2026 |
| 4 | Erika's Eck | Offen | Yelp Feb 2026, auf Wolt verfügbar |
| 5 | Zwick Pöseldorf | Offen | Yelp Mär 2026, Website zwick4u.com aktiv |
| 7 | Die Glocke | Offen | Yelp Mär 2026 aktiv |
| 8 | Schramme 10 | Offen | Yelp Mär 2026, Instagram aktiv |
| 9 | Fricke 46 | Offen | Website fricke46.de aktiv |
| 11 | Schröders | Offen | Yelp Dez 2025 aktiv. **Hinweis: DB-Adresse falsch** (Eppendorfer Weg 198 → tatsächlich Hegestraße 1) |
| 12 | Paola's | Offen | Aktiv auf mehreren Portalen. **Hinweis: DB-Adresse ungenau** (Goernestraße 5 → tatsächlich Goernestraße 1a) |
| 13 | Frau Möller | Offen | Website fraumoeller.com, Yelp Mär 2026 |
| 14 | Familien-Eck | Offen | Website familieneck.de, Facebook Dez 2025 |
| 15 | Ratsherrn Klause | Offen | Website aktiv, seit 1957 an Schröderstiftstraße 9 |
| 16 | Holsten-Schwemme | Offen | Listing aktuell Mär 2026. **Hinweis: DB-Adresse falsch** (Seilerstraße → tatsächlich Herrenweide 2a) |
| 17 | Hong-Kong Hotel Bar | Offen | Website aktiv, Yelp Mär 2026, 24/7. **Hinweis: DB-Adresse falsch** (Schmuckstraße 9 → tatsächlich Hamburger Berg) |
| 18 | Old Sailor | Offen | TripAdvisor 2026. **Hinweis: Adresse ist Hein-Hoyer-Str. 4** |
| 19 | Zur Scharfen Ecke | Offen | Website aktiv, seit 1911. **Hinweis: DB hat Davidstraße 1, korrekt ist Davidstraße 3** |
| 20 | Haifisch Bar | Offen | Website haifischbar.hamburg, seit 1947 |
| **21** | **Lehmitz** | **GESCHLOSSEN** | **Dauerhaft geschlossen seit 27.12.2025.** t-online.de: "Kiez-Kneipe Lehmitz auf der Reeperbahn gibt Betrieb auf". Im Oktober 2025 über Social Media angekündigt. |
| 22 | Hatari Pfälzer Stube | Offen | Website aktiv, Yelp Feb 2026 |

### Adress-Korrekturen aus Web-Recherche

| ID | Name | DB-Adresse | Korrekte Adresse |
|----|------|-----------|-----------------|
| 11 | Schröders | Eppendorfer Weg 198 | Hegestraße 1 |
| 12 | Paola's | Goernestraße 5 | Goernestraße 1a |
| 16 | Holsten-Schwemme | Seilerstraße, St. Pauli | Herrenweide 2a |
| 17 | Hong-Kong Hotel Bar | Schmuckstraße 9 | Hamburger Berg |
| 19 | Zur Scharfen Ecke | Davidstraße 1 | Davidstraße 3 |

---

## 6. Empfehlungen (priorisiert)

### KRITISCH — Sofort beheben

1. **DB/JSON-Sync reparieren:** Die highlights.json muss aus der DB generiert werden, nicht separat gepflegt. Ein Sync-Mechanismus fehlt oder ist defekt.
2. **470 JSON-only Einträge in DB importieren** oder aus JSON entfernen
3. **395 Koordinaten-Mismatches auflösen** — für jeden Fall prüfen welche Koordinate korrekt ist

### HOCH — Diese Woche

4. **Duplikate zusammenführen:** Mindestens die 9 klaren Duplikat-Paare (gleicher Ort, verschiedene Schreibweise)
5. **106 fehlende Adressen** per Reverse-Geocoding ergänzen
6. **Kategorie `closed` durch Status-Feld ersetzen** (ID 169)

### MITTEL — Diesen Monat

7. **93 Außerhalb-Hamburg Einträge:** Policy-Entscheidung treffen (Umland ja/nein)
8. **266 JSON-Duplikate** bereinigen
9. **7 Einträge ohne Tags** ergänzen
10. **Neue Kategorien** (`mittagstisch`, `event-location`, `fruehstueck`) in DB-Schema aufnehmen oder mappen

### NIEDRIG — Backlog

11. **`last_verified` Feld** systematisch befüllen
12. **Restaurant-Anteil überprüfen** — passt 52% Restaurants zum "Barfinder"-Konzept?

---

## Anhänge

- `audit_issues_20260328.json` — Alle 1.619 Issues als JSON
- `nominatim_check_20260328.json` — Nominatim-Stichprobe (30 Einträge)
- `closed_check_20260328.json` — Web-Recherche geschlossene Locations

---

*Bericht generiert am 2026-03-28 durch automatisierten Datenqualitäts-Audit*
