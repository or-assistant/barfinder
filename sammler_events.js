#!/usr/bin/env node
/**
 * sammler_events.js — holt echte, aktuelle Veranstaltungen nach Hamburg.
 *
 * Hintergrund: die alten scrape_*.js sind aus dem Projekt entfernt worden
 * (siehe .gitignore: "Scrapers (removed)"). Seitdem kommen alle Termine aus
 * curated_events.json, also aus wiederkehrenden Schablonen. Der Feed zeigt
 * deshalb seit Monaten immer dasselbe.
 *
 * Dieser Sammler ersetzt den alten Scraper-Zoo durch zwei Arten von Quellen:
 *
 *   1. Strukturierte Quellen (Luma, Meetup). Beide Seiten legen ihre Daten
 *      als JSON in die Seite (__NEXT_DATA__). Das lesen wir direkt aus,
 *      ohne HTML-Selektoren, die bei jedem Redesign brechen.
 *   2. Redaktionelle Quellen (szene-hamburg, Mit Vergnuegen). Dort gibt es
 *      kein JSON. Statt CSS-Selektoren zu raten, schicken wir den Fliesstext
 *      an das Sprachmodell hinter dem Clawy-Zugang und lassen es die Termine
 *      als JSON herausziehen. Aendert die Seite ihr Layout, laeuft das
 *      weiter, solange die Termine noch lesbar dastehen.
 *
 * Ergebnis landet in live_events_cache.json. server.js mischt die Datei zu
 * den kuratierten Terminen dazu.
 *
 * Grundregel: eine kaputte Quelle darf den Feed nie leeren. Faellt eine
 * Quelle aus, werden ihre Termine aus dem letzten Lauf uebernommen und als
 * veraltet markiert.
 *
 * Aufruf:  node sammler_events.js [--nur luma,meetup] [--trocken]
 */

const fs = require('fs');
const path = require('path');

const ORDNER = __dirname;
const ZIEL = path.join(ORDNER, 'live_events_cache.json');
const BERICHT = path.join(ORDNER, 'live_events_bericht.json');

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const ZEITFENSTER_TAGE = 42;          // wie weit in die Zukunft wir Termine behalten
const ALTBESTAND_MAX_TAGE = 7;        // so lange duerfen Termine einer toten Quelle nachwirken

// ── Clawy-Zugang fuer die Textauswertung ──────────────────────────────────
function clawyZugang() {
  try {
    const cfg = JSON.parse(fs.readFileSync('/home/openclaw/.openclaw/openclaw.json', 'utf8'));
    const p = cfg.models && cfg.models.providers && cfg.models.providers.clawy;
    if (p && p.apiKey) return { schluessel: p.apiKey, basis: p.baseUrl || 'https://clawy.io/api/v1/ai' };
  } catch (e) { /* faellt unten auf null zurueck */ }
  return null;
}

async function hole(url, opt = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opt.timeout || 30000);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: Object.assign({
        'User-Agent': UA,
        'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
      }, opt.headers || {}),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return opt.json ? await r.json() : await r.text();
  } catch (err) {
    // Manche Seiten (hamburg.de) werfen die Node-eigene fetch-Verbindung ab,
    // antworten curl aber anstandslos. Deshalb hier eine zweite Ebene.
    if (opt.keinCurl) throw err;
    const text = ueberCurl(url, Math.ceil((opt.timeout || 30000) / 1000));
    return opt.json ? JSON.parse(text) : text;
  } finally { clearTimeout(t); }
}

function ueberCurl(url, sekunden) {
  const { execFileSync } = require('child_process');
  return execFileSync('curl', [
    '-sL', '--compressed', '-m', String(sekunden),
    '-A', UA, '-H', 'Accept-Language: de-DE,de;q=0.9', url,
  ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

function nextData(html) {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) throw new Error('kein __NEXT_DATA__ in der Seite');
  return JSON.parse(m[1]);
}

/** ISO-Zeitstempel -> { date: 'YYYY-MM-DD', time: 'HH:MM' } in Hamburger Zeit. */
function hamburgerZeit(iso) {
  if (!iso) return { date: '', time: '' };
  const d = new Date(iso);
  if (isNaN(d)) return { date: '', time: '' };
  const f = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Berlin',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const s = f.format(d);                 // "2026-09-24 19:00"
  const [datum, uhr] = s.split(' ');
  return { date: datum, time: uhr };
}

function heuteHamburg() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(new Date());
}

function inZeitfenster(datum) {
  if (!datum || !/^\d{4}-\d{2}-\d{2}$/.test(datum)) return false;
  const heute = heuteHamburg();
  if (datum < heute) return false;
  const grenze = new Date(Date.now() + ZEITFENSTER_TAGE * 86400000);
  return datum <= new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(grenze);
}

// Hamburg und unmittelbares Umland. Luma und Meetup liefern gelegentlich
// Termine aus ganz Deutschland, wenn die Ortserkennung an der Server-IP haengt.
const HH_BOX = { latMin: 53.30, latMax: 53.85, lonMin: 9.55, lonMax: 10.45 };
function istHamburg(text, lat, lon) {
  if (typeof lat === 'number' && typeof lon === 'number') {
    return lat >= HH_BOX.latMin && lat <= HH_BOX.latMax && lon >= HH_BOX.lonMin && lon <= HH_BOX.lonMax;
  }
  return /hamburg|altona|st\.?\s*pauli|eimsbüttel|eimsbuettel|wandsbek|harburg|bergedorf|ottensen|winterhude|barmbek|schanze|hafencity/i.test(text || '');
}

// ══════════════════════════════════════════════════════════════════════════
// Quelle 1: Luma (lu.ma/hamburg)
// ══════════════════════════════════════════════════════════════════════════
async function quelleLuma() {
  const html = await hole('https://lu.ma/hamburg', { timeout: 30000 });
  const daten = nextData(html);
  const roh = daten?.props?.pageProps?.initialData?.data?.events || [];
  const raus = [];
  let verworfen = 0;

  for (const eintrag of roh) {
    const e = eintrag.event || {};
    const geo = e.geo_address_info || {};
    const ortText = [geo.city, geo.address, geo.full_address].filter(Boolean).join(' ');
    if (e.location_type === 'virtual') { verworfen++; continue; }
    if (!istHamburg(ortText, geo.latitude, geo.longitude)) { verworfen++; continue; }

    const { date, time } = hamburgerZeit(e.start_at);
    if (!inZeitfenster(date)) { verworfen++; continue; }

    const lok = (geo.localized && geo.localized.de) || {};
    raus.push({
      title: e.name,
      date, time,
      venue: lok.address || geo.address || 'Hamburg',
      description: (eintrag.calendar && eintrag.calendar.name) ? 'Veranstalter: ' + eintrag.calendar.name : '',
      url: e.url ? 'https://lu.ma/' + e.url : 'https://lu.ma/hamburg',
      type: 'networking',
      source: 'luma',
      price: '',
      free: false,
    });
  }
  return { events: raus, verworfen };
}

// ══════════════════════════════════════════════════════════════════════════
// Quelle 2: Meetup (find/events, Hamburg)
// ══════════════════════════════════════════════════════════════════════════
async function quelleMeetup() {
  const html = await hole(
    'https://www.meetup.com/find/events/?location=de--Hamburg&source=EVENTS',
    { timeout: 35000 }
  );
  const daten = nextData(html);
  const state = daten?.props?.pageProps?.__APOLLO_STATE__ || {};
  const raus = [];
  let verworfen = 0;

  for (const schluessel of Object.keys(state)) {
    if (!/^Event:/.test(schluessel)) continue;
    const e = state[schluessel];
    const venue = e.venue || {};
    const istOnline = e.eventType === 'ONLINE' || /online event/i.test(venue.name || '');
    if (istOnline) { verworfen++; continue; }

    const ortText = [venue.name, venue.address, venue.city].filter(Boolean).join(' ');
    if (!istHamburg(ortText)) { verworfen++; continue; }

    const { date, time } = hamburgerZeit(e.dateTime);
    if (!inZeitfenster(date)) { verworfen++; continue; }

    const beschreibung = (e.description || '')
      .replace(/[*_#>​]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 400);

    raus.push({
      title: e.title,
      date, time,
      venue: [venue.name, venue.address].filter(Boolean).join(', ') || 'Hamburg',
      description: beschreibung,
      url: e.eventUrl || '',
      type: 'networking',
      source: 'meetup',
      price: '',
      free: !e.feeSettings,
    });
  }
  return { events: raus, verworfen };
}

// ══════════════════════════════════════════════════════════════════════════
// Quelle 3: SZENE HAMBURG Tagestipps
//
// Die Seite fuehrt ihre Tagestipps als eigenen Inhaltstyp im WordPress
// (en_tagestipp) und gibt sie ueber die offene wp-json-Schnittstelle heraus.
// Das ist deutlich belastbarer als die HTML-Seite: der Titel traegt das Datum
// im Format "04.10. | Titel". Ort, Uhrzeit und Art stehen nur im Fliesstext,
// die zieht das Sprachmodell in einem einzigen Aufruf fuer alle Tipps heraus.
// ══════════════════════════════════════════════════════════════════════════
async function quelleSzene() {
  const roh = await hole(
    'https://szene-hamburg.com/wp-json/wp/v2/en_tagestipp?per_page=60&orderby=date&order=desc',
    { timeout: 30000, json: true }
  );
  if (!Array.isArray(roh)) throw new Error('unerwartete Antwort der wp-json-Schnittstelle');

  const heute = heuteHamburg();
  const jahrHeute = parseInt(heute.slice(0, 4), 10);
  const entwurf = [];
  let verworfen = 0;

  for (const p of roh) {
    const titelRoh = entkodiere((p.title && p.title.rendered) || '');
    const m = titelRoh.match(/^\s*(\d{1,2})\.(\d{1,2})\.\s*\|\s*(.+)$/);
    if (!m) { verworfen++; continue; }
    const tag = m[1].padStart(2, '0'), monat = m[2].padStart(2, '0');
    // Jahreswechsel: ein Tipp fuer den 04.01., gesehen im Dezember, meint das Folgejahr.
    let jahr = jahrHeute;
    let datum = `${jahr}-${monat}-${tag}`;
    if (datum < heute) { jahr += 1; datum = `${jahr}-${monat}-${tag}`; }
    if (!inZeitfenster(datum)) { verworfen++; continue; }

    const text = entkodiere(((p.excerpt && p.excerpt.rendered) || (p.content && p.content.rendered) || ''))
      .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

    entwurf.push({ titel: m[3].trim(), datum, text: text.slice(0, 300), url: p.link || '' });
  }

  // Ort, Uhrzeit und Art in einem Aufruf fuer alle Tipps nachtragen.
  let zusatz = {};
  if (entwurf.length) {
    try { zusatz = await ortUndZeitNachtragen(entwurf); }
    catch (e) { /* ohne Zusatz weiter, Titel und Datum stehen ja */ }
  }

  const raus = entwurf.map((e, i) => {
    const z = zusatz[i] || {};
    return {
      title: e.titel,
      date: e.datum,
      time: /^\d{1,2}:\d{2}$/.test(z.time || '') ? z.time : '',
      venue: (z.venue || 'Hamburg').slice(0, 160),
      description: e.text.slice(0, 260),
      url: e.url,
      type: ['party', 'konzert', 'kultur', 'networking', 'social', 'food'].includes(z.type) ? z.type : 'kultur',
      source: 'szene-hamburg',
      price: '',
      free: false,
    };
  });
  return { events: raus, verworfen };
}

function entkodiere(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

/** Ein Modellaufruf fuer alle Tipps: liefert { index: {venue,time,type} }. */
async function ortUndZeitNachtragen(entwurf) {
  const zugang = clawyZugang();
  if (!zugang) throw new Error('kein Clawy-Schluessel');

  const liste = entwurf.map((e, i) => `${i}: ${e.titel} — ${e.text.slice(0, 180)}`).join('\n');
  const auftrag =
    'Unten stehen Veranstaltungstipps aus Hamburg, je Zeile eine laufende Nummer, ' +
    'der Titel und ein Textauszug.\n\n' +
    'Gib fuer jede Nummer den Veranstaltungsort, die Uhrzeit und die Art zurueck.\n' +
    'Antworte ausschliesslich mit einem JSON-Array:\n' +
    '[{"i":0,"venue":"Name des Ortes oder leer","time":"HH:MM oder leer",' +
    '"type":"party|konzert|kultur|networking|social|food"}]\n\n' +
    'Regeln: Steht der Ort nicht im Text, gib "" zurueck. Rate keine Uhrzeit. ' +
    'Keine Erklaerung, nur das JSON-Array.\n\n' + liste;

  const antwort = await postJson(zugang.basis + '/chat/completions', zugang.schluessel, {
    model: 'clawy-ai-sub',
    messages: [{ role: 'user', content: auftrag }],
    max_tokens: 4000,
    temperature: 0,
  }, 240000);

  const arr = jsonAusAntwort(antwort?.choices?.[0]?.message?.content);
  const karte = {};
  for (const e of Array.isArray(arr) ? arr : []) {
    if (e && Number.isInteger(e.i)) karte[e.i] = e;
  }
  return karte;
}

// ══════════════════════════════════════════════════════════════════════════
// Quelle 4: redaktionelle Seiten, ausgewertet per Sprachmodell
// ══════════════════════════════════════════════════════════════════════════
function textAusHtml(html) {
  let text;
  try {
    const cheerio = require('cheerio');
    const $ = cheerio.load(html);
    $('script, style, noscript, svg, iframe, header nav, footer').remove();
    text = $('body').text();
  } catch (e) {
    text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ');
  }
  return text.replace(/&nbsp;/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

async function postJson(url, schluessel, koerper, timeout = 120000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Authorization': 'Bearer ' + schluessel, 'Content-Type': 'application/json' },
      body: JSON.stringify(koerper),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
    return await r.json();
  } finally { clearTimeout(t); }
}

function jsonAusAntwort(inhalt) {
  if (!inhalt) return [];
  let s = String(inhalt).trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const a = s.indexOf('['), b = s.lastIndexOf(']');
  if (a === -1 || b === -1 || b < a) return [];
  try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { return []; }
}

async function quelleRedaktion(name, url) {
  const zugang = clawyZugang();
  if (!zugang) throw new Error('kein Clawy-Schluessel in openclaw.json');

  const html = await hole(url, { timeout: 30000 });
  const text = textAusHtml(html);
  if (text.length < 500) throw new Error('Seite lieferte kaum Text (' + text.length + ' Zeichen)');

  const heute = heuteHamburg();
  const auftrag =
    `Heute ist der ${heute}. Unten steht der Textinhalt der Seite ${url}.\n\n` +
    `Ziehe daraus alle konkreten Veranstaltungen in Hamburg heraus, die in den naechsten ` +
    `${ZEITFENSTER_TAGE} Tagen stattfinden. Nur Termine mit erkennbarem Datum.\n\n` +
    `Antworte ausschliesslich mit einem JSON-Array. Jedes Element:\n` +
    `{"title":"","date":"YYYY-MM-DD","time":"HH:MM oder leer","venue":"Ort oder Adresse",` +
    `"description":"ein Satz","url":"absolute URL oder leer","type":"party|konzert|kultur|networking|social|food",` +
    `"price":"Text oder leer","free":true oder false}\n\n` +
    `Regeln: Erfinde nichts. Kein Datum erkennbar, dann weglassen. Keine Dauerausstellungen ` +
    `ohne Termin, keine reinen Werbebloecke, keine Online-Veranstaltungen. Gibt es nichts, ` +
    `antworte mit []. Keine Erklaerung, nur das JSON-Array.\n\n` +
    `--- Seitentext ---\n` + text.slice(0, 16000);

  const antwort = await postJson(zugang.basis + '/chat/completions', zugang.schluessel, {
    model: 'clawy-ai-sub',
    messages: [{ role: 'user', content: auftrag }],
    max_tokens: 4000,
    temperature: 0,
  }, 240000);

  const inhalt = antwort?.choices?.[0]?.message?.content;
  const roh = jsonAusAntwort(inhalt);
  const raus = [];
  let verworfen = 0;

  for (const e of Array.isArray(roh) ? roh : []) {
    if (!e || !e.title || !e.date) { verworfen++; continue; }
    if (!inZeitfenster(e.date)) { verworfen++; continue; }
    raus.push({
      title: String(e.title).slice(0, 160),
      date: e.date,
      time: /^\d{1,2}:\d{2}$/.test(e.time || '') ? e.time : '',
      venue: String(e.venue || 'Hamburg').slice(0, 160),
      description: String(e.description || '').slice(0, 300),
      url: /^https?:\/\//.test(e.url || '') ? e.url : url,
      type: e.type || 'social',
      source: name,
      price: String(e.price || '').slice(0, 60),
      free: e.free === true,
    });
  }
  return { events: raus, verworfen, modell: antwort?.model || '', textlaenge: text.length };
}

// ══════════════════════════════════════════════════════════════════════════
const QUELLEN = [
  { name: 'luma',           art: 'struktur',   lauf: quelleLuma },
  { name: 'meetup',         art: 'struktur',   lauf: quelleMeetup },
  { name: 'szene-hamburg',  art: 'struktur',   lauf: quelleSzene },
  // hamburg.de ist am 22.09.2026 wieder herausgeflogen: rund 80 Sekunden
  // Modellzeit pro Lauf fuer ein bis zehn Termine, die der Ereignisfilter
  // des Servers anschliessend saemtlich aussortiert hat (reine Kultur).
  // quelleRedaktion() bleibt stehen, damit eine bessere Seite sofort
  // angeschlossen werden kann.
];

function schluesselFuer(e) {
  return (e.source + '|' + (e.title || '').toLowerCase().replace(/[^a-z0-9äöüß]/g, '') + '|' + e.date);
}

/**
 * Nur ein Lauf zur Zeit. Der naechtliche Lauf kann mehrere Minuten dauern
 * (die Modellauswertung ist zaeh); faellt das leichte Nachladen um 11:00
 * oder 16:30 hinein, wuerden sich beide beim Schreiben von
 * live_events_cache.json ueberholen.
 */
const SPERRE = path.join(ORDNER, '.sammler.lock');

function sperreNehmen() {
  try {
    fs.writeFileSync(SPERRE, String(process.pid), { flag: 'wx' });
    return true;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    // Verwaiste Sperre? Laeuft der eingetragene Vorgang nicht mehr, raeumen wir auf.
    try {
      const pid = parseInt(fs.readFileSync(SPERRE, 'utf8'), 10);
      process.kill(pid, 0);            // wirft, wenn es den Vorgang nicht gibt
      return false;                    // laeuft wirklich noch
    } catch (e2) {
      fs.unlinkSync(SPERRE);
      fs.writeFileSync(SPERRE, String(process.pid), { flag: 'wx' });
      return true;
    }
  }
}

function sperreFreigeben() {
  try { fs.unlinkSync(SPERRE); } catch (e) { /* schon weg */ }
}

async function main() {
  const args = process.argv.slice(2);
  const nurIdx = args.indexOf('--nur');
  const nur = nurIdx > -1 ? (args[nurIdx + 1] || '').split(',').map(s => s.trim()).filter(Boolean) : null;
  const trocken = args.includes('--trocken');

  let alt = { events: [], quellen: {} };
  try { alt = JSON.parse(fs.readFileSync(ZIEL, 'utf8')); } catch (e) { /* erster Lauf */ }

  const bericht = { start: new Date().toISOString(), quellen: {} };
  const gesammelt = [];

  for (const q of QUELLEN) {
    // Uebersprungene Quelle: ihre Termine aus dem letzten Lauf mitnehmen.
    // Sonst wuerde das leichte Nachladen (--nur luma,meetup) den Bestand
    // der uebrigen Quellen jedes Mal loeschen.
    if (nur && !nur.includes(q.name)) {
      const behalten = (alt.events || []).filter(e => e.source === q.name && inZeitfenster(e.date));
      gesammelt.push(...behalten);
      if (behalten.length) {
        const vorher = (alt.quellen || {})[q.name] || {};
        bericht.quellen[q.name] = Object.assign({}, vorher, { uebersprungen: true, anzahl: behalten.length });
        console.log(`⏭️  ${q.name}: uebersprungen, ${behalten.length} Termine aus dem letzten Lauf behalten`);
      }
      continue;
    }
    const t0 = Date.now();
    try {
      const r = await q.lauf();
      gesammelt.push(...r.events);
      bericht.quellen[q.name] = {
        ok: true, anzahl: r.events.length, verworfen: r.verworfen || 0,
        art: q.art, dauer_ms: Date.now() - t0,
        modell: r.modell || undefined, textlaenge: r.textlaenge || undefined,
      };
      console.log(`✅ ${q.name}: ${r.events.length} Termine (${r.verworfen || 0} verworfen, ${Date.now() - t0}ms)`);
    } catch (err) {
      // Quelle tot: Termine aus dem letzten Lauf uebernehmen, solange sie frisch genug sind.
      const gerettet = (alt.events || []).filter(e =>
        e.source === q.name &&
        inZeitfenster(e.date) &&
        (!e.stand || (Date.now() - Date.parse(e.stand)) < ALTBESTAND_MAX_TAGE * 86400000)
      );
      gesammelt.push(...gerettet);
      bericht.quellen[q.name] = {
        ok: false, fehler: String(err.message || err).slice(0, 300),
        uebernommen: gerettet.length, art: q.art, dauer_ms: Date.now() - t0,
      };
      console.log(`❌ ${q.name}: ${err.message} — ${gerettet.length} Termine aus dem letzten Lauf uebernommen`);
    }
  }

  // Doppelte zusammenfuehren. Gleicher Titel am gleichen Tag zaehlt einmal,
  // auch wenn er ueber zwei Quellen hereinkommt (Meetup verlinkt oft auf Luma).
  const nachTitel = new Map();
  const jetzt = new Date().toISOString();
  for (const e of gesammelt) {
    if (!e.stand) e.stand = jetzt;
    const titelSchluessel = (e.title || '').toLowerCase().replace(/[^a-z0-9äöüß]/g, '').slice(0, 40) + '|' + e.date;
    const vorhanden = nachTitel.get(titelSchluessel);
    if (!vorhanden) { nachTitel.set(titelSchluessel, e); continue; }
    // strukturierte Quelle schlaegt Modellauswertung
    const rang = s => (s === 'luma' || s === 'meetup') ? 2 : 1;
    if (rang(e.source) > rang(vorhanden.source)) nachTitel.set(titelSchluessel, e);
  }

  const events = [...nachTitel.values()].sort((a, b) =>
    (a.date + (a.time || '')).localeCompare(b.date + (b.time || ''))
  );

  const ausgabe = {
    generiert: jetzt,
    zeitfenster_tage: ZEITFENSTER_TAGE,
    quellen: bericht.quellen,
    anzahl: events.length,
    events,
  };

  if (trocken) {
    console.log('\n--- Trockenlauf, nichts geschrieben ---');
    console.log(JSON.stringify({ anzahl: events.length, quellen: bericht.quellen }, null, 2));
    console.log(events.slice(0, 8).map(e => `${e.date} ${e.time || '--:--'}  ${e.source.padEnd(14)} ${e.title}`).join('\n'));
    return;
  }

  // Nie eine leere Datei ueber einen gefuellten Bestand schreiben.
  if (events.length === 0 && (alt.events || []).length > 0) {
    console.log('⚠️ Keine einzige Quelle lieferte Termine. Bestand bleibt unveraendert.');
    bericht.abbruch = 'keine Termine, Bestand behalten';
  } else {
    fs.writeFileSync(ZIEL, JSON.stringify(ausgabe, null, 1));
    console.log(`\n📝 ${ZIEL}: ${events.length} Termine`);
  }

  bericht.ende = new Date().toISOString();
  bericht.anzahl = events.length;
  fs.writeFileSync(BERICHT, JSON.stringify(bericht, null, 1));
}

if (!process.argv.includes('--trocken') && !sperreNehmen()) {
  console.log('⏸️  Ein Sammellauf ist bereits unterwegs. Dieser Lauf endet ohne Aenderung.');
  process.exit(0);
}
process.on('exit', sperreFreigeben);
process.on('SIGTERM', () => { sperreFreigeben(); process.exit(143); });
process.on('SIGINT', () => { sperreFreigeben(); process.exit(130); });

main()
  .catch(e => { console.error('Sammler abgebrochen:', e); process.exitCode = 1; })
  .finally(sperreFreigeben);
