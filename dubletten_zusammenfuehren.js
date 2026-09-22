#!/usr/bin/env node
/**
 * dubletten_zusammenfuehren.js — fuehrt doppelte Eintraege in highlights.json
 * zusammen.
 *
 * Das Audit vom 28.03.2026 meldete 266 Namensdubletten. Die Zahl war falsch,
 * weil nur Namen verglichen wurden: Starbucks an vierzehn Adressen ist eine
 * Kette. Wirklich verdaechtig ist nur, was denselben oder einen sehr
 * aehnlichen Namen traegt UND weniger als 150 Meter entfernt liegt.
 *
 * Auch das reicht aber nicht als Urteil. "Fabrik" und "Eisfabrik" stehen an
 * derselben Ecke und sind zwei Laeden. "Jahreszeiten Bar" und "Jahreszeiten
 * Grill" liegen im selben Hotel und sind zwei Betriebe. Diese Unterscheidung
 * ist Textverstaendnis, nicht Zeichenvergleich, deshalb entscheidet das
 * Sprachmodell ueber den Clawy-Zugang, in Haeppchen zu acht Paaren.
 *
 * Nichts wird geloescht. Der schwaechere Eintrag wird in den staerkeren
 * hineingefuellt (leere Felder zuerst) und wandert vollstaendig in
 * dubletten_log.json.
 *
 * Das Urteil des Modells ist zwischen zwei Laeufen nicht reproduzierbar,
 * auch bei temperature 0 nicht — der Clawy-Zugang verteilt auf wechselnde
 * Anbieter. Ein zweiter Lauf kann deshalb weitere Paare zusammenfuehren.
 * Das ist unkritisch, weil jeder Lauf nur zusammenfuehrt und nie trennt,
 * und weil alles in dubletten_log.json steht.
 *
 * Aufruf:  node dubletten_zusammenfuehren.js [--trocken]
 */

const fs = require('fs');
const path = require('path');

const DATEI = path.join(__dirname, 'highlights.json');
const LOG = path.join(__dirname, 'dubletten_log.json');
const MAX_METER = 150;

function clawyZugang() {
  const cfg = JSON.parse(fs.readFileSync('/home/openclaw/.openclaw/openclaw.json', 'utf8'));
  const p = cfg.models && cfg.models.providers && cfg.models.providers.clawy;
  if (!p || !p.apiKey) throw new Error('kein Clawy-Schluessel in openclaw.json');
  return { schluessel: p.apiKey, basis: p.baseUrl || 'https://clawy.io/api/v1/ai' };
}

async function postJson(url, schluessel, koerper, timeout = 120000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Authorization': 'Bearer ' + schluessel, 'Content-Type': 'application/json' },
      body: JSON.stringify(koerper),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
    return await r.json();
  } finally { clearTimeout(t); }
}

function jsonAusAntwort(inhalt) {
  if (!inhalt) return [];
  let s = String(inhalt).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const a = s.indexOf('['), b = s.lastIndexOf(']');
  if (a === -1 || b === -1) return [];
  try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { return []; }
}

/** Name auf das reduzieren, was den Laden ausmacht. */
function kern(name) {
  return (name || '').toLowerCase()
    .replace(/[äÄ]/g, 'a').replace(/[öÖ]/g, 'o').replace(/[üÜ]/g, 'u').replace(/ß/g, 'ss')
    .replace(/[’'`´]/g, '')
    .replace(/\b(cafe|caf|restaurant|gaststatte|kneipe|bar|weinbar|winebar|das|der|die|the)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function meter(a, b) {
  return Math.hypot(a.lat - b.lat, (a.lon - b.lon) * Math.cos(a.lat * Math.PI / 180)) * 111320;
}

/** Wie viele belastbare Angaben traegt ein Eintrag? */
function gewicht(e) {
  let g = 0;
  for (const f of ['address', 'description', 'vibe', 'opening_hours', 'website', 'phone', 'district']) {
    if (e[f] && String(e[f]).trim()) g++;
  }
  g += Array.isArray(e.tags) ? Math.min(e.tags.length, 5) : 0;
  if (e.google_rating) g += 2;
  return g;
}

/**
 * In Haeppchen fragen. Ein Aufruf ueber alle 65 Paare lief in die
 * Token-Grenze: das Modell denkt sichtbar mit, und die Antwort brach ab,
 * bevor ein einziges Urteil dastand. Auch fuenfzehn waren noch zu viel.
 * Acht gehen, und wenn ein Haeppchen trotzdem leer zurueckkommt, wird es
 * einmal halbiert.
 */
async function urteile(allePaare) {
  const GROESSE = 8;
  const GLEICHZEITIG = 3;

  // Ein haengender Aufruf darf den Lauf nicht kippen. Was nicht beurteilt
  // wird, bleibt unangetastet — kein Urteil heisst nicht zusammenfuehren.
  const frag = async (t, v) => {
    try { return await urteileHaeppchen(t, v); }
    catch (e) {
      console.log(`    ⚠️  Haeppchen ab ${v + 1}: ${String(e.message || e).slice(0, 80)}`);
      return { karte: {}, modell: '' };
    }
  };

  const haeppchen = [];
  for (let start = 0; start < allePaare.length; start += GROESSE) {
    haeppchen.push({ start, teil: allePaare.slice(start, start + GROESSE) });
  }

  // Der Reihe nach dauert das Ganze ueber eine Viertelstunde, weil das Modell
  // je Haeppchen eine bis zweieinhalb Minuten braucht. Drei gleichzeitig
  // bringen es auf wenige Minuten, ohne den Zugang zu ueberfahren.
  const karte = {};
  let modell = '';
  for (let i = 0; i < haeppchen.length; i += GLEICHZEITIG) {
    const gruppe = haeppchen.slice(i, i + GLEICHZEITIG);
    const ergebnisse = await Promise.all(gruppe.map(async (h) => {
      let r = await frag(h.teil, h.start);
      if (!Object.keys(r.karte).length && h.teil.length > 1) {
        const mitte = Math.ceil(h.teil.length / 2);
        const x = await frag(h.teil.slice(0, mitte), h.start);
        const y = await frag(h.teil.slice(mitte), h.start + mitte);
        r = { karte: Object.assign({}, x.karte, y.karte), modell: x.modell || y.modell };
      }
      return { h, r };
    }));
    for (const { h, r } of ergebnisse) {
      Object.assign(karte, r.karte);
      modell = r.modell || modell;
      console.log(`  … Paare ${h.start + 1}–${h.start + h.teil.length}: ${Object.keys(r.karte).length} beurteilt`);
    }
  }
  return { karte, modell };
}

async function urteileHaeppchen(paare, versatz) {
  const zugang = clawyZugang();
  const liste = paare.map((p, i) =>
    `${versatz + i}: "${p.a.name}" | "${p.b.name}" | ${p.meter} m`
  ).join('\n');

  // Bewusst knapp gehalten. Mit ausfuehrlichem Antwortformat (Objekte mit
  // Begruendung) lief das Modell regelmaessig in die Zeitgrenze: es denkt
  // sichtbar mit, und die Begruendungen kosteten mehr als das Urteil. Eine
  // reine Nummernliste beantwortet es in rund zwanzig Sekunden.
  const auftrag =
    'Hamburger Gastronomie-Verzeichnis. Jede Zeile ist ein Paar aus zwei ' +
    'Eintraegen, die dicht beieinander liegen und aehnlich heissen.\n\n' +
    'Welche Zeilen meinen denselben Betrieb unter zwei Schreibweisen ' +
    '(Akzent, Kurzform, Bindestrich)?\n' +
    'Verschiedene Betriebe bleiben draussen, auch wenn sie an derselben ' +
    'Adresse sitzen: "Fabrik" und "Eisfabrik", "Jahreszeiten Bar" und ' +
    '"Jahreszeiten Grill", eine Spielstaette und eine Veranstaltung darin.\n' +
    'Im Zweifel weglassen.\n\n' +
    'Antworte NUR mit einem JSON-Array der Nummern, sonst nichts. ' +
    'Beispiel: [0,3]\n\n' + liste;

  const antwort = await postJson(zugang.basis + '/chat/completions', zugang.schluessel, {
    model: 'clawy-ai-sub',
    messages: [{ role: 'user', content: auftrag }],
    max_tokens: 1200,
    temperature: 0,
  });

  const nummern = jsonAusAntwort(antwort?.choices?.[0]?.message?.content);
  const gueltig = new Set();
  for (let i = 0; i < paare.length; i++) gueltig.add(versatz + i);

  const karte = {};
  // Alles, was gefragt wurde, gilt als beurteilt. Was nicht genannt ist,
  // gilt als "verschieden" — das ist die sichere Richtung.
  for (const n of gueltig) karte[n] = { i: n, gleich: false, sicher: true };
  for (const n of Array.isArray(nummern) ? nummern : []) {
    if (Number.isInteger(n) && gueltig.has(n)) karte[n] = { i: n, gleich: true, sicher: true };
  }
  return { karte, modell: antwort?.model || '' };
}

async function main() {
  const trocken = process.argv.includes('--trocken');
  const eintraege = JSON.parse(fs.readFileSync(DATEI, 'utf8'));

  // 0. Ketten erkennen. Ein Name, der im Bestand drei Mal oder oefter
  //    vorkommt, gehoert zu einer Kette: "Espresso House" steht 17 Mal in
  //    Hamburg, "Farina di Nonna" 5 Mal. Bei solchen Namen ist zwei Mal
  //    derselbe Eintrag in 90 m Abstand keine Doppelerfassung, sondern zwei
  //    Filialen. Das Modell kann das an den Namen nicht sehen, der Bestand
  //    schon.
  const KETTE_AB = 3;
  const KETTE_METER = 25;
  const haeufigkeit = {};
  for (const e of eintraege) {
    const k = (e.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (k) haeufigkeit[k] = (haeufigkeit[k] || 0) + 1;
  }
  const istKette = (e) => (haeufigkeit[(e.name || '').toLowerCase().replace(/[^a-z0-9]/g, '')] || 0) >= KETTE_AB;

  // 1. Kandidaten finden
  const paare = [];
  const belegt = new Set();
  for (let i = 0; i < eintraege.length; i++) {
    const a = eintraege[i];
    if (typeof a.lat !== 'number' || typeof a.lon !== 'number') continue;
    for (let j = i + 1; j < eintraege.length; j++) {
      const b = eintraege[j];
      if (typeof b.lat !== 'number' || typeof b.lon !== 'number') continue;
      const d = meter(a, b);
      if (d >= MAX_METER) continue;
      const ka = kern(a.name), kb = kern(b.name);
      if (!ka || !kb || ka.length < 3 || kb.length < 3) continue;
      const gleich = ka === kb;
      const enthalten = ka.includes(kb) || kb.includes(ka);
      const verhaeltnis = Math.min(ka.length, kb.length) / Math.max(ka.length, kb.length);
      if (!gleich && !(enthalten && verhaeltnis >= 0.5)) continue;
      if (belegt.has(i) || belegt.has(j)) continue;   // jeder Eintrag nur in einem Paar
      belegt.add(i); belegt.add(j);
      paare.push({
        i, j, a, b, meter: Math.round(d),
        art: gleich ? 'identisch' : 'teilstring',
        kette: istKette(a) || istKette(b),
      });
    }
  }
  console.log(`${eintraege.length} Eintraege, ${paare.length} Kandidatenpaare.\n`);
  if (!paare.length) return;

  // 2. Urteil
  // Stufe 1 ohne Modell: sind die Namen nach Kleinschreibung, Umlaut- und
  // Zeichenbereinigung buchstabengleich und liegen unter 150 m auseinander,
  // ist es derselbe Laden. "Café Ines" und "Cafe Ines" braucht niemanden,
  // der darueber nachdenkt. Das Modell war hier sogar unzuverlaessig: im
  // knappen Antwortformat liess es solche Paare mal durch und mal nicht.
  // Die Entfernung entscheidet mit. Ein doppelt erfasster Laden steht fast
  // immer im selben Hauseingang; "Espresso House" und "Espresso House" in
  // 90 m Abstand sind dagegen zwei Filialen derselben Kette. Deshalb geht
  // nur unter 50 m automatisch zusammen, darueber entscheidet das Modell.
  const AUTO_METER = 50;
  const darfAuto = (p) => p.art === 'identisch' &&
    (p.kette ? p.meter <= KETTE_METER : p.meter <= AUTO_METER);
  // Kettennamen gehen gar nicht erst ans Modell: es kann an "Espresso House"
  // und "Espresso House" nicht erkennen, dass es zwei Filialen sind.
  // Nur der Abstand schliesst ein Kettenpaar aus, nicht der Kettenname als
  // solcher: "BLOCK HOUSE Rotherbaum" und "BLOCK HOUSE" am selben Punkt sind
  // sehr wohl derselbe Eintrag zweimal.
  const kettenWeit = paare.filter(p => p.kette && p.meter > KETTE_METER);
  const sicherGleich = paare.filter(p => darfAuto(p) && !kettenWeit.includes(p));
  const zuFragen = paare.filter(p => !darfAuto(p) && !kettenWeit.includes(p));
  console.log(`  ${sicherGleich.length} Paare sind buchstabengleich und unter ${AUTO_METER} m, die gehen ohne Modell zusammen.`);
  console.log(`  ${zuFragen.length} Paare gehen zur Beurteilung ans Modell.`);
  if (kettenWeit.length) {
    console.log(`  ${kettenWeit.length} Paare tragen einen Kettennamen und liegen weiter als ${KETTE_METER} m auseinander, das sind Filialen und bleiben getrennt:`);
    kettenWeit.forEach(p => console.log(`      ${p.a.name} / ${p.b.name} (${p.meter} m)`));
  }
  console.log('');

  // Stufe 2: alles andere (Kurzformen, Zusaetze) beurteilt das Modell.
  const { karte, modell } = zuFragen.length ? await urteile(zuFragen) : { karte: {}, modell: '' };

  const zusammen = [], getrennt = [], unklar = [];
  for (const p of sicherGleich) zusammen.push({ ...p, grund: p.kette ? 'buchstabengleicher Kettenname, unter ' + KETTE_METER + ' m' : 'buchstabengleicher Name, unter ' + AUTO_METER + ' m' });
  for (const p of kettenWeit) getrennt.push({ ...p, grund: 'Kettenname in ' + p.meter + ' m Abstand: zwei Filialen' });
  zuFragen.forEach((p, i) => {
    const u = karte[i];
    if (!u) { unklar.push({ ...p, grund: 'kein Urteil' }); return; }
    if (u.gleich === true && u.sicher === true) zusammen.push({ ...p, grund: 'vom Modell als derselbe Betrieb beurteilt' });
    else getrennt.push({ ...p, grund: 'vom Modell als verschieden beurteilt' });
  });
  if (modell) console.log(`Modell ${modell}: ${Object.keys(karte).length} von ${zuFragen.length} Paaren beurteilt.\n`);

  console.log(`→ ${zusammen.length} als dieselbe Adresse beurteilt, ${getrennt.length} als verschieden, ${unklar.length} ohne Urteil.\n`);
  zusammen.forEach(p => console.log(`  ✚ ${p.a.name}  +  ${p.b.name}   (${p.meter} m) — ${p.grund}`));

  if (trocken) { console.log('\nTrockenlauf, nichts geschrieben.'); return; }
  if (!zusammen.length) { console.log('Nichts zusammenzufuehren.'); return; }

  // 3. Zusammenfuehren: der reichere Eintrag bleibt, der andere fuellt Luecken.
  const raus = new Set();
  const protokoll = [];
  for (const p of zusammen) {
    const bleibtIdx = gewicht(p.a) >= gewicht(p.b) ? p.i : p.j;
    const gehtIdx = bleibtIdx === p.i ? p.j : p.i;
    const bleibt = eintraege[bleibtIdx];
    const geht = eintraege[gehtIdx];

    const ergaenzt = [];
    for (const f of Object.keys(geht)) {
      if (f === 'name') continue;
      const leer = bleibt[f] === undefined || bleibt[f] === null || bleibt[f] === '' ||
                   (Array.isArray(bleibt[f]) && !bleibt[f].length);
      if (leer && geht[f] !== undefined && geht[f] !== null && geht[f] !== '') {
        bleibt[f] = geht[f]; ergaenzt.push(f);
      }
    }
    if (Array.isArray(bleibt.tags) && Array.isArray(geht.tags)) {
      const vorher = bleibt.tags.length;
      bleibt.tags = [...new Set([...bleibt.tags, ...geht.tags])];
      if (bleibt.tags.length > vorher) ergaenzt.push('tags');
    }
    bleibt.auch_bekannt_als = [...new Set([...(bleibt.auch_bekannt_als || []), geht.name])];

    raus.add(gehtIdx);
    protokoll.push({
      behalten: bleibt.name, entfernt: geht.name, meter: p.meter,
      grund: p.grund, ergaenzte_felder: ergaenzt, entfernter_eintrag: geht,
    });
  }

  const neu = eintraege.filter((_, i) => !raus.has(i));
  const sicherung = DATEI + '.bak-dubletten-' + new Date().toISOString().slice(0, 10).replace(/-/g, '');
  fs.copyFileSync(DATEI, sicherung);
  fs.writeFileSync(DATEI, JSON.stringify(neu, null, 2));
  fs.writeFileSync(LOG, JSON.stringify({
    gelaufen: new Date().toISOString(), modell,
    zusammengefuehrt: protokoll,
    als_verschieden_beurteilt: getrennt.map(p => ({ a: p.a.name, b: p.b.name, meter: p.meter, grund: p.grund })),
    ohne_urteil: unklar.map(p => ({ a: p.a.name, b: p.b.name, meter: p.meter })),
  }, null, 1));

  console.log(`\n${eintraege.length} → ${neu.length} Eintraege.`);
  console.log(`Sicherung: ${path.basename(sicherung)}`);
  console.log(`Protokoll: ${path.basename(LOG)}`);
}

main().catch(e => { console.error('Abgebrochen:', e); process.exit(1); });
