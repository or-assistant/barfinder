#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// 🍻 Yelp Reviews Scraper via smry.ai Proxy
// Scrapes bar names, ratings, and review snippets from Yelp Hamburg
// ═══════════════════════════════════════════════════════════════

const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const CHROME_PATH = '/home/openclaw/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const OUTPUT_FILE = path.join(__dirname, 'yelp_reviews_cache.json');
const LEGACY_FILE = path.join(__dirname, 'yelp_cache.json');

const SEARCHES = [
  { desc: 'Bars', loc: 'Hamburg', category: 'bars' },
  { desc: 'Kneipen', loc: 'Hamburg', category: 'kneipen' },
  { desc: 'Cocktail+Bars', loc: 'Hamburg', category: 'cocktail' },
  { desc: 'Wine+Bars', loc: 'Hamburg', category: 'wine' },
  { desc: 'Pubs', loc: 'Hamburg', category: 'pubs' },
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function normalizeBarName(name) {
  return (name || '').toLowerCase().replace(/[^a-zäöüß0-9]/g, '').trim();
}

function parseYelpResults(text, category) {
  const results = [];
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  
  let currentBar = null;
  let skipUntilNext = false;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Skip sponsored entries
    if (/sponsored|gesponsert|anzeige/i.test(line)) {
      skipUntilNext = true;
      continue;
    }
    
    // Match numbered listing: "1. Bar Name" — the bar name line
    const numberedMatch = line.match(/^(\d{1,2})\.\s*(.+)/);
    if (numberedMatch) {
      if (skipUntilNext) { skipUntilNext = false; continue; }
      
      // Save previous bar
      if (currentBar && currentBar.name) results.push(currentBar);
      
      let rawName = numberedMatch[2].trim();
      currentBar = { name: rawName, rating: null, reviewSnippet: null, source: 'yelp', searchCategory: category };
      
      // The next line(s) often contain rating + metadata like:
      // "4.5 (13 reviews)Neustadt€€Open until..." or "4,5 star rating"
      // Check the NEXT line for rating info
      if (i + 1 < lines.length) {
        const nextLine = lines[i + 1];
        // Pattern: starts with rating like "4.5" or "4,5" followed by review count/metadata
        const rMatch = nextLine.match(/^(\d[.,]\d)\s*(?:\((\d+)\s*review|\((\d+)\s*Bewertung)?/i);
        if (rMatch) {
          currentBar.rating = parseFloat(rMatch[1].replace(',', '.'));
          const rc = rMatch[2] || rMatch[3];
          if (rc) currentBar.reviewCount = parseInt(rc);
          i++; // skip this line
        }
      }
      continue;
    }
    
    if (!currentBar) continue;
    
    // Standalone rating line
    const ratingMatch = line.match(/^(\d[.,]\d)\s*(?:\((\d+)\s*review|\((\d+)\s*Bewertung|Stern|star)?/i);
    if (ratingMatch && !currentBar.rating) {
      currentBar.rating = parseFloat(ratingMatch[1].replace(',', '.'));
      const rc = ratingMatch[2] || ratingMatch[3];
      if (rc) currentBar.reviewCount = parseInt(rc);
      continue;
    }
    
    // Review snippet: quotes or longer text
    if (!currentBar.reviewSnippet) {
      const snippetMatch = line.match(/^[""„](.+?)["""]/) || 
                           line.match(/^"(.+)"$/);
      if (snippetMatch) {
        currentBar.reviewSnippet = snippetMatch[1].trim().substring(0, 200);
        continue;
      }
      
      // Longer text that looks like a review (not UI metadata)
      if (line.length > 40 && line.length < 300 && 
          !/^(Öffnungszeiten|Adresse|Telefon|Webseite|Bewertung|Filter|Sort|Yelp|Hamburg|Euro|€|\d+ Ergebnisse|Open until|Closed|Geöffnet|Geschlossen|reviews?\)|Bewertung)/i.test(line) &&
          !/^(Bars|Kneipen|Pubs|Cocktail|Wine|Restaurants|Neustadt|Altstadt|St\.\s*Pauli|Altona|Eimsbüttel)/i.test(line) &&
          !/€€|€€€|\$\$/.test(line.substring(0, 10))) {
        currentBar.reviewSnippet = line.substring(0, 200);
      }
    }
  }
  
  // Push last bar
  if (currentBar && currentBar.name) results.push(currentBar);
  
  // Clean up names: remove trailing metadata that got merged
  for (const bar of results) {
    // Remove patterns like "Bar Name4.5 (13 reviews)Neustadt€€Open until..."
    bar.name = bar.name
      .replace(/\d[.,]\d\s*\(\d+\s*(reviews?|Bewertung)\).*$/i, '')
      .replace(/€€.*$/, '')
      .replace(/\$\$.*$/, '')
      .replace(/(Neustadt|Altstadt|St\.\s*Pauli|Altona|Eimsbüttel|Sternschanze|Ottensen|Barmbek|Winterhude|Eppendorf|HafenCity|St\.\s*Georg|Harvestehude|Rotherbaum|Uhlenhorst).*$/i, '')
      .replace(/Open until.*$/i, '')
      .replace(/Closed.*$/i, '')
      .replace(/Geöffnet.*$/i, '')
      .replace(/Geschlossen.*$/i, '')
      .trim();
    
    // Extract rating from name if it got merged
    if (!bar.rating) {
      const embeddedRating = bar.name.match(/(\d[.,]\d)\s*\(/);
      if (embeddedRating) {
        bar.rating = parseFloat(embeddedRating[1].replace(',', '.'));
        bar.name = bar.name.replace(/\d[.,]\d\s*\(.*$/, '').trim();
      }
    }
  }
  
  // Filter out garbage entries (names that are just numbers, metadata, or too short)
  return results.filter(b => 
    b.name.length >= 2 && 
    b.name.length <= 60 && 
    !/^\d+$/.test(b.name) &&
    !/^\d+\s*\(\d+\s*review/i.test(b.name) &&
    !/^\d+\s*\(\d+\s*Bewertung/i.test(b.name) &&
    !/^(Open|Closed|Geöffnet|Geschlossen)/i.test(b.name)
  );
}

async function scrapeYelpSearch(page, searchDesc, searchLoc, category, includePage2) {
  const yelpUrl = `https://www.yelp.de/search?find_desc=${searchDesc}&find_loc=${searchLoc}`;
  const proxyUrl = `https://smry.ai/proxy?url=${encodeURIComponent(yelpUrl)}`;
  
  console.log(`  📡 Fetching: ${searchDesc} in ${searchLoc}...`);
  
  let allResults = [];
  
  try {
    await page.goto(proxyUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(10000); // Wait for smry.ai to render
    
    const text = await page.evaluate(() => document.body.innerText);
    const results = parseYelpResults(text, category);
    console.log(`    → Page 1: ${results.length} bars found`);
    allResults.push(...results);
    
    // Try page 2
    if (includePage2) {
      await sleep(3000);
      const page2Url = `https://www.yelp.de/search?find_desc=${searchDesc}&find_loc=${searchLoc}&start=10`;
      const proxy2Url = `https://smry.ai/proxy?url=${encodeURIComponent(page2Url)}`;
      
      console.log(`  📡 Fetching page 2: ${searchDesc}...`);
      try {
        await page.goto(proxy2Url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(10000);
        
        const text2 = await page.evaluate(() => document.body.innerText);
        const results2 = parseYelpResults(text2, category);
        console.log(`    → Page 2: ${results2.length} bars found`);
        allResults.push(...results2);
      } catch (e) {
        console.log(`    ⚠️ Page 2 failed: ${e.message}`);
      }
    }
  } catch (e) {
    console.log(`    ❌ Failed: ${e.message}`);
  }
  
  return allResults;
}

async function main() {
  console.log('🍻 Yelp Reviews Scraper starting...\n');
  
  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  
  const page = await context.newPage();
  let allBars = [];
  
  for (let i = 0; i < SEARCHES.length; i++) {
    const s = SEARCHES[i];
    // Only fetch page 2 for the first 2 categories to stay under 10 requests
    const includePage2 = i < 2;
    
    const results = await scrapeYelpSearch(page, s.desc, s.loc, s.category, includePage2);
    allBars.push(...results);
    
    if (i < SEARCHES.length - 1) {
      console.log('  ⏳ Waiting 3s...');
      await sleep(3000);
    }
  }
  
  await browser.close();
  
  // Deduplicate by normalized name
  const seen = new Map();
  for (const bar of allBars) {
    const key = normalizeBarName(bar.name);
    if (!key) continue;
    if (!seen.has(key)) {
      seen.set(key, bar);
    } else {
      // Merge: keep rating if missing
      const existing = seen.get(key);
      if (!existing.rating && bar.rating) existing.rating = bar.rating;
      if (!existing.reviewSnippet && bar.reviewSnippet) existing.reviewSnippet = bar.reviewSnippet;
    }
  }
  
  const deduplicated = Array.from(seen.values());
  
  // Save yelp_reviews_cache.json
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(deduplicated, null, 2));
  console.log(`\n✅ Saved ${deduplicated.length} bars to ${OUTPUT_FILE}`);
  
  // Also update legacy yelp_cache.json format for server.js compatibility
  const legacyData = {
    lastUpdated: new Date().toISOString(),
    source: 'yelp.de',
    bars: deduplicated.map(b => ({
      name: b.name,
      rating: b.rating,
      reviewCount: null,
      reviewSnippet: b.reviewSnippet,
      source: 'yelp',
      searchCategory: b.searchCategory
    }))
  };
  fs.writeFileSync(LEGACY_FILE, JSON.stringify(legacyData, null, 2));
  console.log(`✅ Updated legacy ${LEGACY_FILE} with ${legacyData.bars.length} bars`);
  
  // Stats
  const withRating = deduplicated.filter(b => b.rating).length;
  const withSnippet = deduplicated.filter(b => b.reviewSnippet).length;
  console.log(`\n📊 Stats: ${deduplicated.length} total, ${withRating} with rating, ${withSnippet} with review snippet`);
}

main().catch(e => {
  console.error('💥 Fatal error:', e.message);
  process.exit(1);
});
