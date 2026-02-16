const fs = require('fs');
const https = require('https');
const http = require('http');

const areas = [
  { name: "Sternschanze/Karoviertel", bbox: "53.556,9.955,53.572,9.975" },
  { name: "Ottensen/Altona", bbox: "53.545,9.915,53.560,9.945" },
  { name: "St. Georg", bbox: "53.548,10.005,53.560,10.020" },
  { name: "Eimsbüttel", bbox: "53.565,9.940,53.580,9.970" },
  { name: "St. Pauli/Reeperbahn", bbox: "53.545,9.950,53.558,9.975" },
  { name: "Neustadt/Innenstadt", bbox: "53.545,9.975,53.558,10.005" },
  { name: "Barmbek", bbox: "53.575,10.030,53.590,10.055" },
  { name: "Rotherbaum", bbox: "53.560,9.975,53.575,9.995" },
];

const categoryMap = {
  restaurant: "restaurant",
  bar: "bar",
  pub: "pub",
  cafe: "cafe",
  fast_food: "mittagstisch",
  biergarten: "biergarten",
  nightclub: "nightclub",
};

function fetchOverpass(bbox) {
  const query = `[out:json][timeout:30];(node[amenity~"restaurant|bar|pub|cafe|fast_food|biergarten|nightclub"](${bbox});way[amenity~"restaurant|bar|pub|cafe|fast_food|biergarten|nightclub"](${bbox}););out center;`;
  const url = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`;
  
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  // Load existing highlights
  const highlights = JSON.parse(fs.readFileSync('/home/openclaw/.openclaw/workspace/barfinder/highlights.json', 'utf8'));
  const existingNames = new Set(highlights.map(h => (h.name || '').toLowerCase().trim()));
  
  const allNew = [];
  const stats = {};

  for (const area of areas) {
    console.log(`Fetching ${area.name}...`);
    try {
      const result = await fetchOverpass(area.bbox);
      const elements = result.elements || [];
      let newCount = 0;
      
      for (const el of elements) {
        const tags = el.tags || {};
        const name = tags.name;
        if (!name) continue;
        
        const amenity = tags.amenity;
        const category = categoryMap[amenity];
        if (!category) continue;
        
        if (existingNames.has(name.toLowerCase().trim())) continue;
        
        const lat = el.type === 'way' ? (el.center?.lat || null) : el.lat;
        const lon = el.type === 'way' ? (el.center?.lon || null) : el.lon;
        
        const street = tags['addr:street'] || '';
        const housenumber = tags['addr:housenumber'] || '';
        const address = street && housenumber ? `${street} ${housenumber}` : street || '';
        
        const entry = {
          name,
          lat,
          lon,
          address: address ? `${address}, ${area.name}` : area.name,
          category,
          cuisine: tags.cuisine || null,
          source: "overpass",
          area: area.name,
          created_at: new Date().toISOString(),
        };
        
        allNew.push(entry);
        existingNames.add(name.toLowerCase().trim()); // prevent dupes across areas
        newCount++;
      }
      
      stats[area.name] = { total: elements.length, new: newCount };
      console.log(`  ${area.name}: ${elements.length} total, ${newCount} new`);
    } catch(e) {
      console.error(`  Error for ${area.name}: ${e.message}`);
      stats[area.name] = { error: e.message };
    }
    
    await sleep(1500); // rate limit
  }

  fs.writeFileSync('/home/openclaw/.openclaw/workspace/barfinder/citywide_crawl.json', JSON.stringify(allNew, null, 2));
  
  console.log('\n=== SUMMARY ===');
  let totalNew = 0;
  for (const [area, s] of Object.entries(stats)) {
    if (s.error) { console.log(`${area}: ERROR - ${s.error}`); }
    else { console.log(`${area}: ${s.new} neue von ${s.total} gesamt`); totalNew += s.new; }
  }
  console.log(`\nGESAMT: ${totalNew} neue Einträge → citywide_crawl.json`);
}

main().catch(console.error);
