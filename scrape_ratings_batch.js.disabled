#!/usr/bin/env node
// Batch Google Ratings Scraper — scrapes all HIGHLIGHTS bars
// Uses hidden Google Maps search endpoint (no API key needed)

const https = require('https');
const fs = require('fs');
const path = require('path');

const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
];

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

async function getRating(name, address) {
  const query = encodeURIComponent(`${name} ${address} Hamburg`);
  const pb = '!4m12!1m3!1d4005.9771522653964!2d9.9!3d53.55!2m3!1f0!2f0!3f0!3m2!1i1125!2i976!4f13.1!7i20!10b1!12m6!2m3!5m1!6e2!20e3!10b1!16b1!19m3!2m2!1i392!2i106!20m61!2m2!1i203!2i100!3m2!2i4!5b1!6m6!1m2!1i86!2i86!1m2!1i408!2i200!7m46!1m3!1e1!2b0!3e3!1m3!1e2!2b1!3e2!1m3!1e2!2b0!3e3!1m3!1e3!2b0!3e3!1m3!1e4!2b0!3e3!1m3!1e8!2b0!3e3!1m3!1e3!2b1!3e2!1m3!1e9!2b1!3e2!1m3!1e10!2b0!3e3!1m3!1e10!2b1!3e2!1m3!1e10!2b0!3e4!2b1!4b1!9b0!22m6!1sa9fVWea_MsX8adX8j8AE%3A1!2zMWk6Mix0OjExODg3LGU6MSxwOmE5ZlZXZWFfTXNYOGFkWDhqOEFFOjE!7e81!12e3!17sa9fVWea_MsX8adX8j8AE%3A564!18e15!24m15!2b1!5m4!2b1!3b1!5b1!6b1!10m1!8e3!17b1!24b1!25b1!26b1!30m1!2b1!36b1!26m3!2m2!1i80!2i92!30m28!1m6!1m2!1i0!2i0!2m2!1i458!2i976!1m6!1m2!1i1075!2i0!2m2!1i1125!2i976!1m6!1m2!1i0!2i0!2m2!1i1125!2i20!1m6!1m2!1i0!2i956!2m2!1i1125!2i976!37m1!1e81!42b1!47m0!49m1!3b1';
  const url = `https://www.google.de/search?tbm=map&tch=1&hl=de&q=${query}&pb=${pb}`;
  const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  
  const raw = await fetch(url, ua);
  let data = raw.split('/*""*/')[0];
  const jend = data.lastIndexOf('}');
  if (jend < 0) return null;
  data = data.substring(0, jend + 1);
  
  try {
    const parsed = JSON.parse(data);
    const jdata = JSON.parse(parsed.d.substring(4));
    let info = jdata[0]?.[1]?.[0]?.[14] || jdata[0]?.[1]?.[1]?.[14];
    if (!info) return null;
    
    const rating = info[4]?.[7];
    const rating_n = info[4]?.[8];
    return { name, rating, rating_n: rating_n || null };
  } catch(e) {
    return null;
  }
}

async function main() {
  // Extract HIGHLIGHTS from server.js
  const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const match = src.match(/const HIGHLIGHTS = \[([\s\S]*?)\];/);
  if (!match) { console.log('Could not find HIGHLIGHTS'); return; }
  
  const nameRe = /name:\s*['"]([^'"]+)['"]/g;
  const addrRe = /address:\s*['"]([^'"]+)['"]/g;
  const names = [], addrs = [];
  let m;
  while (m = nameRe.exec(match[1])) names.push(m[1]);
  while (m = addrRe.exec(match[1])) addrs.push(m[1]);
  
  console.log(`🔍 Scraping Google Ratings for ${names.length} bars...`);
  
  const results = [];
  let success = 0, fail = 0;
  
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const addr = addrs[i] || '';
    try {
      const r = await getRating(name, addr);
      if (r && r.rating) {
        results.push(r);
        success++;
        process.stdout.write(`✅ ${name}: ${r.rating}⭐  `);
      } else {
        fail++;
        process.stdout.write(`⚠️ ${name}: no data  `);
      }
    } catch(e) {
      fail++;
      process.stdout.write(`❌ ${name}: error  `);
    }
    if ((i+1) % 5 === 0) console.log(`  [${i+1}/${names.length}]`);
    await sleep(2000 + Math.random() * 3000);
  }
  
  console.log(`\n\n📦 Done: ${success} ratings, ${fail} failures`);
  
  const outFile = path.join(__dirname, 'google_ratings_cache.json');
  fs.writeFileSync(outFile, JSON.stringify(results, null, 2));
  console.log(`Saved to google_ratings_cache.json`);
}

main().catch(e => console.error('Fatal:', e));
