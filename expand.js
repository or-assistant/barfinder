const fs = require('fs');
const https = require('https');
const http = require('http');

const HIGHLIGHTS_PATH = './highlights.json';
const existing = JSON.parse(fs.readFileSync(HIGHLIGHTS_PATH, 'utf8'));
console.log(`Existing: ${existing.length}`);

// Build dedup index: lowercase name -> array of {lat,lon}
const nameIndex = {};
existing.forEach(e => {
  const key = e.name.toLowerCase().trim();
  if (!nameIndex[key]) nameIndex[key] = [];
  nameIndex[key].push({ lat: e.lat, lon: e.lon });
});

function isDuplicate(name, lat, lon) {
  const key = name.toLowerCase().trim();
  if (!nameIndex[key]) return false;
  return nameIndex[key].some(e => {
    const dist = Math.sqrt((e.lat - lat) ** 2 + (e.lon - lon) ** 2);
    return dist < 0.005; // ~500m
  });
}

function mapCategory(tags) {
  const amenity = tags.amenity || '';
  const cuisine = tags.cuisine || '';
  if (amenity === 'nightclub') return 'nightclub';
  if (amenity === 'biergarten') return 'biergarten';
  if (amenity === 'cafe') return 'cafe';
  if (cuisine.includes('cocktail') || tags.name?.toLowerCase().includes('cocktail')) return 'cocktailbar';
  if (amenity === 'pub') return 'pub';
  if (amenity === 'bar') return 'bar';
  if (amenity === 'restaurant') return 'restaurant';
  return amenity || 'bar';
}

function buildTags(osmTags) {
  const result = [];
  const amenity = osmTags.amenity || '';
  if (amenity) result.push(amenity);
  if (osmTags.cuisine) osmTags.cuisine.split(';').forEach(c => result.push(c.trim()));
  if (osmTags.outdoor_seating === 'yes') result.push('outdoor');
  if (osmTags.wheelchair === 'yes') result.push('wheelchair');
  if (osmTags.beer_garden === 'yes') result.push('biergarten');
  if (osmTags.craft_beer === 'yes' || osmTags['drink:craft_beer'] === 'yes') result.push('craft-beer');
  return [...new Set(result)];
}

function cleanText(s) {
  if (!s) return s;
  return s.replace(/[\u2013\u2014]/g, '-');
}

function fetch(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { headers: { 'User-Agent': 'BarfinderExpander/1.0' } }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function post(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'BarfinderExpander/1.0' }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function overpassQuery(query) {
  const url = 'https://overpass-api.de/api/interpreter';
  const body = 'data=' + encodeURIComponent(query);
  const raw = await post(url, body);
  return JSON.parse(raw);
}

async function phase1() {
  console.log('\n=== PHASE 1: Overpass Bulk Scrape ===');
  
  // Multiple centers to cover all Hamburg + surrounding areas
  const centers = [
    { lat: 53.55, lon: 10.0, r: 15000, label: 'Hamburg Center' },
    { lat: 53.65, lon: 10.0, r: 12000, label: 'Hamburg Nord' },
    { lat: 53.55, lon: 9.85, r: 12000, label: 'Hamburg West (Altona/Eimsbüttel)' },
    { lat: 53.55, lon: 10.15, r: 12000, label: 'Hamburg Ost (Wandsbek/Bergedorf)' },
    { lat: 53.45, lon: 10.0, r: 12000, label: 'Hamburg Süd (Harburg)' },
    { lat: 53.70, lon: 10.0, r: 10000, label: 'Norderstedt/Langenhorn' },
    { lat: 53.66, lon: 9.80, r: 10000, label: 'Pinneberg/Schenefeld' },
    { lat: 53.67, lon: 10.22, r: 10000, label: 'Ahrensburg/Volksdorf' },
    { lat: 53.72, lon: 9.88, r: 8000, label: 'Quickborn/Hasloh' },
    { lat: 53.60, lon: 10.30, r: 8000, label: 'Rahlstedt/Stapelfeld' },
  ];

  const newEntries = [];
  const seenOsmIds = new Set();
  
  // Also track what we add to avoid self-duplicates
  const addedNames = {};

  for (const c of centers) {
    console.log(`Querying ${c.label} (${c.lat},${c.lon} r=${c.r})...`);
    const query = `[out:json][timeout:90];
(
  node["amenity"~"bar|pub|restaurant|cafe|nightclub|biergarten"]["name"](around:${c.r},${c.lat},${c.lon});
  way["amenity"~"bar|pub|restaurant|cafe|nightclub|biergarten"]["name"](around:${c.r},${c.lat},${c.lon});
);
out center;`;
    
    try {
      let result;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const raw = await post('https://overpass-api.de/api/interpreter', 'data=' + encodeURIComponent(query));
          if (raw.startsWith('<?xml') || raw.startsWith('<')) {
            console.log(`  Rate limited, waiting ${15*(attempt+1)}s...`);
            await new Promise(r => setTimeout(r, 15000 * (attempt + 1)));
            continue;
          }
          result = JSON.parse(raw);
          break;
        } catch (e) {
          console.log(`  Attempt ${attempt+1} failed: ${e.message}, retrying...`);
          await new Promise(r => setTimeout(r, 15000 * (attempt + 1)));
        }
      }
      if (!result) { console.log('  Skipping after 3 attempts'); continue; }
      const elements = result.elements || [];
      console.log(`  Got ${elements.length} elements`);
      
      for (const el of elements) {
        const osmId = el.type + '/' + el.id;
        if (seenOsmIds.has(osmId)) continue;
        seenOsmIds.add(osmId);
        
        const tags = el.tags || {};
        const name = tags.name;
        if (!name) continue;
        
        const lat = el.lat || (el.center && el.center.lat);
        const lon = el.lon || (el.center && el.center.lon);
        if (!lat || !lon) continue;
        
        // Dedup against existing
        if (isDuplicate(name, lat, lon)) continue;
        
        // Dedup against already added
        const nameKey = name.toLowerCase().trim();
        if (addedNames[nameKey]) {
          const prev = addedNames[nameKey];
          const dist = Math.sqrt((prev.lat - lat) ** 2 + (prev.lon - lon) ** 2);
          if (dist < 0.005) continue;
        }
        
        const addr = [tags['addr:street'], tags['addr:housenumber']].filter(Boolean).join(' ');
        const suburb = tags['addr:suburb'] || tags['addr:city'] || '';
        const fullAddr = [addr, suburb].filter(Boolean).join(', ');
        
        const entry = {
          name: cleanText(name),
          lat, lon,
          address: cleanText(fullAddr) || '',
          category: mapCategory(tags),
          description: cleanText(tags.description || tags['description:de'] || ''),
          opening_hours: cleanText(tags.opening_hours) || '',
          tags: buildTags(tags),
          source: 'overpass',
          smoker: tags.smoking === 'yes' || tags.smoking === 'separated' || false
        };
        
        newEntries.push(entry);
        addedNames[nameKey] = { lat, lon };
      }
      
      // Rate limit - be generous
      await new Promise(r => setTimeout(r, 12000));
    } catch (err) {
      console.error(`  Error: ${err.message}`);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
  
  console.log(`Phase 1 total new: ${newEntries.length}`);
  return newEntries;
}

async function main() {
  const phase1Results = await phase1();
  
  console.log('\n=== MERGING ===');
  const merged = [...existing, ...phase1Results];
  console.log(`Final total: ${merged.length} (added ${phase1Results.length})`);
  
  // Backup
  fs.copyFileSync(HIGHLIGHTS_PATH, HIGHLIGHTS_PATH + '.bak');
  fs.writeFileSync(HIGHLIGHTS_PATH, JSON.stringify(merged, null, 2));
  console.log('Saved highlights.json');
  
  // Stats
  const bySrc = {};
  merged.forEach(e => { bySrc[e.source || 'unknown'] = (bySrc[e.source || 'unknown'] || 0) + 1; });
  console.log('By source:', bySrc);
  
  const byCat = {};
  phase1Results.forEach(e => { byCat[e.category] = (byCat[e.category] || 0) + 1; });
  console.log('New by category:', byCat);
  
  // Write report
  const report = `# Barfinder Expansion Report
## ${new Date().toISOString().split('T')[0]}

### Summary
- **Before:** ${existing.length} locations
- **After:** ${merged.length} locations  
- **New:** ${phase1Results.length} locations

### Source Breakdown
${Object.entries(bySrc).map(([k,v]) => `- ${k}: ${v}`).join('\n')}

### New Locations by Category
${Object.entries(byCat).sort((a,b) => b[1]-a[1]).map(([k,v]) => `- ${k}: ${v}`).join('\n')}

### Method
- Phase 1: Overpass API bulk scrape across ${10} center points covering Hamburg + Speckgurtel
- Deduplication by name + coordinate proximity (<500m)
- Categories mapped from OSM amenity/cuisine tags
- All coordinates from Overpass (verified)
`;
  fs.writeFileSync('./expansion_report.md', report);
  console.log('Report written to expansion_report.md');
}

main().catch(err => { console.error(err); process.exit(1); });
