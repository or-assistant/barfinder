#!/usr/bin/env node
/**
 * Barfinder Hamburg - Ecosystem Event Scraper
 * Scrapes events from Hamburg's innovation ecosystem sources.
 * 
 * Working sources:
 * ✅ nextMedia.Hamburg (nextmedia-hamburg.de/events/)
 * ✅ ARIC Hamburg (aric-hamburg.de/events/)
 * ✅ Hamburg Kreativ Gesellschaft (kreativgesellschaft.org/termine)
 * 
 * Run: node scrape_ecosystem_events.js
 * Output: ecosystem_events_cache.json
 */

const https = require('https');
const http = require('http');
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const CACHE_FILE = path.join(__dirname, 'ecosystem_events_cache.json');

// Event types we want
const WANTED_TYPES = ['networking', 'pitch', 'demoday', 'afterwork', 'meetup', 'techtalk', 'startup'];
// Keywords to include
const INCLUDE_KEYWORDS = [
  'networking', 'after-work', 'afterwork', 'meetup', 'meet-up', 'stammtisch',
  'pitch', 'demo day', 'demoday', 'startup', 'start-up', 'tech talk',
  'community', 'mixer', 'social', 'get-together', 'founders', 'gründer',
  'hackathon', 'barcamp', 'mix & mingle', 'mix and mingle', 'build friday',
  'treff', 'austausch', 'vernetzung', 'netzwerk'
];
// Keywords to exclude
const EXCLUDE_KEYWORDS = [
  'webinar', 'online-event', 'online event', 'remote only'
];

function fetch(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Barfinder/1.0)' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const loc = res.headers.location.startsWith('http') ? res.headers.location : new URL(res.headers.location, url).href;
        return fetch(loc).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function decodeEntities(str) {
  return str.replace(/&#8217;/g, "'").replace(/&#8211;/g, '–').replace(/&#038;/g, '&').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#8220;/g, '"').replace(/&#8221;/g, '"');
}

function classifyEvent(title, description = '') {
  const text = `${title} ${description}`.toLowerCase();
  if (text.includes('pitch') || text.includes('demo day') || text.includes('demoday')) return 'pitch';
  if (text.includes('after-work') || text.includes('afterwork')) return 'afterwork';
  if (text.includes('meetup') || text.includes('meet-up') || text.includes('stammtisch') || text.includes('treff')) return 'meetup';
  if (text.includes('networking') || text.includes('mix & mingle') || text.includes('mixer') || text.includes('vernetzung') || text.includes('netzwerk')) return 'networking';
  if (text.includes('hackathon') || text.includes('barcamp')) return 'meetup';
  if (text.includes('tech talk') || text.includes('techtalk') || text.includes('vortrag')) return 'techtalk';
  if (text.includes('startup') || text.includes('start-up') || text.includes('gründer') || text.includes('founders') || text.includes('build friday')) return 'startup';
  if (text.includes('festival') || text.includes('conference') || text.includes('konferenz') || text.includes('summit')) return 'networking';
  if (text.includes('community')) return 'meetup';
  return null;
}

function shouldInclude(title, description = '') {
  const text = `${title} ${description}`.toLowerCase();
  // Exclude online-only
  for (const kw of EXCLUDE_KEYWORDS) {
    if (text.includes(kw)) return false;
  }
  // Must match at least one include keyword or get classified
  return INCLUDE_KEYWORDS.some(kw => text.includes(kw)) || classifyEvent(title, description) !== null;
}

// --- nextMedia.Hamburg ---
async function scrapeNextMedia() {
  const events = [];
  try {
    const html = await fetch('https://nextmedia-hamburg.de/events/');
    const dom = new JSDOM(html);
    const doc = dom.window.document;
    
    // Parse event links - they contain structured text
    const links = doc.querySelectorAll('a[href*="/events/kalender/"]');
    for (const link of links) {
      const text = link.textContent.trim();
      const href = link.getAttribute('href');
      const url = href.startsWith('http') ? href : `https://nextmedia-hamburg.de${href}`;
      
      // Extract date pattern like "18.2.2026"
      const dateMatch = text.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
      // Extract time pattern like "17:00 – 22:00 Uhr"
      const timeMatch = text.match(/(\d{1,2}:\d{2})\s*[–-]\s*(\d{1,2}:\d{2})\s*Uhr/);
      // Extract venue - look for "SPACE" or location after kostenfrei/EURO
      const venueMatch = text.match(/(?:kostenfrei|EURO|Ticketverkauf)\s*(.+?)$/m);
      
      // Title: extract between month+day prefix and the date
      const titleMatch2 = text.match(/(?:Jan|Feb|Mär|Apr|Mai|Jun|Jul|Aug|Sep|Okt|Nov|Dez)\d{2}(.+?)(?:\d{1,2}\.\d{1,2}\.\d{4})/s);
      let title = titleMatch2 ? titleMatch2[1].trim().replace(/\s+/g, ' ') : '';
      if (!title) {
        const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 5);
        title = lines[0] || '';
      }
      // Remove trailing date fragments and leading/trailing junk
      title = title.replace(/\d{1,2}\.\d{1,2}\.?\s*[–-]?\s*$/, '').trim();
      // Remove date-like suffixes e.g. "Festival25.3 –"
      title = title.replace(/\d{1,2}\.\d{1,2}\.\?\s*[–-]?\s*$/, '').trim();
      if (title.length < 5) continue;
      
      if (!title || !dateMatch) continue;
      
      const date = `${dateMatch[3]}-${dateMatch[2].padStart(2,'0')}-${dateMatch[1].padStart(2,'0')}`;
      const time = timeMatch ? `${timeMatch[1]} - ${timeMatch[2]}` : '';
      let venue = venueMatch ? venueMatch[1].trim() : '';
      // Clean venue
      if (venue.includes('Online')) venue = 'Online';
      
      const type = classifyEvent(title, text);
      if (shouldInclude(title, text) && !text.toLowerCase().includes('online-event')) {
        events.push({ title, date, time, venue: venue || 'SPACE Hamburg', url, source: 'nextmedia', type: type || 'networking' });
      }
    }
  } catch (e) {
    console.error('nextMedia scrape error:', e.message);
  }
  return events;
}

// --- ARIC Hamburg (uses The Events Calendar REST API) ---
async function scrapeARIC() {
  const events = [];
  try {
    const json = await fetch('https://aric-hamburg.de/wp-json/tribe/events/v1/events?per_page=50');
    const data = JSON.parse(json);
    
    for (const ev of (data.events || [])) {
      const title = decodeEntities(ev.title || '');
      const url = ev.url || '';
      const startDate = ev.start_date || '';
      const endDate = ev.end_date || '';
      const date = startDate ? startDate.substring(0, 10) : '';
      const startTime = startDate ? startDate.substring(11, 16) : '';
      const endTime = endDate ? endDate.substring(11, 16) : '';
      const time = startTime && endTime ? `${startTime} - ${endTime}` : startTime;
      
      // Venue
      let venue = 'ARIC Hamburg';
      if (ev.venue && ev.venue.venue) venue = ev.venue.venue;
      
      // Cost
      const cost = ev.cost || '';
      const description = (ev.description || '').replace(/<[^>]+>/g, ' ');
      
      const type = classifyEvent(title, description);
      if (shouldInclude(title, description)) {
        events.push({ title, date, time, venue, url, source: 'aric', type: type || 'meetup' });
      }
    }
  } catch (e) {
    console.error('ARIC scrape error:', e.message);
  }
  return events;
}

// --- Kreativ Gesellschaft ---
async function scrapeKreativGesellschaft() {
  const events = [];
  try {
    const html = await fetch('https://kreativgesellschaft.org/termine/');
    const dom = new JSDOM(html);
    const doc = dom.window.document;
    
    // Parse headings (## Title) followed by date info
    const headings = doc.querySelectorAll('h2');
    for (const h2 of headings) {
      const title = h2.textContent.trim();
      if (title.length < 5 || title === 'Termine') continue;
      
      // Get the text after the heading (sibling text)
      let nextText = '';
      let el = h2.nextSibling;
      while (el && el.nodeName !== 'H2') {
        nextText += (el.textContent || '') + ' ';
        el = el.nextSibling;
      }
      nextText = nextText.trim();
      
      const dateMatch = nextText.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
      // Also try format "25.3. 09:00 Uhr – 26.3.2026"
      const dateMatch2 = nextText.match(/(\d{1,2})\.(\d{1,2})\.\s*\d{1,2}:\d{2}\s*Uhr\s*[–-]\s*(\d{1,2})\.(\d{1,2})\.(\d{4})/);
      let date = '';
      if (dateMatch) {
        date = `${dateMatch[3]}-${dateMatch[2].padStart(2,'0')}-${dateMatch[1].padStart(2,'0')}`;
      } else if (dateMatch2) {
        date = `${dateMatch2[5]}-${dateMatch2[2].padStart(2,'0')}-${dateMatch2[1].padStart(2,'0')}`;
      }
      
      const timeMatch = nextText.match(/(\d{1,2}:\d{2})\s*[–-]\s*(\d{1,2}:\d{2})/);
      const time = timeMatch ? `${timeMatch[1]} - ${timeMatch[2]}` : '';
      
      // Venue from text after EURO or Uhr
      const venueMatch = nextText.match(/(?:EURO|Uhr)\s*([A-Z][\w\s|&,.-]+?)(?:\d|$)/);
      const venue = venueMatch ? venueMatch[1].trim() : 'Hamburg';
      
      const type = classifyEvent(title, nextText);
      if (shouldInclude(title, nextText)) {
        events.push({ title, date, time, venue, url: 'https://kreativgesellschaft.org/termine/', source: 'kreativgesellschaft', type: type || 'networking' });
      }
    }
  } catch (e) {
    console.error('Kreativ Gesellschaft scrape error:', e.message);
  }
  return events;
}

// --- Main ---
async function main() {
  console.log('🔍 Scraping Hamburg ecosystem events...\n');
  
  const [nextMediaEvents, aricEvents, kreativEvents] = await Promise.all([
    scrapeNextMedia(),
    scrapeARIC(),
    scrapeKreativGesellschaft()
  ]);
  
  console.log(`nextMedia.Hamburg: ${nextMediaEvents.length} events`);
  console.log(`ARIC Hamburg: ${aricEvents.length} events`);
  console.log(`Kreativ Gesellschaft: ${kreativEvents.length} events`);
  
  const allEvents = [...nextMediaEvents, ...aricEvents, ...kreativEvents];
  
  // Deduplicate by title similarity
  const unique = [];
  for (const ev of allEvents) {
    const evTitle = ev.title.toLowerCase();
    const isDupe = unique.some(u => {
      const uTitle = u.title.toLowerCase();
      return uTitle === evTitle ||
        (u.date === ev.date && (uTitle.includes(evTitle) || evTitle.includes(uTitle))) ||
        (u.date === ev.date && uTitle.substring(0, 15) === evTitle.substring(0, 15));
    });
    if (!isDupe) unique.push(ev);
  }
  
  // Sort by date
  unique.sort((a, b) => {
    if (!a.date) return 1;
    if (!b.date) return -1;
    return a.date.localeCompare(b.date);
  });
  
  // Filter: only future events
  const today = new Date().toISOString().slice(0, 10);
  const futureEvents = unique.filter(e => !e.date || e.date >= today);
  
  console.log(`\n✅ Total unique future events: ${futureEvents.length}`);
  
  // Save
  const output = {
    lastUpdated: new Date().toISOString(),
    count: futureEvents.length,
    sources: {
      nextmedia: { url: 'https://nextmedia-hamburg.de/events/', count: nextMediaEvents.length },
      aric: { url: 'https://aric-hamburg.de/events/', count: aricEvents.length },
      kreativgesellschaft: { url: 'https://kreativgesellschaft.org/termine/', count: kreativEvents.length }
    },
    events: futureEvents
  };
  
  fs.writeFileSync(CACHE_FILE, JSON.stringify(output, null, 2));
  console.log(`\n💾 Saved to ${CACHE_FILE}`);
  
  // Print events
  for (const ev of futureEvents) {
    console.log(`  📅 ${ev.date || '???'} | ${ev.type.padEnd(12)} | ${ev.title.substring(0, 60)} [${ev.source}]`);
  }
}

main().catch(console.error);
