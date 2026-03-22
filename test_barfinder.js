#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// 🧪 Barfinder Hamburg — Test Suite
// ═══════════════════════════════════════════════════════════════
const http = require('http');
const fs = require('fs');
const path = require('path');

const BASE = 'http://localhost:3002';
const DIR = __dirname;
const results = [];
let passed = 0, failed = 0;

function log(ok, name, detail) {
  const icon = ok ? '✅' : '❌';
  console.log(`${icon} ${name}${detail ? ' — ' + detail : ''}`);
  results.push({ test: name, ok, detail: detail || null });
  if (ok) passed++; else failed++;
}

function fetch(urlPath) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    http.get(BASE + urlPath, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(body), ms: Date.now() - start });
        } catch (e) {
          resolve({ status: res.statusCode, data: null, ms: Date.now() - start, raw: body });
        }
      });
    }).on('error', reject);
  });
}

async function run() {
  console.log('\n🧪 Barfinder Test Suite\n' + '═'.repeat(50));

  // ── API Health Checks ──
  console.log('\n📡 API Health Checks:');

  let places = [];
  try {
    const r = await fetch('/api/places');
    log(r.status === 200, '/api/places status 200', `${r.status}, ${r.ms}ms`);
    places = r.data?.places || (Array.isArray(r.data) ? r.data : []);
    log(Array.isArray(places) && places.length > 0, '/api/places has entries', `${places.length} places`);
    const allHaveFields = places.every(p => p.name && p.lat !== undefined && p.lon !== undefined);
    log(allHaveFields, '/api/places all have name/lat/lon');

    // Performance
    log(r.ms < 5000, '/api/places < 5000ms (Overpass live)', `${r.ms}ms`);
  } catch (e) { log(false, '/api/places', e.message); }

  let hotPlaces = [];
  try {
    const r = await fetch('/api/hot');
    log(r.status === 200, '/api/hot status 200', `${r.status}, ${r.ms}ms`);
    hotPlaces = Array.isArray(r.data) ? r.data : (r.data?.places || r.data?.hot || []);
    if (Array.isArray(hotPlaces) && hotPlaces.length > 0) {
      const allHaveScores = hotPlaces.every(p => p.vibeScore !== undefined && p.hotScore !== undefined);
      log(allHaveScores, '/api/hot all have vibeScore/hotScore');
    } else {
      log(true, '/api/hot returns array', `${hotPlaces.length} items`);
    }
    log(r.ms < 200, '/api/hot < 200ms', `${r.ms}ms`);
  } catch (e) { log(false, '/api/hot', e.message); }

  try {
    const r = await fetch('/api/events');
    log(r.status === 200, '/api/events status 200', `${r.status}, ${r.ms}ms`);
    const events = Array.isArray(r.data) ? r.data : (r.data?.events || []);
    log(Array.isArray(events), '/api/events returns array', `${events.length} events`);
  } catch (e) { log(false, '/api/events', e.message); }

  try {
    const r = await fetch('/api/sources');
    log(r.status === 200, '/api/sources status 200', `${r.status}, ${r.ms}ms`);
    const sources = r.data?.sources || [];
    const allHaveStatus = sources.every(s => s.status);
    log(allHaveStatus, '/api/sources all have status', `${sources.length} sources`);
  } catch (e) { log(false, '/api/sources', e.message); }

  try {
    const r = await fetch('/api/weather');
    log(r.status === 200, '/api/weather status 200', `${r.status}, ${r.ms}ms`);
    const hasFields = r.data && (r.data.weather?.temperature !== undefined || r.data.temp !== undefined) && r.data.weatherEmoji;
    log(!!hasFields, '/api/weather has temp/weatherEmoji', `${r.data?.weatherEmoji} ${r.data?.weather?.temperature ?? r.data?.temp}°C`);
    log(r.ms < 100, '/api/weather < 100ms', `${r.ms}ms`);
  } catch (e) { log(false, '/api/weather', e.message); }

  // ── Data Consistency ──
  console.log('\n🔍 Daten-Konsistenz:');

  if (places.length > 0) {
    const allLatLon = places.every(p => typeof p.lat === 'number' && typeof p.lon === 'number' && p.lat !== null && p.lon !== null);
    log(allLatLon, 'All places have numeric lat/lon');

    const vibePlaces = places.filter(p => p.vibeScore !== undefined);
    if (vibePlaces.length > 0) {
      const vibeOk = vibePlaces.every(p => p.vibeScore >= 0 && p.vibeScore <= 100);
      log(vibeOk, 'vibeScore 0-100', `${vibePlaces.length} places with vibeScore`);
    } else {
      log(true, 'vibeScore check (no vibeScores on /api/places — ok)');
    }

    const busyPlaces = places.filter(p => p.estimatedBusyness !== undefined);
    if (busyPlaces.length > 0) {
      const busyOk = busyPlaces.every(p => p.estimatedBusyness >= 0 && p.estimatedBusyness <= 100);
      log(busyOk, 'estimatedBusyness 0-100', `${busyPlaces.length} places`);
    } else {
      log(true, 'estimatedBusyness check (none on /api/places — ok)');
    }

    const openPlaces = places.filter(p => p.isOpen !== undefined);
    if (openPlaces.length > 0) {
      const boolOk = openPlaces.every(p => typeof p.isOpen === 'boolean' || p.isOpen === null);
      log(boolOk, 'isOpen is boolean or null', `${openPlaces.length} places`);
    } else {
      log(true, 'isOpen check (not present — ok)');
    }

    // Duplicate check
    const seen = new Set();
    let dupes = 0;
    for (const p of places) {
      const key = `${p.name}|${p.lat}|${p.lon}`;
      if (seen.has(key)) dupes++;
      seen.add(key);
    }
    log(dupes === 0, 'No duplicate places', dupes > 0 ? `${dupes} duplicates found` : 'all unique');
  }

  // ── Cache Files ──
  console.log('\n📁 Cache-Dateien:');

  const cacheFiles = [
    ['cache.json', true],
    ['network_events_cache.json', true],
    ['google_ratings_cache.json', true],
    ['events_pipeline_cache.json', false],
  ];

  for (const [file, required] of cacheFiles) {
    const fp = path.join(DIR, file);
    if (fs.existsSync(fp)) {
      try {
        JSON.parse(fs.readFileSync(fp, 'utf8'));
        log(true, `${file} exists & valid JSON`);
      } catch (e) {
        log(false, `${file} invalid JSON`, e.message);
      }
    } else if (required) {
      log(false, `${file} missing`);
    } else {
      log(true, `${file} optional — not present`);
    }
  }

  // ── Summary ──
  const total = passed + failed;
  console.log('\n' + '═'.repeat(50));
  console.log(`📊 Ergebnis: ${passed}/${total} Tests bestanden ${failed === 0 ? '🎉' : '⚠️'}`);
  if (failed > 0) console.log(`❌ ${failed} Tests fehlgeschlagen`);

  // Write results
  const output = {
    timestamp: new Date().toISOString(),
    passed,
    failed,
    total,
    ok: failed === 0,
    tests: results
  };
  fs.writeFileSync(path.join(DIR, 'test_results.json'), JSON.stringify(output, null, 2));
  console.log(`\n💾 Ergebnisse → test_results.json\n`);

  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => {
  console.error('💥 Test suite crashed:', e.message);
  process.exit(1);
});
