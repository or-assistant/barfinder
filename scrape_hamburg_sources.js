#!/usr/bin/env node
/**
 * scrape_hamburg_sources.js
 * Scrapes NEW Hamburg event sources for bar/nightlife/networking events.
 * Sources: meetup.com, prinz.de
 * Output: hamburg_new_events_cache.json
 */

const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const OUTPUT_FILE = path.join(__dirname, 'hamburg_new_events_cache.json');

// Keywords that indicate relevant events
const INCLUDE_KEYWORDS = [
  'afterwork', 'after-work', 'after work', 'networking', 'meetup', 'social',
  'drinks', 'bar', 'cocktail', 'wine', 'wein', 'bier', 'beer', 'tasting',
  'verkostung', 'nightlife', 'nachtleben', 'party', 'pub', 'kneipen',
  'stammtisch', 'happy hour', 'mixer', 'mingle', 'get-together',
  'get together', 'kennenlernen', 'speed dating', 'speeddating',
  'internationals', 'expat', 'melting pot', 'language exchange',
  'sprachaustausch', 'brunch', 'breakfast networking', 'beehive',
  'founders', 'gründer', 'startup', 'entrepreneur'
];

// Keywords that indicate events to EXCLUDE
const EXCLUDE_KEYWORDS = [
  'konzert', 'concert', 'theater', 'theatre', 'musical', 'oper', 'opera',
  'sport', 'marathon', 'lauf', 'running', 'fußball', 'football', 'handball',
  'messe', 'congress', 'kongress', 'kinder', 'familie', 'family',
  'gottesdienst', 'kirche', 'church', 'flohmarkt', 'flea market',
  'stadtrundgang', 'stadtführung', 'city tour', 'sightseeing',
  'hafenrundfahrt', 'cruise', 'kreuzfahrt', 'museum', 'ausstellung',
  'exhibition', 'yoga', 'meditation', 'fitness', 'hund', 'dog',
  'erste hilfe', 'first aid', 'kieztour', 'sex & crime'
];

function isRelevantEvent(title, description = '') {
  const text = `${title} ${description}`.toLowerCase();
  const hasExclude = EXCLUDE_KEYWORDS.some(k => text.includes(k));
  if (hasExclude) return false;
  const hasInclude = INCLUDE_KEYWORDS.some(k => text.includes(k));
  return hasInclude;
}

function classifyType(title, description = '') {
  const text = `${title} ${description}`.toLowerCase();
  if (text.includes('afterwork') || text.includes('after-work') || text.includes('after work')) return 'afterwork';
  if (text.includes('tasting') || text.includes('verkostung') || text.includes('wine') || text.includes('wein')) return 'tasting';
  if (text.includes('party') || text.includes('nightlife') || text.includes('nachtleben')) return 'party';
  if (text.includes('networking') || text.includes('meetup') || text.includes('founders') || text.includes('startup') || text.includes('beehive') || text.includes('entrepreneur')) return 'networking';
  if (text.includes('social') || text.includes('melting pot') || text.includes('internationals') || text.includes('language') || text.includes('kennenlernen') || text.includes('speed dating')) return 'social';
  if (text.includes('stammtisch') || text.includes('drinks') || text.includes('bar') || text.includes('cocktail')) return 'bar';
  return 'networking';
}

// ─── Meetup.com ───
async function scrapeMeetup() {
  const queries = [
    'afterwork+drinks+bar',
    'networking+hamburg',
    'social+meetup+hamburg'
  ];
  const events = [];
  const seen = new Set();

  for (const query of queries) {
    const url = `https://www.meetup.com/find/?location=de--Hamburg&source=EVENTS&eventType=inPerson&query=${query}`;
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' }
      });
      const html = await res.text();
      
      // Meetup renders events as links with structured text
      // Parse from the HTML using regex since it's SSR
      const linkPattern = /\[([^\]]+?)((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[^\]]*?\d{1,2}\s*·\s*\d{1,2}:\d{2}\s*(?:AM|PM)\s*CET)by\s+([^\d]+?)[\d.]+\d+\s*attendees\]\((https:\/\/www\.meetup\.com\/[^)]+)\)/g;
      
      // Alternative: parse the raw text more carefully
      const $ = cheerio.load(html);
      
      // Try to find event data in script tags (Next.js data)
      const scripts = $('script').toArray();
      for (const script of scripts) {
        const content = $(script).html() || '';
        if (content.includes('__NEXT_DATA__')) {
          try {
            const jsonStr = content.replace('self.__next_f.push(', '').replace(/\)$/, '');
            // This is complex, fall back to text parsing
          } catch(e) {}
        }
      }
      
      // Parse from readable text format
      const text = await fetchReadable(url);
      if (!text) continue;
      
      // Parse meetup events from the readable text
      // Format: [TitleDateby GroupRatingAttendees](URL)
      const eventRegex = /\[(?:Waitlist)?(.+?)((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun|Every)[^·]*?·\s*(?:[A-Z][a-z]{2}\s+\d{1,2}\s*·\s*)?\d{1,2}:\d{2}\s*(?:AM|PM)\s*CET)by\s+(.+?)[\d.]+\d+\s*attendees\]\((https:\/\/www\.meetup\.com\/[^?)]+)/g;
      
      let match;
      while ((match = eventRegex.exec(text)) !== null) {
        const [, title, dateStr, group, eventUrl] = match;
        const cleanUrl = eventUrl.split('?')[0];
        if (seen.has(cleanUrl)) continue;
        seen.add(cleanUrl);
        
        const cleanTitle = title.trim();
        if (!isRelevantEvent(cleanTitle, group)) continue;
        
        // Parse date
        const dateMatch = dateStr.match(/([A-Z][a-z]{2})\s+(\d{1,2})/);
        const timeMatch = dateStr.match(/(\d{1,2}:\d{2}\s*(?:AM|PM))/);
        
        let date = '';
        if (dateMatch) {
          const months = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
          const month = months[dateMatch[1]] || '??';
          date = `2026-${month}-${dateMatch[2].padStart(2, '0')}`;
        }
        
        events.push({
          title: cleanTitle,
          date,
          time: timeMatch ? timeMatch[1].trim() : '',
          venue: group.trim(),
          url: cleanUrl,
          source: 'meetup.com',
          type: classifyType(cleanTitle, group)
        });
      }
    } catch (err) {
      console.error(`Meetup error (${query}):`, err.message);
    }
  }
  return events;
}

async function fetchReadable(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' }
    });
    const html = await res.text();
    // Extract text content
    const $ = cheerio.load(html);
    $('script, style, noscript').remove();
    return $.text();
  } catch(e) {
    return '';
  }
}

// ─── Meetup via text parsing (SSR) ───
async function scrapeMeetupHTML() {
  const events = [];
  const seen = new Set();
  const queries = ['afterwork', 'networking', 'social+drinks', 'bar+hamburg', 'stammtisch'];

  for (const query of queries) {
    const url = `https://www.meetup.com/find/?location=de--Hamburg&source=EVENTS&eventType=inPerson&query=${query}`;
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8'
        }
      });
      const html = await res.text();
      const $ = cheerio.load(html);

      // Meetup renders event cards as big <a> tags
      $('a[href*="/events/"]').each((_, el) => {
        const href = $(el).attr('href') || '';
        if (!href.includes('meetup.com') || !href.includes('/events/')) return;
        
        const cleanUrl = href.split('?')[0];
        if (seen.has(cleanUrl)) return;
        seen.add(cleanUrl);

        const text = $(el).text().trim();
        if (!text || text.length < 10) return;

        // Parse: "WaitlistTITLEDay, Mon DD · HH:MM AM/PM CETby GROUPrating attendees"
        // Split on date pattern
        const dayPattern = /((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun|Every\s+\w+)\s*[·,]\s*(?:[A-Z][a-z]{2}\s+\d{1,2}\s*·\s*)?\d{1,2}:\d{2}\s*(?:AM|PM)\s*CET)/;
        const splitMatch = text.match(dayPattern);
        
        let title = '';
        let dateStr = '';
        let timeStr = '';
        let group = '';

        if (splitMatch) {
          const idx = text.indexOf(splitMatch[1]);
          title = text.substring(0, idx).replace(/^Waitlist/, '').trim();
          dateStr = splitMatch[1];
          
          const afterDate = text.substring(idx + splitMatch[1].length);
          const groupMatch = afterDate.match(/by\s+(.+?)[\d.]+\d+\s*attendees/);
          if (groupMatch) group = groupMatch[1].trim();
        } else {
          title = text.substring(0, 80);
        }

        // Extract date components
        const monthDay = dateStr.match(/([A-Z][a-z]{2})\s+(\d{1,2})/);
        const timeMatch = dateStr.match(/(\d{1,2}:\d{2}\s*(?:AM|PM))/);

        let date = '';
        if (monthDay) {
          const months = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
          date = `2026-${months[monthDay[1]] || '??'}-${monthDay[2].padStart(2, '0')}`;
        }
        if (timeMatch) timeStr = timeMatch[1].trim();

        if (!isRelevantEvent(title, group)) return;

        events.push({
          title: title.substring(0, 120),
          date,
          time: timeStr,
          venue: group || 'Meetup Hamburg',
          url: cleanUrl,
          source: 'meetup.com',
          type: classifyType(title, group)
        });
      });
    } catch(err) {
      console.error(`Meetup HTML error (${query}):`, err.message);
    }
  }
  return events;
}

// ─── Prinz.de ───
async function scrapePrinz() {
  const events = [];
  const categories = ['stadtleben', 'special-events'];
  const seen = new Set();

  for (const cat of categories) {
    const url = `https://prinz.de/hamburg/events/kategorie/${cat}/`;
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' }
      });
      const html = await res.text();
      const $ = cheerio.load(html);

      // Parse event cards - look for h3 links with event info
      $('a[href*="/hamburg/events/"]').each((_, el) => {
        const href = $(el).attr('href') || '';
        if (!href.includes('/hamburg/events/') || href.endsWith('/events/') || href.includes('/kategorie/')) return;
        
        const fullUrl = href.startsWith('http') ? href : `https://prinz.de${href}`;
        if (seen.has(fullUrl)) return;
        seen.add(fullUrl);

        const title = $(el).text().trim();
        if (!title || title.length < 3) return;

        // Get surrounding context for date/time/venue
        const card = $(el).closest('div, article, li');
        const cardText = card.text();
        
        // Extract date (format: "So. 15.02.26" or "Mo. 16.02.26")
        const dateMatch = cardText.match(/(\d{2})\.(\d{2})\.(\d{2})/);
        let date = '';
        if (dateMatch) {
          date = `20${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}`;
        }

        // Extract time
        const timeMatch = cardText.match(/(\d{1,2}:\d{2})/);
        const time = timeMatch ? timeMatch[1] : '';

        // Look for venue (usually after the time)
        let venue = '';
        const venueMatch = cardText.match(/\d{1,2}:\d{2}\s+(.+?)(?:\s*©|$)/);
        if (venueMatch) venue = venueMatch[1].trim();

        // Filter: only bar/nightlife relevant
        if (!isRelevantEvent(title, `${venue} ${cardText}`)) return;

        events.push({
          title,
          date,
          time,
          venue: venue || 'Hamburg',
          url: fullUrl,
          source: 'prinz.de',
          type: classifyType(title, `${venue} ${cardText}`)
        });
      });
    } catch(err) {
      console.error(`Prinz error (${cat}):`, err.message);
    }
  }
  return events;
}

// ─── Main ───
async function main() {
  console.log('🔍 Scraping new Hamburg event sources...\n');
  
  const allEvents = [];

  // Meetup
  console.log('📡 Scraping meetup.com...');
  const meetupEvents = await scrapeMeetupHTML();
  console.log(`   Found ${meetupEvents.length} relevant events`);
  allEvents.push(...meetupEvents);

  // Prinz.de
  console.log('📡 Scraping prinz.de...');
  const prinzEvents = await scrapePrinz();
  console.log(`   Found ${prinzEvents.length} relevant events`);
  allEvents.push(...prinzEvents);

  // Deduplicate by URL
  const uniqueMap = new Map();
  for (const evt of allEvents) {
    const key = evt.url || `${evt.title}-${evt.date}`;
    if (!uniqueMap.has(key)) {
      uniqueMap.set(key, evt);
    }
  }
  const unique = Array.from(uniqueMap.values());

  // Sort by date
  unique.sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999'));

  console.log(`\n✅ Total: ${unique.length} unique bar/nightlife/networking events`);
  
  // Save
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(unique, null, 2));
  console.log(`💾 Saved to ${OUTPUT_FILE}`);
  
  // Print summary
  for (const evt of unique) {
    console.log(`  • [${evt.source}] ${evt.date} ${evt.time} — ${evt.title} @ ${evt.venue} (${evt.type})`);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
