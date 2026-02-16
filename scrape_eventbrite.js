#!/usr/bin/env node
/**
 * 🎫 Eventbrite Scraper via smry.ai Proxy
 * Scrapes Hamburg networking/social events from Eventbrite using smry.ai to bypass captcha
 */

const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const CACHE_FILE = path.join(__dirname, 'eventbrite_events_cache.json');
const CHROME_PATH = '/home/openclaw/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const WAIT_MS = 8000;
const PAUSE_BETWEEN_MS = 3000;

const SEARCHES = [
  { url: 'https://www.eventbrite.de/d/germany--hamburg/after-work/', type: 'afterwork' },
  { url: 'https://www.eventbrite.de/d/germany--hamburg/networking/', type: 'networking' },
  { url: 'https://www.eventbrite.de/d/germany--hamburg/wine-tasting/', type: 'tasting' },
  { url: 'https://www.eventbrite.de/d/germany--hamburg/social/', type: 'social' },
  { url: 'https://www.eventbrite.de/d/germany--hamburg/startup/', type: 'startup' },
];

const INCLUDE_RX = /after.?work|networking|social|tasting|meetup|startup|founder|pitch|gründer|entrepreneur|mixer|mingle|connect|community|happy.?hour/i;
const EXCLUDE_RX = /konzert|theater|kinder|online|webinar/i;
const EXCLUDE_PRICE_RX = /(\d+)\s*€/;

// Date parsing for Eventbrite formats
function parseEventDate(dateStr) {
  if (!dateStr) return { date: null, time: null };
  const s = dateStr.trim();
  
  // Format: "Wed, Feb 25, 7:30 PM" or "Wednesday, February 25, 7:30 PM"
  const fullMatch = s.match(/\w+,?\s+(\w+)\s+(\d{1,2}),?\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (fullMatch) {
    const [, monthStr, day, hour, min, ampm] = fullMatch;
    const month = monthToNum(monthStr);
    let h = parseInt(hour);
    if (ampm.toUpperCase() === 'PM' && h !== 12) h += 12;
    if (ampm.toUpperCase() === 'AM' && h === 12) h = 0;
    const year = new Date().getFullYear();
    const dateObj = new Date(year, month - 1, parseInt(day));
    // If date is in the past, assume next year
    if (dateObj < new Date(new Date().setHours(0,0,0,0)) - 86400000) dateObj.setFullYear(year + 1);
    return {
      date: `${dateObj.getFullYear()}-${String(dateObj.getMonth()+1).padStart(2,'0')}-${String(dateObj.getDate()).padStart(2,'0')}`,
      time: `${String(h).padStart(2,'0')}:${min}`
    };
  }
  
  // Format: "Wednesday at 7:30 PM" or "Tomorrow at 6:00 PM"
  const atMatch = s.match(/(\w+)\s+at\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (atMatch) {
    const [, dayWord, hour, min, ampm] = atMatch;
    let h = parseInt(hour);
    if (ampm.toUpperCase() === 'PM' && h !== 12) h += 12;
    if (ampm.toUpperCase() === 'AM' && h === 12) h = 0;
    const dateObj = dayWordToDate(dayWord);
    return {
      date: dateObj ? `${dateObj.getFullYear()}-${String(dateObj.getMonth()+1).padStart(2,'0')}-${String(dateObj.getDate()).padStart(2,'0')}` : null,
      time: `${String(h).padStart(2,'0')}:${min}`
    };
  }

  // German format: "Mi., 19. Feb., 19:30"
  const deMatch = s.match(/\w+\.?,?\s+(\d{1,2})\.?\s+(\w+)\.?,?\s+(\d{1,2}):(\d{2})/);
  if (deMatch) {
    const [, day, monthStr, hour, min] = deMatch;
    const month = monthToNum(monthStr);
    const year = new Date().getFullYear();
    return {
      date: `${year}-${String(month).padStart(2,'0')}-${String(parseInt(day)).padStart(2,'0')}`,
      time: `${String(parseInt(hour)).padStart(2,'0')}:${min}`
    };
  }

  return { date: null, time: null };
}

function monthToNum(m) {
  const map = { jan:1, feb:2, mar:3, mär:3, apr:4, may:5, mai:5, jun:6, jul:7, aug:8, sep:9, oct:10, okt:10, nov:11, dec:12, dez:12 };
  return map[(m||'').toLowerCase().slice(0,3)] || 1;
}

function dayWordToDate(word) {
  const now = new Date();
  const w = (word||'').toLowerCase();
  if (w === 'today' || w === 'heute') return now;
  if (w === 'tomorrow' || w === 'morgen') { const d = new Date(now); d.setDate(d.getDate()+1); return d; }
  const days = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  const daysShort = ['sun','mon','tue','wed','thu','fri','sat'];
  let idx = days.indexOf(w);
  if (idx === -1) idx = daysShort.indexOf(w.slice(0,3));
  if (idx === -1) return null;
  const d = new Date(now);
  const diff = (idx - d.getDay() + 7) % 7 || 7;
  d.setDate(d.getDate() + diff);
  return d;
}

function parseEventsFromText(text, searchType, searchUrl) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const events = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Skip sponsored
    if (/^Sponsored$/i.test(line)) continue;
    if (/^Promoted$/i.test(line)) continue;
    
    // Look for date patterns
    const isDate = /(?:\w+day\s+at\s+\d|(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\w*,?\s+\w+\s+\d|\w+\.,?\s+\d{1,2}\.?\s+\w+\.?,?\s+\d{1,2}:)/i.test(line);
    
    if (isDate) {
      // Title is typically the line before the date
      let title = '';
      for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
        const candidate = lines[j];
        // Skip short lines, prices, "Sponsored", etc.
        if (candidate.length > 5 && !/^(Sponsored|Promoted|Free|Kostenlos|\$|€|From|Ab\s)/i.test(candidate) && !/^\d+(\.\d+)?\s*(€|\$)/.test(candidate)) {
          title = candidate;
          break;
        }
      }
      
      if (!title || title.length < 3) continue;
      
      const { date, time } = parseEventDate(line);
      
      // Location: usually 1-2 lines after date
      let venue = 'Hamburg';
      for (let j = i + 1; j <= Math.min(lines.length - 1, i + 3); j++) {
        const loc = lines[j];
        if (/hamburg|altona|st\.?\s*pauli|eimsbüttel|winterhude|eppendorf|schanze|hafencity|barmbek|ottensen|wandsbek/i.test(loc)) {
          venue = loc;
          break;
        }
        // Generic venue line (not a date, not too short, not a button)
        if (loc.length > 5 && loc.length < 100 && !/^\d/.test(loc) && !/(Save|Share|Follow|Like|Sponsored|Promoted)/i.test(loc)) {
          venue = loc;
          break;
        }
      }
      
      events.push({ title, date, time, venue, url: searchUrl, source: 'eventbrite', type: searchType });
    }
  }
  
  return events;
}

function shouldInclude(event) {
  const text = `${event.title} ${event.venue} ${event.type}`.toLowerCase();
  
  // Check excludes
  if (EXCLUDE_RX.test(text)) return false;
  
  // Check expensive events
  const priceMatch = text.match(EXCLUDE_PRICE_RX);
  if (priceMatch && parseInt(priceMatch[1]) > 100) return false;
  
  // Always include if type matches
  if (['afterwork', 'networking', 'social', 'tasting', 'startup'].includes(event.type)) return true;
  
  // Check includes in title
  if (INCLUDE_RX.test(text)) return true;
  
  return false;
}

async function scrapeSearch(browser, search) {
  const proxyUrl = `https://smry.ai/proxy?url=${encodeURIComponent(search.url)}`;
  console.log(`  🔍 Scraping: ${search.type} → ${proxyUrl}`);
  
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();
  
  try {
    await page.goto(proxyUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(WAIT_MS);
    
    const bodyText = await page.evaluate(() => document.body.innerText);
    
    if (!bodyText || bodyText.length < 100) {
      console.log(`  ⚠️  ${search.type}: No content received (${(bodyText||'').length} chars)`);
      return [];
    }
    
    console.log(`  📄 ${search.type}: Got ${bodyText.length} chars`);
    const events = parseEventsFromText(bodyText, search.type, search.url);
    console.log(`  ✅ ${search.type}: Parsed ${events.length} events`);
    return events;
    
  } catch (err) {
    console.log(`  ❌ ${search.type}: ${err.message}`);
    return [];
  } finally {
    await context.close();
  }
}

async function main() {
  console.log('🎫 Eventbrite Scraper starting...');
  console.log(`   ${new Date().toISOString()}`);
  
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: CHROME_PATH,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
  } catch (err) {
    console.error('❌ Failed to launch browser:', err.message);
    process.exit(1);
  }
  
  let allEvents = [];
  
  for (let i = 0; i < SEARCHES.length; i++) {
    const search = SEARCHES[i];
    try {
      const events = await scrapeSearch(browser, search);
      allEvents.push(...events);
    } catch (err) {
      console.log(`  ❌ ${search.type} failed: ${err.message}`);
    }
    
    // Pause between searches (except last)
    if (i < SEARCHES.length - 1) {
      await new Promise(r => setTimeout(r, PAUSE_BETWEEN_MS));
    }
  }
  
  await browser.close();
  
  // Filter
  allEvents = allEvents.filter(shouldInclude);
  
  // Deduplicate by title (normalized)
  const seen = new Set();
  allEvents = allEvents.filter(e => {
    const key = e.title.toLowerCase().replace(/[^a-zäöüß0-9]/g, '');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  
  // Save
  fs.writeFileSync(CACHE_FILE, JSON.stringify(allEvents, null, 2));
  console.log(`\n🎫 Eventbrite: ${allEvents.length} events saved to ${CACHE_FILE}`);
}

main().catch(err => {
  console.error('❌ Eventbrite scraper fatal error:', err.message);
  process.exit(1);
});
