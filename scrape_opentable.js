#!/usr/bin/env node
/**
 * 🍽️ OpenTable Hamburg Scraper
 * Scrapes restaurant/bar listings with ratings from opentable.de
 * Uses DOM extraction from restaurant card elements
 */

const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const CACHE_FILE = path.join(__dirname, 'opentable_cache.json');
const CHROME_PATH = '/home/openclaw/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';

async function main() {
  console.log('🍽️ OpenTable Hamburg Scraper starting...');
  
  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  
  const page = await browser.newPage({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    locale: 'de-DE'
  });
  
  console.log('  🔍 Loading OpenTable Hamburg...');
  await page.goto('https://www.opentable.de/hamburg-restaurants', { 
    waitUntil: 'domcontentloaded', timeout: 25000 
  }).catch(e => console.log('  ⚠️ Nav warning:', e.message));
  await page.waitForTimeout(6000);
  
  // Scroll to load more restaurants
  for (let i = 0; i < 10; i++) {
    await page.evaluate(() => window.scrollBy(0, 800));
    await page.waitForTimeout(1200);
  }
  
  console.log('  📊 Extracting restaurant data...');
  
  const restaurants = await page.evaluate(() => {
    const results = [];
    const seen = new Set();
    
    // Each restaurant card is an <a> linking to /r/
    const cards = document.querySelectorAll('a[href*="/r/"]');
    
    cards.forEach(card => {
      const href = card.getAttribute('href');
      if (!href || seen.has(href)) return;
      seen.add(href);
      
      const text = card.innerText || '';
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
      
      if (lines.length < 2) return;
      
      let name = null, rating = null, reviewCount = null;
      let cuisine = null, priceRange = null, neighborhood = null;
      let popularity = null, isSponsored = false;
      
      // Check for sponsored
      if (lines.some(l => l === 'Werbeanzeige')) isSponsored = true;
      
      // Skip known non-name labels
      const skipLabels = /^(Werbeanzeige|Heute|Zeitnah|Reservieren|Terrassensitzplätze|Preisgekrönt|Bestseller|Diners' Choice|Neu|Angebote)$/i;
      
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        
        // Skip labels
        if (skipLabels.test(l)) continue;
        
        // Rating: "4,5" or "4.5" (single decimal number)
        if (/^\d[,,\.]\d$/.test(l)) {
          rating = parseFloat(l.replace(',', '.'));
          continue;
        }
        
        // Review count: "399 Bewertungen"
        const revMatch = l.match(/^(\d[\d.,]*)\s*Bewertung/);
        if (revMatch) {
          reviewCount = parseInt(revMatch[1].replace(/[.,]/g, ''));
          continue;
        }
        
        // Rating text: "Hervorragend (399)" / "Sehr gut (123)"
        const ratingTextMatch = l.match(/^(Hervorragend|Fantastisch|Außergewöhnlich|Sehr gut|Gut)\s*\((\d+)\)$/);
        if (ratingTextMatch) {
          reviewCount = parseInt(ratingTextMatch[2]);
          continue;
        }
        
        // Cuisine€€€Neighborhood line
        const detMatch = l.match(/^([^€]+?)(€{1,4})\s*(.+)$/);
        if (detMatch) {
          cuisine = detMatch[1].trim();
          priceRange = detMatch[2];
          neighborhood = detMatch[3].trim();
          continue;
        }
        
        // Popularity: "Heute 42 mal reserviert"
        const popMatch = l.match(/Heute\s+(\d+)\s*mal reserviert/);
        if (popMatch) {
          popularity = parseInt(popMatch[1]);
          continue;
        }
        
        // Time slots like "19:00" "19:15" etc
        if (/^\d{1,2}:\d{2}$/.test(l)) continue;
        
        // "Keine Bewertungen verfügbar"
        if (/^Keine Bewertung/i.test(l)) continue;
        
        // Name: first qualifying line
        if (!name && l.length >= 2 && l.length <= 80) {
          name = l;
        }
      }
      
      if (!name || name.length < 2) return;
      
      // Build proper URL
      const url = href.startsWith('http') ? href : 'https://www.opentable.de' + href;
      
      results.push({
        name,
        rating,
        reviewCount,
        cuisine,
        priceRange,
        neighborhood,
        popularity,
        isSponsored,
        url,
        source: 'opentable'
      });
    });
    
    return results;
  });
  
  // Also try to get ratings from __NEXT_DATA__ or structured data
  const extraRatings = await page.evaluate(() => {
    const ratings = {};
    // LD+JSON
    document.querySelectorAll('script[type="application/ld+json"]').forEach(s => {
      try {
        const d = JSON.parse(s.textContent);
        if (d.name && d.aggregateRating) {
          ratings[d.name] = {
            rating: parseFloat(d.aggregateRating.ratingValue),
            reviewCount: parseInt(d.aggregateRating.reviewCount || '0')
          };
        }
      } catch(e) {}
    });
    return ratings;
  });
  
  // Merge extra ratings
  for (const r of restaurants) {
    if (extraRatings[r.name]) {
      if (!r.rating) r.rating = extraRatings[r.name].rating;
      if (!r.reviewCount) r.reviewCount = extraRatings[r.name].reviewCount;
    }
  }
  
  await browser.close();
  
  // Filter out garbage entries
  const clean = restaurants.filter(r => {
    if (!r.name || r.name.length < 2) return false;
    // Filter out UI elements that slipped through
    if (/^(History|Ask AI|Share|Suche|Los geht|FAQ|Anmelden|Mehr|Alle anzeigen)$/i.test(r.name)) return false;
    return true;
  });
  
  const result = {
    lastUpdated: new Date().toISOString(),
    source: 'opentable.de',
    restaurants: clean
  };
  
  fs.writeFileSync(CACHE_FILE, JSON.stringify(result, null, 2));
  
  const withRating = clean.filter(r => r.rating).length;
  const withCuisine = clean.filter(r => r.cuisine).length;
  console.log(`\n🍽️ OpenTable: ${clean.length} restaurants saved`);
  console.log(`   With rating: ${withRating}, with cuisine: ${withCuisine}`);
}

main().catch(err => {
  console.error('❌ Fatal error:', err.message);
  process.exit(1);
});
