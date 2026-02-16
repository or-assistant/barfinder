#!/usr/bin/env node
/**
 * Hamburg Events Scraper
 * Scrapes szene-hamburg.de and hamburg.de for bar/nightlife events.
 * Uses fetch + cheerio for lightweight scraping.
 */

const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const CACHE_FILE = path.join(__dirname, 'hamburg_events_cache.json');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
};

const SOURCES = [
  {
    name: 'szene-hamburg-bars',
    url: 'https://www.szene-hamburg.de/thema/bar/',
    parse: parseSzeneHamburg,
  },
  {
    name: 'szene-hamburg-nachtleben',
    url: 'https://www.szene-hamburg.de/thema/nachtleben/',
    parse: parseSzeneHamburg,
  },
  {
    name: 'hamburg-de-veranstaltungen',
    url: 'https://www.hamburg.de/veranstaltungen/',
    parse: parseHamburgDe,
  },
  {
    name: 'hamburg-de-nightlife',
    url: 'https://www.szene-hamburg.de/thema/club/',
    parse: parseSzeneHamburg,
  },
];

function parseSzeneHamburg(html, sourceUrl) {
  const $ = cheerio.load(html);
  const items = [];

  // Articles / post cards
  $('article, .post, .entry, .teaser, [class*="card"], [class*="article"]').each((_, el) => {
    const $el = $(el);
    const title = $el.find('h1, h2, h3, h4, .title, .headline').first().text().trim();
    const link = $el.find('a[href]').first().attr('href');
    const excerpt = $el.find('p, .excerpt, .description, .teaser-text').first().text().trim();
    const img = $el.find('img').first().attr('src');

    if (title && title.length > 3) {
      items.push({
        title: title.substring(0, 200),
        url: link ? new URL(link, sourceUrl).href : null,
        excerpt: excerpt ? excerpt.substring(0, 300) : null,
        image: img || null,
      });
    }
  });

  // Fallback: just get all links with headlines
  if (items.length === 0) {
    $('a[href]').each((_, el) => {
      const $el = $(el);
      const text = $el.text().trim();
      const href = $el.attr('href');
      if (text.length > 10 && text.length < 200 && href && !href.startsWith('#')) {
        items.push({ title: text, url: new URL(href, sourceUrl).href });
      }
    });
  }

  return items;
}

function parseHamburgDe(html, sourceUrl) {
  const $ = cheerio.load(html);
  const items = [];

  // Event cards or list items
  $('article, .teaser, .event, [class*="event"], [class*="card"], .list-item, [class*="teaser"]').each((_, el) => {
    const $el = $(el);
    const title = $el.find('h1, h2, h3, h4, .title, .headline').first().text().trim();
    const link = $el.find('a[href]').first().attr('href');
    const date = $el.find('time, .date, [class*="date"]').first().text().trim();
    const location = $el.find('.location, [class*="location"], [class*="venue"]').first().text().trim();
    const desc = $el.find('p, .description, .text').first().text().trim();

    if (title && title.length > 3) {
      items.push({
        title: title.substring(0, 200),
        url: link ? new URL(link, sourceUrl).href : null,
        date: date || null,
        location: location || null,
        description: desc ? desc.substring(0, 300) : null,
      });
    }
  });

  // Fallback
  if (items.length === 0) {
    $('a[href]').each((_, el) => {
      const text = $(el).text().trim();
      const href = $(el).attr('href');
      if (text.length > 10 && text.length < 200 && href) {
        items.push({ title: text, url: new URL(href, sourceUrl).href });
      }
    });
  }

  return items;
}

async function scrapeSource(source) {
  console.log(`\n🔍 Scraping: ${source.name}`);
  console.log(`  URL: ${source.url}`);

  try {
    const resp = await fetch(source.url, { headers: HEADERS, redirect: 'follow', signal: AbortSignal.timeout(15000) });
    console.log(`  Status: ${resp.status}`);

    if (!resp.ok) {
      return { source: source.name, url: source.url, status: resp.status, items: [], error: `HTTP ${resp.status}` };
    }

    const html = await resp.text();
    console.log(`  HTML size: ${(html.length / 1024).toFixed(1)} KB`);

    const items = source.parse(html, source.url);
    // Deduplicate by title
    const seen = new Set();
    const unique = items.filter(i => {
      if (seen.has(i.title)) return false;
      seen.add(i.title);
      return true;
    });

    console.log(`  Found ${unique.length} items`);
    if (unique.length > 0) {
      console.log(`  Sample: "${unique[0].title}"`);
    }

    return { source: source.name, url: source.url, status: resp.status, items: unique, scrapedAt: new Date().toISOString() };
  } catch (err) {
    console.error(`  ✗ Error: ${err.message}`);
    return { source: source.name, url: source.url, error: err.message, items: [], scrapedAt: new Date().toISOString() };
  }
}

async function main() {
  console.log('🎉 Hamburg Events Scraper');
  console.log('========================\n');

  const results = [];
  for (const source of SOURCES) {
    results.push(await scrapeSource(source));
    // Small delay between requests
    await new Promise(r => setTimeout(r, 1000 + Math.random() * 2000));
  }

  const cache = { lastUpdated: new Date().toISOString(), sources: results };
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  console.log(`\n✅ Results saved to ${CACHE_FILE}`);

  // Summary
  console.log('\n📊 Summary:');
  for (const r of results) {
    console.log(`  ${r.source}: ${r.items.length} items ${r.error ? '⚠️ ' + r.error : '✓'}`);
  }
}

main().catch(console.error);
