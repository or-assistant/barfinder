#!/usr/bin/env node
/**
 * Location Plausibility Checker
 * Validates that bar coordinates match their stated address/city.
 * Run: node validate_locations.js
 */

const fs = require('fs');
const https = require('https');

const highlights = JSON.parse(fs.readFileSync('./highlights.json', 'utf8'));

// Known city bounding boxes
const CITIES = {
  'Hamburg': { minLat: 53.39, maxLat: 53.74, minLon: 9.73, maxLon: 10.33 },
  'Norderstedt': { minLat: 53.66, maxLat: 53.73, minLon: 9.95, maxLon: 10.08 },
  'Kaltenkirchen': { minLat: 53.80, maxLat: 53.86, minLon: 9.93, maxLon: 10.00 },
  'Bad Bramstedt': { minLat: 53.90, maxLat: 53.94, minLon: 9.85, maxLon: 9.92 },
  'Lentföhrden': { minLat: 53.85, maxLat: 53.90, minLon: 9.85, maxLon: 9.92 },
};

function cityFromAddress(address) {
  if (!address) return null;
  const addr = address.toLowerCase();
  if (addr.includes('norderstedt')) return 'Norderstedt';
  if (addr.includes('kaltenkirchen')) return 'Kaltenkirchen';
  if (addr.includes('bad bramstedt')) return 'Bad Bramstedt';
  if (addr.includes('lentföhrden')) return 'Lentföhrden';
  // Default: if no specific city mentioned, assume Hamburg
  return 'Hamburg';
}

function isInCity(lat, lon, city) {
  const bbox = CITIES[city];
  if (!bbox) return true; // unknown city = can't check
  return lat >= bbox.minLat && lat <= bbox.maxLat && lon >= bbox.minLon && lon <= bbox.maxLon;
}

const issues = [];

highlights.forEach((h, i) => {
  const city = cityFromAddress(h.address);
  if (city && !isInCity(h.lat, h.lon, city)) {
    const expected = CITIES[city];
    issues.push({
      name: h.name,
      address: h.address,
      expectedCity: city,
      lat: h.lat,
      lon: h.lon,
      expectedBbox: expected,
      issue: `Coordinates outside ${city} bounding box`
    });
  }
  
  // Check for obviously wrong coordinates (outside northern Germany)
  if (h.lat < 53.0 || h.lat > 54.5 || h.lon < 9.0 || h.lon > 11.0) {
    issues.push({
      name: h.name,
      lat: h.lat, lon: h.lon,
      issue: 'Coordinates outside northern Germany'
    });
  }
});

if (issues.length === 0) {
  console.log('✅ All', highlights.length, 'locations pass plausibility check');
} else {
  console.log('⚠️', issues.length, 'location(s) with suspicious coordinates:');
  issues.forEach(i => {
    console.log(`  ❌ ${i.name} (${i.address || 'no address'})`);
    console.log(`     ${i.issue}: ${i.lat}, ${i.lon}`);
  });
}

fs.writeFileSync('./location_issues.json', JSON.stringify(issues, null, 2));
process.exit(issues.length > 0 ? 1 : 0);
