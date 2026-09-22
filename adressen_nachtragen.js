#!/usr/bin/env node
/**
 * adressen_nachtragen.js — traegt fehlende Adressen in highlights.json nach.
 *
 * Hintergrund: 161 der 5.213 Eintraege haben keine Adresse. Das fruehere
 * enrich_data.js hat das erledigt, es ist mit den Scrapern aus dem Projekt
 * verschwunden. Hier steht nur der Teil wieder, der wirklich gebraucht wird.
 *
 * Quelle ist Nominatim (OpenStreetMap). Deren Nutzungsregeln verlangen eine
 * sprechende Kennung und hoechstens eine Anfrage pro Sekunde. Beides ist
 * eingehalten, deshalb dauert ein voller Lauf einige Minuten.
 *
 * Es wird nur ergaenzt, nie ueberschrieben. Vor dem Schreiben entsteht eine
 * Sicherung.
 *
 * Aufruf:  node adressen_nachtragen.js [--trocken] [--grenze 50]
 */

const fs = require('fs');
const path = require('path');

const DATEI = path.join(__dirname, 'highlights.json');
const KENNUNG = 'barfinder-datenpflege/1.0 (https://oliver-roessling.claw.clawy.io/apps/barfinder/)';
const PAUSE_MS = 1100;

function schlafe(ms) { return new Promise(r => setTimeout(r, ms)); }

async function rueckwaerts(lat, lon) {
  const url = 'https://nominatim.openstreetmap.org/reverse?format=jsonv2'
    + '&lat=' + encodeURIComponent(lat) + '&lon=' + encodeURIComponent(lon)
    + '&zoom=18&addressdetails=1&accept-language=de';
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': KENNUNG } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

/** Aus der Nominatim-Antwort eine kurze deutsche Adresse bauen. */
function adresseAus(antwort) {
  const a = (antwort && antwort.address) || {};
  const strasse = a.road || a.pedestrian || a.footway || a.residential || '';
  const nummer = a.house_number || '';
  const plz = a.postcode || '';
  const ort = a.city || a.town || a.village || a.municipality || a.suburb || '';
  if (!strasse && !ort) return '';
  const teil1 = [strasse, nummer].filter(Boolean).join(' ');
  const teil2 = [plz, ort].filter(Boolean).join(' ');
  return [teil1, teil2].filter(Boolean).join(', ');
}

function stadtteilAus(antwort) {
  const a = (antwort && antwort.address) || {};
  return a.suburb || a.city_district || a.borough || a.village || '';
}

async function main() {
  const args = process.argv.slice(2);
  const trocken = args.includes('--trocken');
  const gIdx = args.indexOf('--grenze');
  const grenze = gIdx > -1 ? parseInt(args[gIdx + 1], 10) : Infinity;

  const eintraege = JSON.parse(fs.readFileSync(DATEI, 'utf8'));
  const offen = eintraege.filter(e =>
    (!e.address || !String(e.address).trim()) &&
    typeof e.lat === 'number' && typeof e.lon === 'number'
  );

  console.log(`${eintraege.length} Eintraege, davon ${offen.length} ohne Adresse.`);
  if (!offen.length) return;

  const ziel = offen.slice(0, grenze);
  console.log(`Es werden ${ziel.length} nachgeschlagen, eine Anfrage pro Sekunde.\n`);

  let getroffen = 0, leer = 0, fehler = 0;
  for (let i = 0; i < ziel.length; i++) {
    const e = ziel[i];
    try {
      const antwort = await rueckwaerts(e.lat, e.lon);
      const adr = adresseAus(antwort);
      if (adr) {
        e.address = adr;
        if (!e.district) { const st = stadtteilAus(antwort); if (st) e.district = st; }
        e.address_quelle = 'nominatim';
        e.address_stand = new Date().toISOString().slice(0, 10);
        getroffen++;
        console.log(`  ✅ ${String(i + 1).padStart(3)} ${e.name} → ${adr}`);
      } else {
        leer++;
        console.log(`  ·  ${String(i + 1).padStart(3)} ${e.name} → nichts gefunden`);
      }
    } catch (err) {
      fehler++;
      console.log(`  ❌ ${String(i + 1).padStart(3)} ${e.name} → ${err.message}`);
    }
    if (i < ziel.length - 1) await schlafe(PAUSE_MS);
  }

  console.log(`\nErgebnis: ${getroffen} nachgetragen, ${leer} ohne Treffer, ${fehler} Fehler.`);

  if (trocken) { console.log('Trockenlauf, nichts geschrieben.'); return; }
  if (!getroffen) { console.log('Nichts zu schreiben.'); return; }

  const sicherung = DATEI + '.bak-adressen-' + new Date().toISOString().slice(0, 10).replace(/-/g, '');
  fs.copyFileSync(DATEI, sicherung);
  fs.writeFileSync(DATEI, JSON.stringify(eintraege, null, 2));
  console.log(`Geschrieben. Sicherung: ${path.basename(sicherung)}`);
}

main().catch(e => { console.error('Abgebrochen:', e); process.exit(1); });
