#!/usr/bin/env node
// Yelp Hamburg Bar Scraper — Playwright-based (Yelp blocks simple fetch)
// Usage: npx playwright install chromium && node scrape_yelp.js

const fs = require('fs');
const path = require('path');

async function main() {
  let playwright;
  try {
    playwright = require('playwright-core');
  } catch(e) {
    // Try dynamic import for npx-installed playwright
    const { chromium } = await import('playwright');
    playwright = { chromium };
  }
  
  const browser = await (playwright.chromium || playwright.default?.chromium).launch({ executablePath: '/home/openclaw/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome', 
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  console.log('🔍 Scraping Yelp Hamburg bars with Playwright...');
  const allBars = [];
  
  const urls = [
    'https://www.yelp.de/search?find_desc=bars&find_loc=Hamburg',
    'https://www.yelp.de/search?find_desc=bars&find_loc=Hamburg&start=10',
    'https://www.yelp.de/search?find_desc=cocktailbar&find_loc=Hamburg',
    'https://www.yelp.de/search?find_desc=kneipe+pub&find_loc=Hamburg',
  ];
  
  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'de-DE,de;q=0.9' });
  
  for (const url of urls) {
    try {
      console.log(`  📥 ${url}`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2000);
      
      // Extract business data from the page
      const bars = await page.evaluate(() => {
        const results = [];
        // Yelp search results are in list items with business info
        // Try multiple selector strategies
        
        // Strategy 1: JSON-LD
        const scripts = document.querySelectorAll('script[type="application/ld+json"]');
        for (const s of scripts) {
          try {
            const data = JSON.parse(s.textContent);
            const items = Array.isArray(data) ? data : [data];
            for (const item of items) {
              if (item['@type'] === 'LocalBusiness' || item['@type']?.includes('LocalBusiness')) {
                results.push({
                  name: item.name,
                  rating: parseFloat(item.aggregateRating?.ratingValue) || null,
                  reviewCount: parseInt(item.aggregateRating?.reviewCount) || null,
                  address: item.address?.streetAddress || null,
                  priceRange: item.priceRange || null,
                });
              }
            }
          } catch(e) {}
        }
        
        if (results.length > 0) return results;
        
        // Strategy 2: DOM scraping
        // Look for business cards/links
        const cards = document.querySelectorAll('[class*="container"] [class*="businessName"], h3 a[href*="/biz/"], [data-testid="serp-ia-card"]');
        for (const card of cards) {
          const parent = card.closest('[class*="container"]') || card.closest('li') || card.parentElement?.parentElement;
          if (!parent) continue;
          const nameEl = parent.querySelector('a[href*="/biz/"]');
          const name = nameEl?.textContent?.trim();
          if (!name || name.length < 2) continue;
          
          const text = parent.textContent;
          const ratingMatch = text.match(/(\d\.\d)/);
          const reviewMatch = text.match(/(\d+)\s*(?:Bewertung|review)/i);
          const priceMatch = text.match(/(€{1,4})/);
          
          results.push({
            name,
            rating: ratingMatch ? parseFloat(ratingMatch[1]) : null,
            reviewCount: reviewMatch ? parseInt(reviewMatch[1]) : null,
            address: null,
            priceRange: priceMatch ? priceMatch[1] : null,
          });
        }
        
        // Strategy 3: broad approach — all links to /biz/
        if (results.length === 0) {
          const links = document.querySelectorAll('a[href*="/biz/"]');
          const seen = new Set();
          for (const link of links) {
            const name = link.textContent?.trim();
            if (!name || name.length < 3 || name.length > 80 || seen.has(name)) continue;
            if (/yelp|sign|log|write|mehr|photo|review|map/i.test(name)) continue;
            seen.add(name);
            results.push({ name, rating: null, reviewCount: null, address: null, priceRange: null });
          }
        }
        
        return results;
      });
      
      console.log(`     → ${bars.length} bars found`);
      allBars.push(...bars);
      await page.waitForTimeout(1500 + Math.random() * 2000);
    } catch(e) {
      console.error(`  ❌ Error: ${e.message}`);
    }
  }
  
  await browser.close();
  
  // Deduplicate
  const seen = new Set();
  const unique = [];
  for (const bar of allBars) {
    const key = bar.name?.toLowerCase().replace(/\s+/g, '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(bar);
  }
  
  const output = { lastUpdated: new Date().toISOString(), source: 'yelp.de', bars: unique };
  const outPath = path.join(__dirname, 'yelp_cache.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\n✅ Saved ${unique.length} bars to ${outPath}`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
