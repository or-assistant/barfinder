#!/usr/bin/env node
/**
 * 🆕 New Sources Scraper — startupcity.hamburg, rausgegangen.de, MOPO, Handelskammer, meet-and-eat
 * Saves to new_sources_events_cache.json
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const cheerio = require('cheerio');

const OUTPUT_FILE = __dirname + '/new_sources_events_cache.json';

function fetch(url, maxRedirects = 3) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && maxRedirects > 0) {
        const next = res.headers.location.startsWith('http') ? res.headers.location : new URL(res.headers.location, url).href;
        return fetch(next, maxRedirects - 1).then(resolve, reject);
      }
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });
}

// ═══ Classify event type ═══
function classifyType(title, desc) {
  const t = ((title || '') + ' ' + (desc || '')).toLowerCase();
  if (/founder|gründer|startup|start-up|pitch|demo.day|venture|accelerat/i.test(t)) return 'startup';
  if (/after.?work|feierabend|drinks|happy.hour/i.test(t)) return 'afterwork';
  if (/network|meetup|meet.up|stammtisch|connect|community/i.test(t)) return 'networking';
  if (/tech|ai |ki |hack|code|developer|software|cyber|data|digital/i.test(t)) return 'tech';
  return 'social';
}

// ═══ Filter: relevant event? ═══
function isRelevant(title, desc) {
  const t = ((title || '') + ' ' + (desc || '')).toLowerCase();
  const keywords = /startup|founder|gründer|network|after.?work|social|tech|pitch|demo.day|meetup|innovation|entrepreneur|community|hack|barcamp|summit|festival|conference|forum|breakfast|running.club|build.friday|stammtisch|connect|ai |ki |digital|creative|food.innovation|omr|12min/i;
  if (keywords.test(t)) return true;
  return false;
}

// ═══ Filter: exclude? ═══
function shouldExclude(title, desc) {
  const t = ((title || '') + ' ' + (desc || '')).toLowerCase();
  if (/webinar|online.only|remote.only/i.test(t) && !/hybrid/i.test(t)) return true;
  if (/kurs|course|seminar/i.test(t) && /\b[1-9]\d{2,}\s*€/i.test(t)) return true;
  return false;
}

// ═══ Parse US date "M/D/YYYY" → "YYYY-MM-DD" ═══
function parseUSDate(str) {
  if (!str) return null;
  // Handle "2/18/2026" or "2/18/2026-2/19/2026"
  const m = str.trim().match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  return `${m[3]}-${String(m[1]).padStart(2,'0')}-${String(m[2]).padStart(2,'0')}`;
}

// ═══ 1. startupcity.hamburg ═══
async function scrapeStartupCity() {
  console.log('🏙️ Scraping startupcity.hamburg...');
  try {
    const html = await fetch('https://startupcity.hamburg/news-events/events');
    const $ = cheerio.load(html);
    const events = [];
    
    // Each event is an <a> with date, title, and description
    // Structure from the page: links to /news-events/events/SLUG
    $('a[href*="/news-events/events/"]').each((i, el) => {
      const $el = $(el);
      const href = $el.attr('href');
      if (!href || href === '/news-events/events' || href === '/news-events/events/') return;
      
      const text = $el.text().trim();
      // Parse: first line is date, second is title, rest is description
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
      if (lines.length < 2) return;
      
      const dateStr = lines[0]; // e.g. "2/18/2026" or "2/25/2026-2/26/2026"
      const title = lines[1];
      const description = lines.slice(2).join(' ').trim();
      
      const date = parseUSDate(dateStr);
      if (!date) return;
      
      // Only future events
      if (date < new Date().toISOString().slice(0, 10)) return;
      
      const url = href.startsWith('http') ? href : `https://startupcity.hamburg${href}`;
      
      events.push({
        title,
        date,
        time: '',
        venue: 'Hamburg',
        url,
        source: 'startupcity',
        type: classifyType(title, description),
        description: description.substring(0, 300)
      });
    });
    
    console.log(`  ✅ ${events.length} events from startupcity.hamburg`);
    return events;
  } catch (e) {
    console.log(`  ❌ startupcity.hamburg error: ${e.message}`);
    return [];
  }
}

// ═══ 2. MOPO "Noch nichts vor?" ═══
async function scrapeMOPO() {
  console.log('📰 Scraping MOPO...');
  const events = [];
  
  // Try today and next 2 days
  const now = new Date();
  for (let d = 0; d < 3; d++) {
    const date = new Date(now);
    date.setDate(date.getDate() + d);
    const dd = String(date.getDate()).padStart(2, '0');
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const yyyy = date.getFullYear();
    const dateStr = `${yyyy}-${mm}-${dd}`;
    const url = `https://www.mopo.de/hamburg/noch-nichts-vor-das-geht-morgen-in-hamburg-${dd}-${mm}-${yyyy}/`;
    
    try {
      const html = await fetch(url);
      if (!html || html.length < 500) continue;
      const $ = cheerio.load(html);
      
      // Extract event sections - they use h2 headers for event names
      $('h2').each((i, el) => {
        const title = $(el).text().trim();
        if (!title || title.length < 3) return;
        // Skip non-event headers and date headers
        if (/newsletter|verpassen|noch mehr kultur/i.test(title)) return;
        if (/^(montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag),?\s+\d/i.test(title)) return;
        if (/seite nicht gefunden|404|error/i.test(title)) return;
        
        // Get the text after this h2 until next h2
        let desc = '';
        let venue = '';
        let time = '';
        let nextEl = $(el).next();
        while (nextEl.length && nextEl[0].tagName !== 'h2') {
          const t = nextEl.text().trim();
          desc += t + ' ';
          nextEl = nextEl.next();
        }
        
        // Extract venue from "Ort & Uhrzeit:" pattern
        const venueMatch = desc.match(/(?:Ort[^:]*:\s*)?\[([^\]]+)\]/);
        if (venueMatch) venue = venueMatch[1];
        
        // Extract time
        const timeMatch = desc.match(/(\d{1,2}:\d{2})\s*Uhr/);
        if (timeMatch) time = timeMatch[1];
        
        events.push({
          title,
          date: dateStr,
          time: time || '',
          venue: venue || 'Hamburg',
          url,
          source: 'mopo',
          type: 'social',
          description: desc.substring(0, 300).trim()
        });
      });
    } catch (e) {
      // Some dates won't have articles
    }
  }
  
  console.log(`  ✅ ${events.length} events from MOPO`);
  return events;
}

// ═══ 3. Handelskammer Hamburg ═══
async function scrapeHandelskammer() {
  console.log('🏛️ Scraping Handelskammer...');
  try {
    // The event URLs from their homepage
    const eventUrls = [
      'https://events.handelskammer-hamburg.de/b?p=2026-2065',
      'https://events.handelskammer-hamburg.de/b?p=2026-2073',
      'https://events.handelskammer-hamburg.de/b?p=2026-2055',
    ];
    
    const events = [];
    for (const url of eventUrls) {
      try {
        const html = await fetch(url);
        if (!html || html.length < 200) continue;
        const $ = cheerio.load(html);
        const text = $('body').text();
        
        // Look for event info: title, date, description
        const title = $('h1, h2, .event-title').first().text().trim() || $('title').text().trim();
        if (!title) continue;
        
        // Parse date from "DD.MM.YYYY" format
        const dateMatch = text.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
        if (!dateMatch) continue;
        const date = `${dateMatch[3]}-${String(dateMatch[2]).padStart(2,'0')}-${String(dateMatch[1]).padStart(2,'0')}`;
        
        // Extract time
        const timeMatch = text.match(/(\d{1,2}:\d{2})/);
        const time = timeMatch ? timeMatch[1] : '';
        
        // Skip online-only and non-networking events
        if (/online.veranstaltung/i.test(text) && !/hybrid|vor.ort/i.test(text)) continue;
        
        // Only networking-relevant events
        if (/stammtisch|netzwerk|network|gründer|founder|startup|after.?work/i.test(text)) {
          events.push({
            title,
            date,
            time,
            venue: 'Handelskammer Hamburg',
            url,
            source: 'handelskammer',
            type: classifyType(title, text),
            description: text.substring(0, 300).replace(/\s+/g, ' ').trim()
          });
        }
      } catch (e) { /* skip individual event */ }
    }
    
    console.log(`  ✅ ${events.length} events from Handelskammer`);
    return events;
  } catch (e) {
    console.log(`  ❌ Handelskammer error: ${e.message}`);
    return [];
  }
}

// ═══ 4. rausgegangen.de (try cheerio first) ═══
async function scrapeRausgegangen() {
  console.log('🚶 Scraping rausgegangen.de...');
  try {
    const html = await fetch('https://rausgegangen.de/hamburg/');
    const $ = cheerio.load(html);
    const events = [];
    
    // Try to find event links/data in the HTML
    // rausgegangen uses /events/SLUG/ pattern
    $('a[href*="/events/"]').each((i, el) => {
      const href = $(el).attr('href');
      if (!href) return;
      const title = $(el).text().trim();
      if (!title || title.length < 5) return;
      
      const url = href.startsWith('http') ? href : `https://rausgegangen.de${href}`;
      
      events.push({
        title: title.substring(0, 200),
        date: '', // Will be filtered out if no date
        time: '',
        venue: 'Hamburg',
        url,
        source: 'rausgegangen',
        type: classifyType(title, ''),
        description: ''
      });
    });
    
    // If cheerio found nothing useful, try Playwright
    if (events.length < 3) {
      console.log('  ⚠️ Cheerio found few events, trying Playwright...');
      try {
        const pw = require('playwright-core');
        const browser = await pw.chromium.launch({
          executablePath: '/home/openclaw/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome',
          headless: true,
          args: ['--no-sandbox']
        });
        const page = await browser.newPage();
        await page.goto('https://rausgegangen.de/hamburg/', { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForTimeout(3000);
        
        const pwEvents = await page.evaluate(() => {
          const results = [];
          // Look for event cards
          document.querySelectorAll('a[href*="/events/"]').forEach(el => {
            const title = el.textContent?.trim();
            const href = el.getAttribute('href');
            if (title && title.length > 5 && href) {
              results.push({ title: title.substring(0, 200), href });
            }
          });
          return results;
        });
        
        await browser.close();
        
        for (const e of pwEvents) {
          events.push({
            title: e.title,
            date: '',
            time: '',
            venue: 'Hamburg',
            url: e.href.startsWith('http') ? e.href : `https://rausgegangen.de${e.href}`,
            source: 'rausgegangen',
            type: classifyType(e.title, ''),
            description: ''
          });
        }
      } catch (e) {
        console.log(`  ⚠️ Playwright failed: ${e.message}`);
      }
    }
    
    // Deduplicate by URL
    const seen = new Set();
    const unique = events.filter(e => {
      if (seen.has(e.url)) return false;
      seen.add(e.url);
      return true;
    });
    
    console.log(`  ✅ ${unique.length} events from rausgegangen.de`);
    return unique;
  } catch (e) {
    console.log(`  ❌ rausgegangen.de error: ${e.message}`);
    return [];
  }
}

// ═══ MAIN ═══
async function main() {
  console.log('═══ New Sources Scraper ═══');
  console.log(`📅 ${new Date().toISOString()}`);
  
  // Run all scrapers
  const [startupcity, mopo, handelskammer, rausgegangen] = await Promise.all([
    scrapeStartupCity(),
    scrapeMOPO(),
    scrapeHandelskammer(),
    scrapeRausgegangen(),
  ]);
  
  let allEvents = [...startupcity, ...mopo, ...handelskammer, ...rausgegangen];
  
  // Filter: must have date, must be relevant or from startupcity
  allEvents = allEvents.filter(e => {
    if (!e.date) return false;
    if (shouldExclude(e.title, e.description)) return false;
    // startupcity events are all relevant; others need keyword match
    if (e.source === 'startupcity') return true;
    if (e.source === 'mopo') return true; // Keep all MOPO tips
    return isRelevant(e.title, e.description);
  });
  
  // Deduplicate by normalized title
  const seen = new Set();
  allEvents = allEvents.filter(e => {
    const key = e.title.toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 40);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  
  // Sort by date
  allEvents.sort((a, b) => a.date.localeCompare(b.date));
  
  console.log(`\n═══ Total: ${allEvents.length} events ═══`);
  console.log(`  startupcity: ${startupcity.length}`);
  console.log(`  mopo: ${mopo.length}`);
  console.log(`  handelskammer: ${handelskammer.length}`);
  console.log(`  rausgegangen: ${rausgegangen.length}`);
  
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(allEvents, null, 2));
  console.log(`💾 Saved to ${OUTPUT_FILE}`);
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
