#!/usr/bin/env node
/**
 * Barfinder Place Verifier
 * Prüft Locations gegen OSM + Website-Check
 * Läuft wöchentlich, 50 Locations pro Durchlauf
 * Keine illegalen Quellen, nur OSM + HEAD-Requests
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const BATCH_SIZE = 50;
const STATE_FILE = path.join(__dirname, 'verify_state.json');
const HIGHLIGHTS_FILE = path.join(__dirname, 'highlights.json');
const LOG_FILE = path.join(__dirname, 'verify_log.json');

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch(e) { return { lastIndex: 0, flagged: [], verified: 0, lastRun: null }; }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function appendLog(entry) {
  let log = [];
  try { log = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')); } catch(e) {}
  log.push({ ...entry, timestamp: new Date().toISOString() });
  // Keep last 500 entries
  if (log.length > 500) log = log.slice(-500);
  fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

function fetch(url, timeout = 5000) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout, headers: { 'User-Agent': 'Barfinder-Verifier/1.0' } }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '' }); });
  });
}

// 1. OSM Nominatim: Prüfen ob an der Adresse ein POI existiert
async function checkOSM(place) {
  const q = encodeURIComponent(`${place.name} ${place.address || ''} Hamburg`);
  const url = `https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=1`;
  const r = await fetch(url);
  if (r.status !== 200) return { source: 'osm', result: 'error' };
  try {
    const data = JSON.parse(r.body);
    if (data.length === 0) return { source: 'osm', result: 'not_found' };
    return { source: 'osm', result: 'found', type: data[0].type, name: data[0].display_name };
  } catch(e) { return { source: 'osm', result: 'error' }; }
}

// 2. Website-Check: HEAD-Request auf die Website
async function checkWebsite(place) {
  if (!place.website) return { source: 'website', result: 'no_url' };
  let url = place.website;
  if (!url.startsWith('http')) url = 'https://' + url;
  const r = await fetch(url);
  if (r.status === 0) return { source: 'website', result: 'unreachable' };
  if (r.status >= 400) return { source: 'website', result: 'dead', status: r.status };
  return { source: 'website', result: 'alive', status: r.status };
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const highlights = JSON.parse(fs.readFileSync(HIGHLIGHTS_FILE, 'utf8'));
  const state = loadState();
  
  let startIdx = state.lastIndex;
  if (startIdx >= highlights.length) startIdx = 0; // Wrap around
  
  const batch = highlights.slice(startIdx, startIdx + BATCH_SIZE);
  console.log(`🔍 Verifying ${batch.length} places (${startIdx} to ${startIdx + batch.length - 1} of ${highlights.length})`);
  
  const flagged = [];
  let checked = 0;

  for (const place of batch) {
    // OSM check (respect rate limit: 1 req/sec)
    const osm = await checkOSM(place);
    await sleep(1100); // Nominatim: max 1 req/sec
    
    // Website check
    const web = await checkWebsite(place);
    
    let status = 'ok';
    const issues = [];
    
    if (osm.result === 'not_found') {
      issues.push('Nicht in OSM gefunden');
      status = 'suspect';
    }
    if (web.result === 'dead' || web.result === 'unreachable') {
      issues.push(`Website ${web.result} (${web.status || 'timeout'})`);
      status = status === 'suspect' ? 'likely_closed' : 'suspect';
    }
    
    if (status !== 'ok') {
      flagged.push({ name: place.name, address: place.address, category: place.category, status, issues, checks: { osm: osm.result, web: web.result } });
      appendLog({ name: place.name, status, issues });
      console.log(`  ⚠️ ${place.name}: ${issues.join(', ')}`);
    } else {
      console.log(`  ✅ ${place.name}`);
    }
    
    checked++;
  }
  
  state.lastIndex = startIdx + batch.length;
  state.verified += checked;
  state.lastRun = new Date().toISOString();
  state.flagged = [...(state.flagged || []), ...flagged];
  // Dedupe flagged by name
  const seen = new Set();
  state.flagged = state.flagged.filter(f => { if (seen.has(f.name)) return false; seen.add(f.name); return true; });
  saveState(state);
  
  console.log(`\n📊 Done: ${checked} checked, ${flagged.length} flagged, next batch starts at ${state.lastIndex}`);
  if (flagged.length > 0) {
    console.log(`\n⚠️ Flagged locations:`);
    flagged.forEach(f => console.log(`  - ${f.name} (${f.address}): ${f.status} — ${f.issues.join(', ')}`));
  }
}

main().catch(e => console.error('Verify error:', e));
