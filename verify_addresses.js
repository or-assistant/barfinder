const fs = require('fs');
const https = require('https');

const highlights = JSON.parse(fs.readFileSync('highlights.json', 'utf8'));
const RESULTS_FILE = 'address_verification_2026.json';

// Resume from partial results
let results = [];
let startIdx = 0;
if (fs.existsSync(RESULTS_FILE)) {
  try {
    results = JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8'));
    startIdx = results.length;
    console.log(`Resuming from entry ${startIdx}`);
  } catch(e) {}
}

function fetch(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'BarfinderVerifier/1.0 (oliver@openclaw.com)' } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode === 429) reject(new Error('RATE_LIMITED'));
        else if (res.statusCode >= 500) reject(new Error('SERVER_ERROR'));
        else if (res.statusCode >= 400) reject(new Error(`HTTP ${res.statusCode}`));
        else resolve(data);
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('TIMEOUT')); });
  });
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const RURAL_KEYWORDS = ['Lentföhrden','Ostsee','Timmendorf','Scharbeutz','Travemünde','Niendorf','Grömitz','Heiligenhafen','Eckernförde','Laboe','Kiel','Lübeck','Wedel','Pinneberg','Elmshorn','Bad Segeberg','Neumünster','Kaltenkirchen','Norderstedt','Ahrensburg','Bergedorf'];

function isRural(entry) {
  const text = (entry.address || '') + ' ' + (entry.neighborhood || '') + ' ' + (entry.name || '');
  return RURAL_KEYWORDS.some(k => text.toLowerCase().includes(k.toLowerCase())) || 
         entry.lat < 53.4 || entry.lat > 53.7 || entry.lon < 9.7 || entry.lon > 10.3;
}

let delay = 1100;

async function nominatim(query) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=5&addressdetails=1`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return JSON.parse(await fetch(url));
    } catch(e) {
      if (e.message === 'RATE_LIMITED' || e.message === 'SERVER_ERROR') {
        delay = Math.min(delay + 500, 3000);
        console.log(`  Rate limited/server error, delay now ${delay}ms`);
        await sleep(delay * 2);
      } else if (e.message === 'TIMEOUT') {
        await sleep(2000);
      } else throw e;
    }
  }
  return [];
}

function formatAddr(r) {
  if (!r?.address) return r?.display_name || '';
  const a = r.address;
  return [a.road, a.house_number].filter(Boolean).join(' ') + 
    (a.suburb ? `, ${a.suburb}` : '') +
    (a.city || a.town || a.village ? `, ${a.city || a.town || a.village}` : '');
}

async function processEntry(entry) {
  const rural = isRural(entry);
  const city = rural ? '' : ', Hamburg';
  
  // Primary: search by address (street part)
  const streetAddr = (entry.address || '').replace(/,.*$/, '').trim();
  let data = [];
  
  try {
    if (streetAddr) {
      data = await nominatim(streetAddr + city);
      await sleep(delay);
    }
    
    // If no results, try name + city
    if (data.length === 0) {
      data = await nominatim(entry.name + (rural ? '' : ' Hamburg'));
      await sleep(delay);
    }
  } catch(e) {
    console.log(`  Error searching: ${e.message}`);
  }
  
  const result = {
    name: entry.name,
    status: 'ok',
    current: { lat: entry.lat, lon: entry.lon, address: entry.address || '' },
    found: null,
    distance_diff_m: null,
    action: 'none',
    note: ''
  };
  
  if (data.length === 0) {
    result.status = 'needs_review';
    result.action = 'review';
    result.note = 'Not found on Nominatim';
    return result;
  }
  
  // Find closest match
  let best = null, bestDist = Infinity;
  for (const r of data) {
    const d = haversine(entry.lat, entry.lon, parseFloat(r.lat), parseFloat(r.lon));
    if (d < bestDist) { bestDist = d; best = r; }
  }
  
  result.found = { lat: parseFloat(best.lat), lon: parseFloat(best.lon), address: formatAddr(best) };
  result.distance_diff_m = Math.round(bestDist);
  
  if (bestDist > 200) {
    if (bestDist > 2000) {
      result.status = 'wrong_coords';
      result.action = 'review';
      result.note = `Large distance: ${result.distance_diff_m}m`;
    } else {
      result.status = 'wrong_coords';
      result.action = 'fix_coords';
      result.note = `Distance ${result.distance_diff_m}m`;
    }
  }
  
  return result;
}

async function main() {
  console.log(`Processing ${highlights.length} entries (starting from ${startIdx})...`);
  
  for (let i = startIdx; i < highlights.length; i++) {
    const entry = highlights[i];
    process.stdout.write(`[${i+1}/${highlights.length}] ${entry.name}... `);
    
    const result = await processEntry(entry);
    results.push(result);
    
    console.log(`${result.status} ${result.distance_diff_m !== null ? `(${result.distance_diff_m}m)` : ''}`);
    
    if ((results.length % 20) === 0) {
      fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
      console.log(`  --- Saved ${results.length} entries ---`);
    }
  }
  
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
  
  // Auto-fix
  let fixed = 0;
  for (const r of results) {
    if (r.action === 'fix_coords' && r.found) {
      const entry = highlights.find(h => h.name === r.name);
      if (entry) {
        entry.lat = r.found.lat;
        entry.lon = r.found.lon;
        fixed++;
      }
    }
  }
  
  if (fixed > 0) {
    fs.writeFileSync('highlights.json', JSON.stringify(highlights, null, 2));
  }
  
  // Summary
  const ok = results.filter(r => r.status === 'ok').length;
  const fixedCoords = results.filter(r => r.action === 'fix_coords').length;
  const review = results.filter(r => r.action === 'review').length;
  
  console.log(`\n=== SUMMARY ===`);
  console.log(`Total: ${results.length}`);
  console.log(`OK: ${ok}`);
  console.log(`Fixed coords: ${fixedCoords}`);
  console.log(`Needs review: ${review}`);
  
  const reviewItems = results.filter(r => r.action === 'review');
  if (reviewItems.length > 0) {
    console.log(`\n=== NEEDS REVIEW ===`);
    for (const r of reviewItems) {
      console.log(`- ${r.name}: ${r.note} (${r.distance_diff_m !== null ? r.distance_diff_m + 'm' : 'no match'})`);
    }
  }
}

main().catch(console.error);
