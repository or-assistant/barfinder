#!/usr/bin/env node
/**
 * 🏢 Hamburg Digital/Startup Ecosystem Events Scraper
 * Sources: hamburg-startups.net RSS, hamburg-business.com
 * (Originally intended for hamburg-atwork.de / digitalcluster-hamburg.de,
 *  but those domains are defunct. Using active Hamburg digital ecosystem sources.)
 * Saves to hamburgwork_events_cache.json
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const cheerio = require('cheerio');

const OUTPUT_FILE = __dirname + '/hamburgwork_events_cache.json';

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

function classifyType(title, desc) {
  const text = ((title || '') + ' ' + (desc || '')).toLowerCase();
  if (/startup|gründ|founder|pitch|accelerat|incubat/i.test(text)) return 'startup';
  if (/tech|digital|ai\b|ki\b|software|coding|hack/i.test(text)) return 'tech';
  if (/fintech|finance|invest|funding|venture/i.test(text)) return 'fintech';
  if (/network|meetup|after.?work|connect|community/i.test(text)) return 'networking';
  if (/workshop|seminar|training|learn/i.test(text)) return 'workshop';
  if (/konferenz|conference|summit|congress/i.test(text)) return 'conference';
  return 'business';
}

// Parse RSS/XML items
function parseRSS(xml) {
  const $ = cheerio.load(xml, { xmlMode: true });
  const items = [];
  $('item').each((_, el) => {
    const title = $(el).find('title').text().trim();
    const link = $(el).find('link').text().trim();
    const pubDate = $(el).find('pubDate').text().trim();
    const description = $(el).find('description').text().trim().replace(/<[^>]+>/g, '').substring(0, 300);
    const categories = [];
    $(el).find('category').each((_, cat) => categories.push($(cat).text().trim().toLowerCase()));
    items.push({ title, url: link, date: pubDate, description, categories });
  });
  return items;
}

async function scrapeHamburgStartupsRSS() {
  console.log('📡 Fetching hamburg-startups.net RSS...');
  const events = [];
  try {
    const xml = await fetch('https://www.hamburg-startups.net/feed/');
    const items = parseRSS(xml);
    
    // Filter for event-related posts
    const eventKeywords = /event|veranstaltung|meetup|konferenz|summit|workshop|pitch|award|hackathon|demo.?day|networking|after.?work|festival|camp|barcamp|starterin|food innovation/i;
    
    for (const item of items) {
      const isEvent = eventKeywords.test(item.title) || 
                      eventKeywords.test(item.description) ||
                      item.categories.some(c => /event/i.test(c));
      if (!isEvent) continue;
      
      // Try to extract date from text
      let eventDate = '';
      const dateMatch = item.description.match(/(\d{1,2})\.\s*((?:Januar|Februar|März|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember))\s*(\d{4})/i);
      if (dateMatch) {
        const months = { januar:1, februar:2, 'märz':3, april:4, mai:5, juni:6, juli:7, august:8, september:9, oktober:10, november:11, dezember:12 };
        const m = months[dateMatch[2].toLowerCase()];
        if (m) eventDate = `${dateMatch[3]}-${String(m).padStart(2,'0')}-${dateMatch[1].padStart(2,'0')}`;
      }
      if (!eventDate) {
        // Use pubDate as fallback
        const d = new Date(item.date);
        if (!isNaN(d)) eventDate = d.toISOString().split('T')[0];
      }
      
      events.push({
        title: item.title,
        date: eventDate,
        time: '',
        venue: 'Hamburg',
        description: item.description,
        url: item.url,
        type: classifyType(item.title, item.description),
        source: 'hamburg-startups'
      });
    }
    console.log(`  ✅ Found ${events.length} event-related posts from hamburg-startups.net`);
  } catch (e) {
    console.log(`  ⚠️ hamburg-startups.net RSS error: ${e.message}`);
  }
  return events;
}

async function scrapeHamburgBusiness() {
  console.log('📡 Fetching hamburg-business.com events...');
  const events = [];
  try {
    const html = await fetch('https://hamburg-business.com/de/hamburg-news');
    const $ = cheerio.load(html);
    
    // Look for event-related articles/links
    const eventKeywords = /event|veranstaltung|meetup|konferenz|summit|workshop|messe|networking|after.?work|digital|tech|startup|innovation/i;
    
    $('a[href*="event"], a[href*="veranstaltung"], h3 a, h2 a, .news-item a').each((_, el) => {
      const title = $(el).text().trim();
      const url = $(el).attr('href') || '';
      if (!title || title.length < 10) return;
      if (!eventKeywords.test(title)) return;
      
      const fullUrl = url.startsWith('http') ? url : `https://hamburg-business.com${url}`;
      events.push({
        title,
        date: '',
        time: '',
        venue: 'Hamburg',
        description: '',
        url: fullUrl,
        type: classifyType(title, ''),
        source: 'hamburg-business'
      });
    });
    console.log(`  ✅ Found ${events.length} events from hamburg-business.com`);
  } catch (e) {
    console.log(`  ⚠️ hamburg-business.com error: ${e.message}`);
  }
  return events;
}

async function main() {
  console.log('🏢 Hamburg Digital Ecosystem Events Scraper');
  console.log('═'.repeat(50));
  
  const [startupsEvents, businessEvents] = await Promise.all([
    scrapeHamburgStartupsRSS(),
    scrapeHamburgBusiness()
  ]);
  
  const allEvents = [...startupsEvents, ...businessEvents];
  
  // Deduplicate by title similarity
  const seen = new Set();
  const unique = allEvents.filter(e => {
    const key = e.title.toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 40);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  
  const output = {
    events: unique,
    fetchedAt: new Date().toISOString(),
    sources: ['hamburg-startups.net', 'hamburg-business.com']
  };
  
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  console.log(`\n✅ Saved ${unique.length} events to ${OUTPUT_FILE}`);
}

main().catch(e => { console.error('❌ Fatal:', e.message); process.exit(1); });
