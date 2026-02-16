const fs = require('fs');
const https = require('https');

const areas = [
  { name: "Eimsbüttel", bbox: "53.565,9.940,53.580,9.970" },
  { name: "Neustadt/Innenstadt", bbox: "53.545,9.975,53.558,10.005" },
  { name: "Barmbek", bbox: "53.575,10.030,53.590,10.055" },
];

const categoryMap = {
  restaurant: "restaurant", bar: "bar", pub: "pub", cafe: "cafe",
  fast_food: "mittagstisch", biergarten: "biergarten", nightclub: "nightclub",
};

function fetchOverpass(bbox) {
  const query = `[out:json][timeout:30];(node[amenity~"restaurant|bar|pub|cafe|fast_food|biergarten|nightclub"](${bbox});way[amenity~"restaurant|bar|pub|cafe|fast_food|biergarten|nightclub"](${bbox}););out center;`;
  const url = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`;
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (data.startsWith('<')) reject(new Error('Rate limited (XML response)'));
        else try { resolve(JSON.parse(data)); } catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const existing = JSON.parse(fs.readFileSync('/home/openclaw/.openclaw/workspace/barfinder/citywide_crawl.json', 'utf8'));
  const highlights = JSON.parse(fs.readFileSync('/home/openclaw/.openclaw/workspace/barfinder/highlights.json', 'utf8'));
  const existingNames = new Set([
    ...highlights.map(h => (h.name || '').toLowerCase().trim()),
    ...existing.map(h => (h.name || '').toLowerCase().trim()),
  ]);

  const newEntries = [];
  for (let i = 0; i < areas.length; i++) {
    const area = areas[i];
    if (i > 0) await sleep(5000); // longer delay
    console.log(`Fetching ${area.name}...`);
    try {
      const result = await fetchOverpass(area.bbox);
      const elements = result.elements || [];
      let nc = 0;
      for (const el of elements) {
        const tags = el.tags || {};
        if (!tags.name) continue;
        const cat = categoryMap[tags.amenity];
        if (!cat) continue;
        if (existingNames.has(tags.name.toLowerCase().trim())) continue;
        const lat = el.type === 'way' ? el.center?.lat : el.lat;
        const lon = el.type === 'way' ? el.center?.lon : el.lon;
        const street = tags['addr:street'] || '';
        const hn = tags['addr:housenumber'] || '';
        const addr = street && hn ? `${street} ${hn}` : street || '';
        newEntries.push({ name: tags.name, lat, lon, address: addr ? `${addr}, ${area.name}` : area.name, category: cat, cuisine: tags.cuisine || null, source: "overpass", area: area.name, created_at: new Date().toISOString() });
        existingNames.add(tags.name.toLowerCase().trim());
        nc++;
      }
      console.log(`  ${area.name}: ${elements.length} total, ${nc} new`);
    } catch(e) {
      console.error(`  Error: ${e.message}`);
    }
  }

  // Merge with existing crawl
  const merged = [...existing, ...newEntries];
  fs.writeFileSync('/home/openclaw/.openclaw/workspace/barfinder/citywide_crawl.json', JSON.stringify(merged, null, 2));
  console.log(`Added ${newEntries.length} more. Total now: ${merged.length}`);
}
main().catch(console.error);
