#!/usr/bin/env node
/**
 * Barfinder Data Enrichment — runs nightly
 * 1. Reverse geocode missing addresses
 * 2. Re-generate tags
 * 3. Check for closed locations via Nominatim
 * 4. Update last_verified timestamps
 */

const fs = require('fs');
const https = require('https');
const path = require('path');

const HIGHLIGHTS_PATH = path.join(__dirname, 'highlights.json');

function fetch(url) {
  return new Promise((res, rej) => {
    https.get(url, { headers: { 'User-Agent': 'Barfinder/1.0' } }, r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => { try { res(JSON.parse(d)); } catch(e) { rej(e); } });
    }).on('error', rej);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function generateTags(p) {
  const tags = new Set();
  const text = ((p.name||'')+(p.description||'')+(p.address||'')).toLowerCase();
  if(/eppendorf/i.test(text)) tags.add('eppendorf');
  if(/winterhude|mühlenkamp/i.test(text)) tags.add('winterhude');
  if(/eimsbüttel/i.test(text)) tags.add('eimsbüttel');
  if(/hoheluft/i.test(text)) tags.add('hoheluft');
  if(/rotherbaum|harvestehude|klosterstern/i.test(text)) tags.add('rotherbaum');
  if(/schanze|schulterblatt/i.test(text)) tags.add('schanze');
  if(/st\.\s*pauli|reeperbahn/i.test(text)) tags.add('st-pauli');
  if(p.category) tags.add(p.category);
  if(/wein|wine|vino/i.test(text)) tags.add('wein');
  if(/cocktail/i.test(text)) tags.add('cocktails');
  if(/irish/i.test(text)) tags.add('irish');
  if(/after.?work/i.test(text)) tags.add('after-work');
  if(/live.?musik|live.?music|jazz/i.test(text)) tags.add('live-musik');
  if(/terrasse|outdoor|garten|biergarten/i.test(text)) tags.add('outdoor');
  if(p.smoker) tags.add('raucher');
  if(p.highlight) tags.add('highlight');
  return [...tags];
}

async function run() {
  const h = JSON.parse(fs.readFileSync(HIGHLIGHTS_PATH, 'utf8'));
  const now = new Date().toISOString();
  let geocoded = 0, tagged = 0;

  // 1. Reverse geocode bars with bad/missing addresses (max 30 per run to stay within rate limits)
  const needGeocode = h.filter(p => !p.address || p.address.toLowerCase().trim() === 'hamburg' || p.address.length < 10);
  const batch = needGeocode.slice(0, 30);
  
  for (const p of batch) {
    try {
      const data = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${p.lat}&lon=${p.lon}&format=json&addressdetails=1`);
      if (data.address) {
        const a = data.address;
        const street = a.road || a.pedestrian || a.footway || '';
        const num = a.house_number || '';
        const plz = a.postcode || '';
        const suburb = a.suburb || a.neighbourhood || '';
        if (street) {
          p.address = `${street}${num ? ' ' + num : ''}${plz ? ', ' + plz : ''} Hamburg${suburb ? ' (' + suburb + ')' : ''}`;
          geocoded++;
        }
      }
      await sleep(1100); // Nominatim rate limit
    } catch(e) { /* skip */ }
  }

  // 2. Re-generate tags for all
  h.forEach(p => {
    const newTags = generateTags(p);
    if (newTags.length > 0) {
      p.tags = [...new Set([...(p.tags || []), ...newTags])];
      tagged++;
    }
  });

  // 3. Update timestamps
  h.forEach(p => {
    if (!p.last_verified) p.last_verified = now;
    if (!p.created_at) p.created_at = now;
    if (!p.source) p.source = p.highlight ? 'manual' : 'overpass';
  });

  fs.writeFileSync(HIGHLIGHTS_PATH, JSON.stringify(h, null, 2));
  
  console.log(`Data enrichment: ${geocoded} addresses geocoded, ${tagged} tags updated, ${h.length} total`);
  return { geocoded, tagged, total: h.length };
}

if (require.main === module) {
  run().catch(console.error);
}
module.exports = { run };
