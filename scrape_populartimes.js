#!/usr/bin/env node
// Google Popular Times Scraper — uses hidden Google Maps search endpoint
// No API key needed! Based on github.com/m-wrzr/populartimes technique

const https = require('https');
const fs = require('fs');
const path = require('path');

const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
];

const PB_PARAM = '!4m12!1m3!1d4005.9771522653964!2d-122.42072974863942!3d37.8077459796541!2m3!1f0!2f0!3f0!3m2!1i1125!2i976!4f13.1!7i20!10b1!12m6!2m3!5m1!6e2!20e3!10b1!16b1!19m3!2m2!1i392!2i106!20m61!2m2!1i203!2i100!3m2!2i4!5b1!6m6!1m2!1i86!2i86!1m2!1i408!2i200!7m46!1m3!1e1!2b0!3e3!1m3!1e2!2b1!3e2!1m3!1e2!2b0!3e3!1m3!1e3!2b0!3e3!1m3!1e4!2b0!3e3!1m3!1e8!2b0!3e3!1m3!1e3!2b1!3e2!1m3!1e9!2b1!3e2!1m3!1e10!2b0!3e3!1m3!1e10!2b1!3e2!1m3!1e10!2b0!3e4!2b1!4b1!9b0!22m6!1sa9fVWea_MsX8adX8j8AE%3A1!2zMWk6Mix0OjExODg3LGU6MSxwOmE5ZlZXZWFfTXNYOGFkWDhqOEFFOjE!7e81!12e3!17sa9fVWea_MsX8adX8j8AE%3A564!18e15!24m15!2b1!5m4!2b1!3b1!5b1!6b1!10m1!8e3!17b1!24b1!25b1!26b1!30m1!2b1!36b1!26m3!2m2!1i80!2i92!30m28!1m6!1m2!1i0!2i0!2m2!1i458!2i976!1m6!1m2!1i1075!2i0!2m2!1i1125!2i976!1m6!1m2!1i0!2i0!2m2!1i1125!2i20!1m6!1m2!1i0!2i956!2m2!1i1125!2i976!37m1!1e81!42b1!47m0!49m1!3b1';

const DAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];

function indexGet(arr, ...indices) {
  try {
    let val = arr;
    for (const i of indices) {
      if (val == null) return null;
      val = val[i];
    }
    return val;
  } catch(e) { return null; }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fetch(url, ua) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': ua } }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function getPopularTimes(name, address) {
  const query = encodeURIComponent(`${name} ${address}`);
  const url = `https://www.google.de/search?tbm=map&tch=1&hl=de&q=${query}&pb=${PB_PARAM}`;
  const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  
  console.log(`  Scraping: ${name}...`);
  const raw = await fetch(url, ua);
  
  // Parse response — Google wraps it in )]}'
  let data = raw.split('/*""*/')[0];
  const jend = data.lastIndexOf('}');
  if (jend >= 0) data = data.substring(0, jend + 1);
  
  let jdata;
  try {
    const parsed = JSON.parse(data);
    jdata = JSON.parse(parsed.d.substring(4));
  } catch(e) {
    console.log(`  ⚠️ Parse error for ${name}: ${e.message}`);
    console.log(`  Raw response length: ${raw.length}, first 200 chars: ${raw.substring(0,200)}`);
    return null;
  }
  
  // Try both index 0 and 1 for the info array
  let info = indexGet(jdata, 0, 1, 0, 14);
  if (!info) info = indexGet(jdata, 0, 1, 1, 14);
  if (!info) {
    console.log(`  ⚠️ No info found for ${name}`);
    return null;
  }
  
  const rating = indexGet(info, 4, 7);
  const rating_n = indexGet(info, 4, 8);
  const popularRaw = indexGet(info, 84, 0);
  const currentPop = indexGet(info, 84, 7, 1);
  const timeSpentRaw = indexGet(info, 117, 0);
  
  let populartimes = null;
  if (popularRaw) {
    populartimes = [];
    for (const day of popularRaw) {
      const dayNo = day[0] - 1; // 1-indexed to 0-indexed
      const hourData = new Array(24).fill(0);
      if (day[1]) {
        for (const h of day[1]) {
          hourData[h[0]] = h[1];
        }
      }
      populartimes.push({ name: DAYS[dayNo], data: hourData });
    }
  }
  
  const result = { name, address, rating, rating_n, current_popularity: currentPop, populartimes };
  
  if (timeSpentRaw) {
    const nums = timeSpentRaw.match(/[\d.]+/g)?.map(Number) || [];
    if (nums.length >= 2) result.time_spent = [Math.round(nums[0] * (timeSpentRaw.includes('Stunde') || timeSpentRaw.includes('hour') ? 60 : 1)), Math.round(nums[1] * (timeSpentRaw.includes('Stunde') || timeSpentRaw.includes('hour') ? 60 : 1))];
  }
  
  console.log(`  ✅ ${name}: Rating ${rating}⭐ (${rating_n} reviews), Popular Times: ${populartimes ? 'YES!' : 'no'}, Live: ${currentPop || 'n/a'}`);
  return result;
}

// Test bars
const TEST_BARS = [
  { name: 'Aalhaus', address: 'Kieler Straße 563, Hamburg' },
  { name: 'Frau Möller', address: 'Lange Reihe 96, Hamburg' },
  { name: "Christiansen's", address: 'Pinnasberg 60, Hamburg' },
  { name: 'Katze', address: 'Schulterblatt 86, Hamburg' },
  { name: 'Le Fonque', address: 'Juliusstraße 33, Hamburg' },
  { name: 'Zum Silbersack', address: 'Silbersackstraße 9, Hamburg' },
  { name: 'Elbschlosskeller', address: 'Hamburger Berg 5, Hamburg' },
];

async function main() {
  console.log('🔍 Google Popular Times Scraper (no API key!)');
  console.log(`Testing ${TEST_BARS.length} bars...\n`);
  
  const results = [];
  for (const bar of TEST_BARS) {
    try {
      const r = await getPopularTimes(bar.name, bar.address);
      if (r) results.push(r);
    } catch(e) {
      console.log(`  ❌ Error for ${bar.name}: ${e.message}`);
    }
    await sleep(3000 + Math.random() * 3000); // 3-6s delay
  }
  
  const outFile = path.join(__dirname, 'populartimes_cache.json');
  fs.writeFileSync(outFile, JSON.stringify(results, null, 2));
  console.log(`\n📦 Saved ${results.length} results to populartimes_cache.json`);
  
  // Summary
  const withPT = results.filter(r => r.populartimes);
  console.log(`\n📊 Summary: ${results.length} bars scraped, ${withPT.length} with Popular Times data`);
}

main().catch(e => console.error('Fatal:', e));
