#!/usr/bin/env node
/**
 * Facebook Events Scraper for Hamburg Bars/Clubs
 * Uses Puppeteer + Stealth to scrape public Facebook event search results.
 * 
 * Usage: node facebook_events_scraper.js [query] [--output path.json]
 * Default query: "hamburg bar"
 * 
 * Note: Works WITHOUT login for public events. Facebook shows a login popup
 * but the event data is already in the page HTML/JSON.
 */

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');

puppeteer.use(StealthPlugin());

const SEARCH_QUERIES = [
  'hamburg bar',
  'hamburg club party',
  'hamburg kneipe',
  'hamburg cocktailbar',
  'hamburg live musik bar',
];

async function scrapeEvents(query, browser) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  );
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8' });

  const url = `https://www.facebook.com/events/search/?q=${encodeURIComponent(query)}`;
  console.log(`  Fetching: ${url}`);

  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  
  // Wait a bit for dynamic content
  await new Promise(r => setTimeout(r, 2000));

  const html = await page.content();
  const events = [];

  // Extract structured data from JSON script blocks in the page
  // Facebook embeds Relay query results as <script type="application/json" data-sjs>
  const inlineScripts = html.match(/<script type="application\/json"[^>]*>([^<]+)<\/script>/g) || [];
  
  const findEdges = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    if (obj.serpResponse?.results?.edges) {
      for (const edge of obj.serpResponse.results.edges) {
        const profile = edge?.rendering_strategy?.view_model?.profile;
        if (profile) {
          events.push({
            eventId: profile.id,
            name: profile.name,
            url: profile.eventUrl || profile.url,
            date: profile.day_time_sentence,
            venue: profile.event_place?.contextual_name,
            isOnline: profile.is_online,
            isPast: profile.is_past,
            startTimestamp: profile.start_timestamp,
            socialContext: profile.social_context?.text,
            coverPhoto: profile.cover_photo?.photo?.eventImage?.uri,
            ticketPrice: profile.ticketing_context_row?.price_range_text,
          });
        }
      }
    }
    for (const v of Object.values(obj)) findEdges(v);
  };

  for (const scriptTag of inlineScripts) {
    const jsonStr = scriptTag.replace(/<script[^>]*>/, '').replace(/<\/script>/, '');
    try {
      const data = JSON.parse(jsonStr);
      if (JSON.stringify(data).includes('start_timestamp')) {
        findEdges(data);
      }
    } catch (e) {
      // skip unparseable blocks
    }
  }

  // Fallback: extract from aria-labels if JSON parsing found nothing
  if (events.length === 0) {
    const ariaEvents = await page.evaluate(() => {
      const links = document.querySelectorAll('a[aria-label][href*="/events/"]');
      return Array.from(links).map(link => ({
        name: link.getAttribute('aria-label'),
        url: link.href,
        eventId: link.href.match(/\/events\/(\d+)/)?.[1],
      }));
    });
    for (const ae of ariaEvents) {
      events.push({
        eventId: ae.eventId,
        name: ae.name,
        url: ae.url,
        source: 'aria-label-fallback',
      });
    }
  }

  await page.close();
  return events;
}

async function main() {
  const args = process.argv.slice(2);
  const customQuery = args.find(a => !a.startsWith('--'));
  const outputIdx = args.indexOf('--output');
  const outputPath = outputIdx >= 0 ? args[outputIdx + 1] : path.join(__dirname, 'facebook_events_cache.json');

  const queries = customQuery ? [customQuery] : SEARCH_QUERIES;

  console.log('Facebook Events Scraper for Hamburg');
  console.log('===================================');

  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: '/usr/bin/google-chrome',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--window-size=1920,1080',
      '--lang=de-DE,de',
    ],
  });

  const allEvents = [];
  const seen = new Set();

  for (const query of queries) {
    console.log(`\nSearching: "${query}"`);
    try {
      const events = await scrapeEvents(query, browser);
      console.log(`  Found ${events.length} events`);
      for (const event of events) {
        if (event.eventId && !seen.has(event.eventId)) {
          seen.add(event.eventId);
          event.searchQuery = query;
          event.scrapedAt = new Date().toISOString();
          allEvents.push(event);
        }
      }
    } catch (e) {
      console.error(`  Error: ${e.message}`);
    }
    // Be polite
    await new Promise(r => setTimeout(r, 2000 + Math.random() * 3000));
  }

  await browser.close();

  console.log(`\nTotal unique events: ${allEvents.length}`);

  // Save results
  const output = {
    scrapedAt: new Date().toISOString(),
    totalEvents: allEvents.length,
    events: allEvents,
  };

  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`Saved to: ${outputPath}`);

  // Print summary
  for (const event of allEvents.slice(0, 10)) {
    console.log(`  - ${event.name} | ${event.date || 'no date'} | ${event.venue || 'no venue'}`);
  }
}

main().catch(e => {
  console.error('Fatal error:', e.message);
  process.exit(1);
});
