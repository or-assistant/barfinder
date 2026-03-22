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
test('No duplicate names', () => {
  const names = highlights.map(h => h.name.toLowerCase());
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  return dupes.length === 0 || `Duplicates: ${[...new Set(dupes)].join(', ')}`;
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
  const valid = new Set(['pub', 'irish-pub', 'cocktailbar', 'bar', 'wine', 'lounge', 'biergarten', 'nightclub', 'sports_bar', 'karaoke', 'jazz_club', 'brewery', 'taproom', 'dance_club', 'cafe', 'restaurant']);
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
  const bad = highlights.filter(h => h.opening_hours && !/^(Mo|Tu|We|Th|Fr|Sa|Su|PH)/.test(h.opening_hours) && h.opening_hours !== '');
  return bad.length === 0 || `${bad.length} bad formats: ${bad.slice(0,5).map(b=>`${b.name}: "${b.opening_hours}"`).join('; ')}`;
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

  // Cache file checks
  const cacheFiles = ['google_ratings_cache.json', 'bar_events_cache.json', 'events_cache.json'];
  for (const cf of cacheFiles) {
    test(`Cache ${cf} is valid JSON`, () => {
      if (!fs.existsSync(cf)) return `File not found`;
      JSON.parse(fs.readFileSync(cf, 'utf8'));
      return true;
    });
  }

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
