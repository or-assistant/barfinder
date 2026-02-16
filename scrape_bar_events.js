#!/usr/bin/env node
/**
 * Bar Event Scraper — scrapes event calendars from Hamburg bar websites
 * Runs daily via cron, saves to bar_events_cache.json
 * 
 * Supported: Static sites via HTTPS fetch
 * TODO: JS-rendered sites via Playwright (Wolters Gasthof etc.)
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CACHE_FILE = path.join(__dirname, 'bar_events_cache.json');

// Bar websites to scrape
const BARS = [
  { name: 'Aalhaus', url: 'https://aalhaus.de', parser: parseAalhaus },
  { name: 'Molotow', url: 'https://www.molotowclub.com/programm/', parser: parseGenericEvents('Molotow', 'molotowclub.com') },
  { name: 'Nochtspeicher', url: 'https://nochtspeicher.de/', parser: parseGenericEvents('Nochtspeicher', 'nochtspeicher.de') },
  { name: 'Gruenspan', url: 'https://www.gruenspan.de/programm/', parser: parseGenericEvents('Gruenspan', 'gruenspan.de') },
  { name: 'Fabrik', url: 'https://www.fabrik.de/programm/', parser: parseGenericEvents('Fabrik', 'fabrik.de') },
  { name: 'Knust', url: 'https://www.knusthamburg.de/programm/', parser: parseGenericEvents('Knust', 'knusthamburg.de') },
  { name: 'Hafenklang', url: 'https://www.hafenklang.com/', parser: parseGenericEvents('Hafenklang', 'hafenklang.com') },
  { name: 'Logo', url: 'https://www.logo-hamburg.de/programm/', parser: parseGenericEvents('Logo', 'logo-hamburg.de') },
  { name: 'Uebel & Gefährlich', url: 'https://www.uebelundgefaehrlich.com/programm/', parser: parseGenericEvents('Uebel & Gefährlich', 'uebelundgefaehrlich.com') },
  { name: 'Fundbureau', url: 'https://fundbureau.de/', parser: parseGenericEvents('Fundbureau', 'fundbureau.de') },
  { name: 'Stage Club', url: 'https://www.stageclub.de/programm/', parser: parseGenericEvents('Stage Club', 'stageclub.de') },
];

function fetch(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BarfinderBot/1.0)' }, timeout: 10000 }, res => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetch(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function parseGenericEvents(locationName, source) {
  return function(html) {
    const events = [];
    const year = new Date().getFullYear();
    
    // Pattern 1: "DD.MM.YYYY" or "DD.MM." dates with nearby text
    const datePattern = /(\d{1,2})\.(\d{1,2})\.(\d{2,4})?\s*[–\-]?\s*(?:(\d{1,2}):(\d{2})\s*(?:Uhr)?\s*[–\-]?\s*)?([^\n<]{5,80})/gi;
    let m;
    while ((m = datePattern.exec(html)) !== null) {
      const day = parseInt(m[1]), month = parseInt(m[2]);
      if (month < 1 || month > 12 || day < 1 || day > 31) continue;
      const yr = m[3] ? (m[3].length === 2 ? 2000 + parseInt(m[3]) : parseInt(m[3])) : year;
      const time = m[4] ? `${m[4]}:${m[5]}` : '20:00';
      let title = m[6].trim().replace(/<[^>]+>/g, '').trim();
      if (title.length < 3 || /^\d+$/.test(title)) continue;
      const dateStr = `${yr}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
      // Skip past dates
      if (new Date(dateStr) < new Date(new Date().toDateString())) continue;
      events.push({ title, date: dateStr, time, location: locationName, category: guessCategory(title), source });
    }
    
    // Pattern 2: JSON-LD events
    const jsonLdPattern = /"@type"\s*:\s*"Event"[^}]*"name"\s*:\s*"([^"]+)"[^}]*"startDate"\s*:\s*"([^"]+)"/gi;
    while ((m = jsonLdPattern.exec(html)) !== null) {
      const title = m[1];
      const startDate = m[2];
      const d = new Date(startDate);
      if (isNaN(d)) continue;
      events.push({ title, date: d.toISOString().split('T')[0], time: `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`, location: locationName, category: guessCategory(title), source });
    }
    
    return events;
  };
}

function guessCategory(title) {
  const t = title.toLowerCase();
  if (/dj|party|club|techno|house|disco/i.test(t)) return 'dj';
  if (/quiz|trivia|rätsel/i.test(t)) return 'quiz';
  if (/live|konzert|band|acoustic|singer|songwriter|jazz|blues|rock|punk|indie/i.test(t)) return 'live_music';
  if (/comedy|stand.?up|kabarett|impro/i.test(t)) return 'comedy';
  if (/fußball|bundesliga|dfb|pokal|champions|fc |hsv|pauli/i.test(t)) return 'football';
  if (/karaoke|open.?mic/i.test(t)) return 'karaoke';
  if (/after.?work|feierabend/i.test(t)) return 'afterwork';
  if (/lesung|reading|buch/i.test(t)) return 'reading';
  return 'event';
}

function parseAalhaus(html) {
  const events = [];
  
  // DJ Sets: "Fr. 27.2.: Nicolaye" pattern or "Sa. 7.3.: Martha"
  const djPattern = /(?:Fr|Sa|So|Mo|Di|Mi|Do)[.,]\s*(\d{1,2})\.(\d{1,2})\.?(?:\d{2,4})?[:\s]+(.+?)(?:\n|$)/gi;
  let m;
  while ((m = djPattern.exec(html)) !== null) {
    const day = parseInt(m[1]);
    const month = parseInt(m[2]);
    const title = m[3].trim();
    if (title && !/Uhr|DFB|Pokal|Bundesliga/i.test(title)) {
      const year = new Date().getFullYear();
      const dateStr = `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
      events.push({ title: `DJ ${title}`, date: dateStr, time: '21:00', location: 'Aalhaus', category: 'dj', source: 'aalhaus.de' });
    }
  }
  
  // Quiz: "Do., 19.3., 19:30 Uhr: Das 118. internationale Aalhaus Kneipenquiz"
  const quizPattern = /(?:Do|Mi|Fr)[.,]\s*(\d{1,2})\.(\d{1,2})[.,]\s*(\d{1,2}):(\d{2})\s*Uhr[:\s]*(.*?Quiz.*?)(?:\n|http|$)/gi;
  while ((m = quizPattern.exec(html)) !== null) {
    const day = parseInt(m[1]), month = parseInt(m[2]);
    const hour = m[3], min = m[4], title = m[5].trim();
    const year = new Date().getFullYear();
    events.push({ title, date: `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`, time: `${hour}:${min}`, location: 'Aalhaus', category: 'quiz', source: 'aalhaus.de' });
  }
  
  // DoKo: "Do., 5.3.26, 19:30 Uhr:"
  const dokoPattern = /(\d{1,2})\.(\d{1,2})\.?\d{0,4}[.,]\s*(\d{1,2}):(\d{2})\s*Uhr[:\s]*(.*?Doppelkopf.*?)(?:\n|$)/gi;
  while ((m = dokoPattern.exec(html)) !== null) {
    const day = parseInt(m[1]), month = parseInt(m[2]);
    const hour = m[3], min = m[4], title = m[5].trim();
    const year = new Date().getFullYear();
    events.push({ title, date: `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`, time: `${hour}:${min}`, location: 'Aalhaus', category: 'quiz', source: 'aalhaus.de' });
  }
  
  // Fußball: "Sa., 14.2., 15:30 Uhr: Bayer Leverkusen vs. FC St. Pauli"
  const footballPattern = /(?:Sa|So|Mo|Di|Mi|Do|Fr)[.,]\s*(\d{1,2})\.(\d{1,2})[.,]\s*(\d{1,2}):(\d{2})\s*Uhr[:\s]*(.*?(?:DFB|Pokal|Bundesliga|vs\.?|FC|HSV|Pauli|Leverkusen|Bayern|Dortmund|Werder).*?)(?:\n|$)/gi;
  while ((m = footballPattern.exec(html)) !== null) {
    const day = parseInt(m[1]), month = parseInt(m[2]);
    const hour = m[3], min = m[4], title = m[5].trim();
    const year = new Date().getFullYear();
    events.push({ title: `⚽ ${title}`, date: `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`, time: `${hour}:${min}`, location: 'Aalhaus', category: 'football', source: 'aalhaus.de' });
  }
  
  return events;
}

async function scrapeAll() {
  console.log(`[${new Date().toISOString()}] Starting bar event scrape...`);
  const allEvents = [];
  
  for (const bar of BARS) {
    try {
      console.log(`  Scraping ${bar.name} (${bar.url})...`);
      const html = await fetch(bar.url);
      const events = bar.parser(html);
      console.log(`  → ${events.length} events found`);
      allEvents.push(...events);
    } catch (e) {
      console.error(`  ✗ ${bar.name}: ${e.message}`);
    }
  }
  
  // Save
  const cache = {
    lastUpdated: new Date().toISOString(),
    events: allEvents
  };
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  console.log(`Saved ${allEvents.length} events to ${CACHE_FILE}`);
  return cache;
}

// Run
scrapeAll().then(c => {
  console.log('Done:', c.events.map(e => `${e.date} ${e.title}`).join('\n  '));
}).catch(e => console.error('Fatal:', e));
