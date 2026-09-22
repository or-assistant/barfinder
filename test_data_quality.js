#!/usr/bin/env node
// Barfinder Data Quality Test Suite
const fs = require('fs');
const http = require('http');

const results = { passed: 0, failed: 0, warnings: 0, tests: [] };

function test(name, fn) {
  try {
    const r = fn();
    if (r === true || r === undefined) { results.passed++; results.tests.push({ name, status: 'pass' }); }
    else { results.failed++; results.tests.push({ name, status: 'fail', detail: r }); }
  } catch (e) { results.failed++; results.tests.push({ name, status: 'error', detail: e.message }); }
}

function warn(name, msg) { results.warnings++; results.tests.push({ name, status: 'warn', detail: msg }); }

const highlights = JSON.parse(fs.readFileSync('highlights.json', 'utf8'));

// 1. Valid coordinates
test('All bars have valid lat/lon', () => {
  const bad = highlights.filter(h => !h.lat || !h.lon || h.lat < 53.3 || h.lat > 54.8 || h.lon < 9.5 || h.lon > 10.5);
  return bad.length === 0 || `${bad.length} bars with invalid coords: ${bad.map(b=>b.name).join(', ')}`;
});

// 2. No duplicate names
// Gleicher Name an verschiedenen Adressen ist keine Dublette, sondern eine
// Kette (Starbucks, Jim Block, Block House). Nur derselbe Name im Umkreis
// von 150 m meint wirklich denselben Laden.
test('No duplicate names', () => {
  const nachName = new Map();
  for (const h of highlights) {
    const k = (h.name || '').toLowerCase().trim();
    if (!k) continue;
    if (!nachName.has(k)) nachName.set(k, []);
    nachName.get(k).push(h);
  }
  const echte = [];
  for (const [name, liste] of nachName) {
    if (liste.length < 2) continue;
    for (let i = 0; i < liste.length; i++) {
      for (let j = i + 1; j < liste.length; j++) {
        const d = Math.sqrt((liste[i].lat - liste[j].lat) ** 2 + (liste[i].lon - liste[j].lon) ** 2) * 111000;
        if (d < 150) { echte.push(`${name} (${Math.round(d)}m)`); i = liste.length; break; }
      }
    }
  }
  return echte.length === 0 || `${echte.length} echte Dubletten: ${echte.slice(0, 12).join(', ')}`;
});

// 3. No duplicate coordinates (within 10m)
test('No duplicate coordinates (<10m)', () => {
  const dupes = [];
  for (let i = 0; i < highlights.length; i++) {
    for (let j = i + 1; j < highlights.length; j++) {
      const d = Math.sqrt((highlights[i].lat - highlights[j].lat) ** 2 + (highlights[i].lon - highlights[j].lon) ** 2) * 111000;
      if (d < 10) dupes.push(`${highlights[i].name} <-> ${highlights[j].name} (${Math.round(d)}m)`);
    }
  }
  return dupes.length === 0 || `${dupes.length} dupes: ${dupes.slice(0, 5).join('; ')}`;
});

// 4. Valid categories
test('All categories are valid', () => {
  const valid = new Set(['pub', 'irish-pub', 'cocktailbar', 'bar', 'wine', 'lounge', 'biergarten', 'nightclub', 'sports_bar', 'karaoke', 'jazz_club', 'brewery', 'taproom', 'dance_club', 'cafe', 'restaurant',
    // seit der Erweiterung um Tagesgastronomie und Spielstaetten ebenfalls gueltig
    'mittagstisch', 'fruehstueck', 'event-location']);
  const bad = highlights.filter(h => !valid.has(h.category));
  return bad.length === 0 || `Invalid cats: ${bad.map(b => `${b.name}(${b.category})`).join(', ')}`;
});

// 5. Addresses non-empty
test('All bars have addresses', () => {
  const bad = highlights.filter(h => !h.address || h.address.trim().length < 3);
  return bad.length === 0 || `${bad.length} missing addresses: ${bad.map(b=>b.name).join(', ')}`;
});

// 6. Opening hours format (basic check)
test('Opening hours format valid', () => {
  // Die Pruefung verlangte frueher, dass die Angabe mit einem Wochentag
  // beginnt. Die OSM-Schreibweise laesst aber auch "24/7", eine Monatsspanne
  // ("May-Oct Mo-Sa 11:30+"), eine reine Uhrzeit ("08:30-22:00") und offene
  // Enden ("12:00+") zu. Das waren 263 Fehlalarme. Gemeldet wird jetzt nur
  // noch, was wirklich unlesbar ist.
  const MONAT = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)';
  const gueltig = new RegExp(
    '^\\s*(?:' +
      '24/7' +
      '|(?:Mo|Tu|We|Th|Fr|Sa|Su|PH|SH)\\b' +
      '|' + MONAT + '\\b' +
      '|\\d{1,2}:\\d{2}' +
      '|off\\b' +
      '|week\\b' +
    ')', 'i');
  const bad = highlights.filter(h => {
    const z = (h.opening_hours || '').trim().replace(/^"|"$/g, '');
    return z !== '' && !gueltig.test(z);
  });
  return bad.length === 0 || `${bad.length} unlesbar: ${bad.slice(0,5).map(b=>`${b.name}: "${b.opening_hours}"`).join('; ')}`;
});

// 7. No bars with vibeScore > 60 on Sun/Mon (API check)
async function apiTest(name, url, check) {
  return new Promise(resolve => {
    http.get(url, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const d = JSON.parse(data);
          const r = check(d);
          if (r === true) { results.passed++; results.tests.push({ name, status: 'pass' }); }
          else { results.failed++; results.tests.push({ name, status: 'fail', detail: r }); }
        } catch (e) { results.failed++; results.tests.push({ name, status: 'error', detail: e.message }); }
        resolve();
      });
    }).on('error', e => { results.failed++; results.tests.push({ name, status: 'error', detail: e.message }); resolve(); });
  });
}

async function run() {
  // API tests
  await apiTest('API /api/places responds', 'http://localhost:3002/api/places?lat=53.5775&lon=9.9785&radius=3000', d => {
    return d.count > 0 || `count=${d.count}`;
  });

  await apiTest('API /api/hot responds', 'http://localhost:3002/api/hot?lat=53.5775&lon=9.9785&radius=3000', d => {
    return Array.isArray(d) && d.length > 0 || `not array or empty`;
  });

  await apiTest('API /api/events responds', 'http://localhost:3002/api/events', d => {
    return (d && (Array.isArray(d) || typeof d === 'object')) || `invalid response`;
  });

  await apiTest('Vibe scores in range 0-100', 'http://localhost:3002/api/places?lat=53.5775&lon=9.9785&radius=5000', d => {
    const bad = d.places.filter(p => p.vibeScore < 0 || p.vibeScore > 100);
    return bad.length === 0 || `${bad.length} out of range`;
  });

  await apiTest('Max 200 results returned', 'http://localhost:3002/api/places?lat=53.5775&lon=9.9785&radius=25000', d => {
    return d.count <= 200 || `count=${d.count}`;
  });

  // Terminbestand. Die alten Scraper-Caches (google_ratings, bar_events,
  // events) sind mit den Scrapern aus dem Projekt verschwunden und wurden
  // hier jahrelang als Fehler gemeldet, obwohl sie gar nicht mehr vorgesehen
  // sind. Gepruft wird jetzt, was tatsaechlich den Feed traegt.
  test('live_events_cache.json vorhanden und frisch', () => {
    if (!fs.existsSync('live_events_cache.json')) return 'Datei fehlt — laeuft der Sammler?';
    const j = JSON.parse(fs.readFileSync('live_events_cache.json', 'utf8'));
    const alter = (Date.now() - Date.parse(j.generiert)) / 3600000;
    if (!(alter < 48)) return `Stand ist ${Math.round(alter)} Stunden alt`;
    if (!j.anzahl) return 'keine Termine im Bestand';
    return true;
  });

  test('Mindestens zwei Terminquellen liefern', () => {
    if (!fs.existsSync('live_events_cache.json')) return 'Datei fehlt';
    const j = JSON.parse(fs.readFileSync('live_events_cache.json', 'utf8'));
    const ok = Object.entries(j.quellen || {}).filter(([, v]) => v.ok && v.anzahl > 0);
    const tot = Object.entries(j.quellen || {}).filter(([, v]) => !v.ok).map(([k]) => k);
    return ok.length >= 2 || `nur ${ok.length} Quelle(n) liefern${tot.length ? ', tot: ' + tot.join(', ') : ''}`;
  });

  // Summary
  console.log(`\n📊 Data Quality Test Results`);
  console.log(`✅ Passed: ${results.passed}`);
  console.log(`❌ Failed: ${results.failed}`);
  console.log(`⚠️ Warnings: ${results.warnings}`);
  console.log('');
  for (const t of results.tests) {
    const icon = t.status === 'pass' ? '✅' : t.status === 'warn' ? '⚠️' : '❌';
    console.log(`  ${icon} ${t.name}${t.detail ? ` — ${t.detail}` : ''}`);
  }

  fs.writeFileSync('test_data_quality_results.json', JSON.stringify(results, null, 2));
  console.log(`\nResults saved to test_data_quality_results.json`);
  process.exit(results.failed > 0 ? 1 : 0);
}

run();
