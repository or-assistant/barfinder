# Barfinder Vibe Score: Metrik-Dokumentation

**Version:** 2.0  
**Stand:** 2026-02-21  
**Autor:** CAPS & COLLARS GmbH

---

## Zusammenfassung

Der Vibe Score sagt vorher, wie wahrscheinlich es ist, dass an einem bestimmten Ort zu einer bestimmten Zeit "was los ist". Er kombiniert statische Eigenschaften eines Ortes mit dynamischen Echtzeit-Faktoren zu einem Score von 0 bis 100%.

**Barfinder Vibe Index (BVI):**

```
V(i,t) = ( Bi * Dw * Hc,h + Σβk ) * Sm * Wφ * Oi * Pd
```

Wobei:
- `V(i,t)` = Vibe Score fuer Location i zur Zeit t ∈ [0, 100]
- `Bi` = Base Score der Location ∈ [15, 65], gedeckelt auf 70 nach Multiplikation
- `Dw` = Tag-Faktor fuer Wochentag w ∈ [0.35, 1.0]
- `Hc,h` = Stunden-Kurve fuer Kategorie c zur Stunde h ∈ [0.01, 1.0]
- `Σβk` = Summe aller additiven Boosts (Wetter, Events, Stadtteil, Semester, Tageslicht, Wind)
- `Sm` = Saison-Faktor fuer Monat m ∈ [0.5, 1.1]
- `Wφ` = Wetter-Penalty (proportional) ∈ [0.6, 1.0]
- `Oi` = Offen-Faktor der Location ∈ [0.25, 1.0]
- `Pd` = Payweek-Faktor fuer Tag d im Monat ∈ [0.97, 1.05]

**Dimensionen:** 12 Einzelfaktoren, 8 Stundenkurven, 18 Stadtteile, 10 Grossevents

---

## 1. BaseScore (15 bis 65 Punkte)

Der statische Grundwert eines Ortes. Berechnet aus seinen Eigenschaften, aendert sich nur bei Datenpflege.

| Faktor | Bereich | Beispiel |
|---|---|---|
| Startwert | 25 | Jeder Ort |
| Kategorie-Bonus | 0 bis 18 | Nightclub +18, Bar +12, Cafe +4 |
| Publikum (Crowd) | 0 bis 8 | Kreative +8, Studenten +7, Gemischt +6 |
| Atmosphaere (Vibe) | 0 bis 12 | Wild +12, Lebendig +8, Gemuetlich +4 |
| Preisniveau | 0 bis 3 | Mittel (zwei Euro) +3 |
| Beste Zeit | 0 bis 5 | Late-Night +5, Abends +3 |
| Date-Spot | 0 bis 2 | Ja +2 |
| Specials/Highlights | 0 bis 5 | Besonderheiten vorhanden |
| Outdoor-Seating | 0 bis 2 | Terrasse/Biergarten +2 |

**Deckel:** Max 65, Min 15  
**Gesamtdeckel nach Multiplikatoren:** Max 70

---

## 2. TagFaktor (0.35 bis 1.0)

Wie viel an diesem Wochentag grundsaetzlich los ist.

| Tag | Faktor | Erklaerung |
|---|---|---|
| Montag | 0.35 | Am wenigsten los |
| Dienstag | 0.40 | Leicht mehr |
| Mittwoch | 0.55 | Mitte der Woche, erste Bars fuellen sich |
| Donnerstag | 0.70 | "Kleiner Freitag", viele Afterwork-Events |
| Freitag | 1.00 | Hoechster Wert |
| Samstag | 0.95 | Fast wie Freitag, etwas spaeterer Start |
| Sonntag | 0.40 | Ruhig, aehnlich wie Dienstag |

**Sonderregeln:**
- Feiertag: Minimum 0.90 (wie Samstag, Leute haben frei)
- Brueckentag: Minimum 0.85 (viele nehmen frei)
- Vorabend eines Feiertags: Minimum 0.90 (morgen frei = laenger feiern)

---

## 3. StundenFaktor (0.01 bis 1.0)

Kategorie-spezifische Kurven, wie voll ein Ort typischerweise zu jeder Stunde ist. Unterschieden nach Wochentag/Weekend.

### Bar (Weekday)
| Stunde | 12 | 14 | 17 | 18 | 19 | 20 | 21 | 22 | 23 | 0 | 1 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Faktor | 0.18 | 0.12 | 0.30 | 0.45 | 0.60 | 0.80 | 0.90 | 0.85 | 0.60 | 0.25 | 0.15 |

### Bar (Weekend)
| Stunde | 12 | 14 | 17 | 18 | 19 | 20 | 21 | 22 | 23 | 0 | 1 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Faktor | 0.20 | 0.16 | 0.35 | 0.50 | 0.65 | 0.78 | 0.88 | 0.95 | 1.00 | 0.65 | 0.50 |

### Cafe (Weekday)
Peak: 15-16h (0.75-0.80), Abends schnell auf 0

### Club (Weekend)
Peak: 23-0h (1.0), bleibt hoch bis 2h (0.70)

**4 Kategorien x 2 Tagestypen = 8 Kurven total**

---

## 4. Additive Boosts

Werden NACH der Basis-Multiplikation addiert und mit dem SeasonFaktor skaliert.

| Boost | Punkte | Bedingung |
|---|---|---|
| Event heute (lokal) | +12 | Bar hat heute ein Event |
| Afterwork | +8 | Afterwork-Tag (Mi-Fr, 16-20h) |
| Gutes Wetter (Outdoor) | +20 | Sonne + warm + Terrasse |
| Gutes Wetter (Indoor) | +3 bis +5 | Regen bei warmen Temperaturen |
| Stadtteil-Bonus | -5 bis +8 | BarDensityFactor des Viertels |
| Stadtteil-Peak-Day | +3 | Heute ist ein Peak-Tag fuer dieses Viertel |
| Wetter-Dynamik | -10 bis +15 | Temperatursprung vs. gestern |
| Grossevent | +8 bis +30 | Hafengeburtstag, Reeperbahn Festival etc. |
| Semester (jung) | +3 / -4 | Vorlesungszeit / Ferien in jungen Vierteln |
| Tageslicht (Outdoor) | -3 / +4 | Dunkel+nicht Sommer / Lange Sommerabende |
| Wind (Outdoor) | -8 | Wind > 30 km/h bei Outdoor-Location |
| Wind (alle) | -5 | Wind > 50 km/h (Sturm) |

---

## 5. Multiplikative Faktoren

| Faktor | Bereich | Erklaerung |
|---|---|---|
| Wetter-Penalty | 0.60 bis 1.0 | Schlechtes Wetter als Prozent-Abzug |
| Offen-Faktor | 0.25 bis 1.0 | Geschlossen=25%, Vermutlich=70%, Offen=100% |
| Payweek | 0.97 bis 1.05 | Monatsanfang=+5%, Monatsende=-3% |
| Season | 0.50 bis 1.10 | Winter=0.7, Fruehling/Herbst=0.85, Sommer=1.0 |

---

## 6. Wetter-Details

**Datenquelle:** Open-Meteo API (kostenlos, kein Key noetig)  
**Besonderheit:** Gefuehlte Temperatur (apparent_temperature) statt echte Temperatur  
**Stuendlich:** Fuer Abendstunden (17-23h) wird das stuendliche Forecast-Wetter genommen

| Bedingung | Outdoor-Mod | Indoor-Mod |
|---|---|---|
| Frost (< 0 Grad gefuehlt) | -40 | -20 |
| Starkregen + kalt | -30 | -5 |
| Starkregen + warm | -30 | +5 |
| Nieselregen | -15 | -3 bis +3 |
| Sonne + warm (> 20 Grad) | +20 | -5 |
| Kalt, trocken (0-5 Grad) | -10 | 0 |

**Wetter-Dynamik (vs. gestern):**
- +10 Grad Sprung: +15
- +5 Grad Sprung: +8
- Regen gestern, Sonne heute (> 12 Grad): +10
- Erster warmer Fruehlingstag (Maerz/April, > 18 Grad, sonnig): +12

---

## 7. Stadtteil-Index (18 Hamburger Bezirke)

Jeder Stadtteil hat:
- **nightlifeScore** (0-100): Nachtleben-Relevanz
- **barDensityFactor** (0-1): Bar-Dichte, bestimmt Stadtteil-Bonus
- **ageGroup**: jung / jung-gemischt / gemischt / mittel (fuer Semester-Effekt)
- **peakDays**: An welchen Wochentagen ist das Viertel besonders aktiv
- **wealthIndex**: Wohlstand (aktuell Info, nicht im Score)

Beispiele:
- St. Pauli: nightlife=100, density=1.0, jung-gemischt, peaks Do-Sa
- Sternschanze: nightlife=90, density=0.95, jung, peaks Mi-Sa
- Blankenese: nightlife=10, density=0.1, mittel-gehoben, peaks Fr-Sa

---

## 8. Feiertage

**Datenquelle:** date.nager.at API (kostenlos)  
**Scope:** Nur globale + Hamburg (DE-HH) relevante Feiertage  
**Geladen:** 10 Feiertage fuer 2026

Wirkung:
- Feiertag selbst: TagFaktor mindestens 0.90
- Brueckentag (Fr nach Feiertag Do, Mo vor Feiertag Di): mindestens 0.85
- Vorabend: mindestens 0.90

---

## 9. Grossevents Hamburg

| Event | Zeitraum | Boost | Stadtteile |
|---|---|---|---|
| Hafengeburtstag | Mai 8-11 | +20 | St. Pauli, Altona, Neustadt |
| Reeperbahn Festival | Sep 17-20 | +25 | St. Pauli, Sternschanze |
| DOM (3x jaehrlich) | je ~30 Tage | +10 | St. Pauli |
| Schlagermove | Jun 4 | +20 | St. Pauli, Sternschanze |
| CSD Hamburg | Jul 1-2 | +15 | St. Pauli, Neustadt, Altona |
| Altonale | Jun 12-28 | +10 | Ottensen, Altona |
| Weihnachtsmaerkte | Nov-Dez | +8 | Neustadt, Altstadt, Wandsbek |
| Silvester | Dez 31 | +30 | Ueberall |

---

## 10. Score-Interpretation

| Score | Label | Bedeutung |
|---|---|---|
| 0-10% | Ruhig | Kaum was los, die meisten Laeden zu |
| 11-25% | Wenig los | Einzelne Gaeste, gemuetlich |
| 26-40% | Etwas los | Angenehm belebt, gute Gespraeche |
| 41-60% | Belebt | Gute Stimmung, volle Tische |
| 61-80% | Viel los | Lebhaft, beste Atmosphaere |
| 81-100% | Peak | Ausgelassen, Hochbetrieb |

---

## 11. Stadt-Vibe (Aggregiert)

Der Stadt-Vibe ist der Durchschnitt aller offenen Bar-artigen Locations.  
**Kategorien im Stadt-Vibe:** bar, pub, cocktailbar, wine, irish-pub, nightclub, biergarten, lounge, sports_bar  
**Ausgeschlossen:** Cafes, Restaurants (wuerden den Schnitt verfaelschen)

---

## Versionshistorie

| Version | Datum | Aenderungen |
|---|---|---|
| 1.0 | 2026-02-20 | Basis: Tag+Stunde+Wetter+Stadtteil |
| 2.0 | 2026-02-21 | Feiertage, gefuehlte Temperatur, stuendlicher Forecast, Stadtteil-Peak-Days, Payweek, Semester, Tageslicht, Grossevents, Wind, Konsistenz-Fix Hero/Banner |

---

## Datenquellen

| Quelle | Kosten | Zweck | Frequenz |
|---|---|---|---|
| Open-Meteo | Kostenlos | Wetter (aktuell + stuendlich + Sunrise/Sunset) | Alle 30 Min |
| date.nager.at | Kostenlos | Feiertage DE/Hamburg | 1x pro Jahr |
| Eigene DB (SQLite) | - | Bar-Daten, Community Scores | Laufend |
| stadtteil_index.json | - | Demografie, Bar-Dichte | Statisch |
| MAJOR_EVENTS_HAMBURG | - | Jaehrliche Grossevents | Manuell gepflegt |
