#!/usr/bin/env node
/**
 * scrape_events_pipeline.js
 * Unified event scraper: Google News RSS, Abendblatt RSS, hamburg-tourism.de, + Meetup merge
 * Output: events_pipeline_cache.json
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const cheerio = require('cheerio');

const OUTPUT_FILE = path.join(__dirname, 'events_pipeline_cache.json');
const MEETUP_CACHE = path.join(__dirname, 'hamburg_new_events_cache.json');

const INCLUDE_KW = [
  'bar', 'after-work', 'afterwork', 'after work', 'networking', 'startup', 'founder',
  'gründer', 'wine', 'wein', 'tasting', 'verkostung', 'craft beer', 'pub', 'kneipe',
  'meetup', 'social', 'happy hour', 'biergarten', 'cocktail', 'drinks', 'nightlife',
  'nachtleben', 'stammtisch', 'mixer', 'mingle', 'get-together', 'kennenlernen',
  'speed dating', 'internationals', 'expat', 'language exchange', 'brunch',
  'founders', 'entrepreneur'
];

const EXCLUDE_KW = [
  'konzert', 'concert', 'theater', 'theatre', 'musical', 'oper', 'opera',
  'sport', 'marathon', 'messe', 'ausstellung', 'exhibition', 'tour', 'führung',
  'rundfahrt', 'kinder', 'familie', 'family', 'children', 'fußball', 'handball',
  'lauf', 'running', 'triathlon', 'yoga', 'fitness', 'museum'
];

function fetch(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BarfinderBot/1.0)' }, timeout: 15000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetch(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function relevanceScore(title, desc) {
  const text = `${title} ${desc}`.toLowerCase();
  let score = 30; // base
  for (const kw of EXCLUDE_KW) {
    if (text.includes(kw)) score -= 25;
  }
  for (const kw of INCLUDE_KW) {
    if (text.includes(kw)) score += 15;
  }
  return Math.max(0, Math.min(100, score));
}

function classifyType(title, desc) {
  const text = `${title} ${desc}`.toLowerCase();
  if (text.match(/network|startup|founder|gründer|entrepreneur/)) return 'networking';
  if (text.match(/after.?work/)) return 'afterwork';
  if (text.match(/tasting|verkostung|wine|wein/)) return 'tasting';
  if (text.match(/bar|pub|kneipe|cocktail|biergarten/)) return 'bar';
  return 'social';
}

function extractDate(dateStr) {
  if (!dateStr) return { date: null, time: null };
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return { date: null, time: null };
  const date = d.toISOString().split('T')[0];
  const h = d.getUTCHours(), m = d.getUTCMinutes();
  const time = (h || m) ? `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}` : null;
  return { date, time };
}

function parseRSSItems(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const tag = (name) => {
      const m = block.match(new RegExp(`<${name}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${name}>|<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`));
      return m ? (m[1] || m[2] || '').trim() : '';
    };
    items.push({
      title: tag('title'),
      description: tag('description'),
      link: tag('link'),
      pubDate: tag('pubDate')
    });
  }
  return items;
}

// ─── Source 1: Google News RSS ───
async function scrapeGoogleNews() {
  const queries = [
    'hamburg+bar+after+work',
    'hamburg+veranstaltung+networking',
    'hamburg+after+work+event',
    'hamburg+wine+tasting+bar'
  ];
  const events = [];
  for (const q of queries) {
    try {
      const url = `https://news.google.com/rss/search?q=${q}&hl=de&gl=DE&ceid=DE:de`;
      const xml = await fetch(url);
      const items = parseRSSItems(xml);
      for (const item of items) {
        const { date, time } = extractDate(item.pubDate);
        const score = relevanceScore(item.title, item.description);
        if (score >= 30) {
          events.push({
            title: item.title,
            description: item.description.substring(0, 300),
            date, time,
            venue: 'Hamburg',
            url: item.link,
            source: 'google-news',
            type: classifyType(item.title, item.description),
            relevanceScore: score
          });
        }
      }
      console.log(`  ✅ Google News "${q}": ${items.length} items`);
    } catch (e) {
      console.log(`  ⚠️ Google News "${q}" failed: ${e.message}`);
    }
  }
  return events;
}

// ─── Source 2: Abendblatt RSS ───
async function scrapeAbendblatt() {
  const events = [];
  try {
    const xml = await fetch('https://www.abendblatt.de/hamburg/rss');
    const items = parseRSSItems(xml);
    for (const item of items) {
      const score = relevanceScore(item.title, item.description);
      if (score >= 30) {
        const { date, time } = extractDate(item.pubDate);
        events.push({
          title: item.title,
          description: item.description.substring(0, 300),
          date, time,
          venue: 'Hamburg',
          url: item.link,
          source: 'abendblatt',
          type: classifyType(item.title, item.description),
          relevanceScore: score
        });
      }
    }
    console.log(`  ✅ Abendblatt: ${items.length} items, ${events.length} relevant`);
  } catch (e) {
    console.log(`  ⚠️ Abendblatt failed: ${e.message}`);
  }
  return events;
}

// ─── Source 3: hamburg-tourism.de ───
async function scrapeHamburgTourism() {
  const events = [];
  try {
    const html = await fetch('https://www.hamburg-tourism.de/sehen-erleben/veranstaltungen/veranstaltungskalender/');
    const $ = cheerio.load(html);
    // Try common event listing selectors
    $('article, .event-item, .veranstaltung, [class*="event"], .teaser').each((_, el) => {
      const $el = $(el);
      const title = $el.find('h2, h3, .title, .event-title').first().text().trim();
      const desc = $el.find('p, .description, .text, .teaser-text').first().text().trim();
      const dateText = $el.find('.date, time, .event-date, [class*="date"]').first().text().trim();
      const link = $el.find('a').first().attr('href') || '';
      
      if (!title || title.length < 5) return;
      
      const score = relevanceScore(title, desc);
      if (score >= 30) {
        const fullUrl = link.startsWith('http') ? link : `https://www.hamburg-tourism.de${link}`;
        // Try to parse date from text
        const dateMatch = dateText.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
        const date = dateMatch ? `${dateMatch[3]}-${dateMatch[2].padStart(2,'0')}-${dateMatch[1].padStart(2,'0')}` : null;
        const timeMatch = dateText.match(/(\d{1,2}):(\d{2})/);
        const time = timeMatch ? `${timeMatch[1].padStart(2,'0')}:${timeMatch[2]}` : null;
        
        events.push({
          title, description: desc.substring(0, 300),
          date, time,
          venue: 'Hamburg',
          url: fullUrl,
          source: 'hamburg-tourism',
          type: classifyType(title, desc),
          relevanceScore: score
        });
      }
    });
    console.log(`  ✅ Hamburg Tourism: ${events.length} relevant events`);
  } catch (e) {
    console.log(`  ⚠️ Hamburg Tourism failed: ${e.message}`);
  }
  return events;
}

// ─── Source 4: Merge existing Meetup cache ───
function loadMeetupCache() {
  const events = [];
  try {
    if (fs.existsSync(MEETUP_CACHE)) {
      const data = JSON.parse(fs.readFileSync(MEETUP_CACHE, 'utf8'));
      const raw = data.events || (Array.isArray(data) ? data : []);
      for (const e of raw) {
        events.push({
          title: e.title || e.name || '',
          description: (e.description || '').substring(0, 300),
          date: e.date || null,
          time: e.time || null,
          venue: e.venue || e.location || 'Hamburg',
          url: e.url || e.link || '',
          source: 'meetup',
          type: e.type || classifyType(e.title || '', e.description || ''),
          relevanceScore: e.relevanceScore || relevanceScore(e.title || '', e.description || '')
        });
      }
      console.log(`  ✅ Meetup cache: ${events.length} events merged`);
    } else {
      console.log(`  ℹ️ No meetup cache found at ${MEETUP_CACHE}`);
    }
  } catch (e) {
    console.log(`  ⚠️ Meetup cache load failed: ${e.message}`);
  }
  return events;
}

// ─── Deduplicate ───
function deduplicate(events) {
  const seen = new Map();
  for (const e of events) {
    const key = e.title.toLowerCase().replace(/[^a-zäöüß0-9]/g, '').substring(0, 60);
    const existing = seen.get(key);
    if (!existing || e.relevanceScore > existing.relevanceScore) {
      seen.set(key, e);
    }
  }
  return [...seen.values()];
}

// ─── Main ───
async function main() {
  console.log('🔄 Event Pipeline Scraper starting...');
  console.log(`   ${new Date().toISOString()}\n`);

  const [googleNews, abendblatt, tourism] = await Promise.all([
    scrapeGoogleNews(),
    scrapeAbendblatt(),
    scrapeHamburgTourism()
  ]);
  const meetup = loadMeetupCache();

  const all = [...googleNews, ...abendblatt, ...tourism, ...meetup];
  console.log(`\n📊 Total raw: ${all.length}`);

  const deduped = deduplicate(all);
  deduped.sort((a, b) => (b.relevanceScore - a.relevanceScore));

  console.log(`📊 After dedup: ${deduped.length}`);

  const output = {
    lastUpdated: new Date().toISOString(),
    totalEvents: deduped.length,
    sources: {
      'google-news': googleNews.length,
      'abendblatt': abendblatt.length,
      'hamburg-tourism': tourism.length,
      'meetup': meetup.length
    },
    events: deduped
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  console.log(`\n✅ Saved ${deduped.length} events to ${OUTPUT_FILE}`);
}

main().catch(e => {
  console.error('❌ Pipeline failed:', e.message);
  process.exit(1);
});
