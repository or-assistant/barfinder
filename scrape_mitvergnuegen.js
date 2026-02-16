#!/usr/bin/env node
/**
 * 🎉 Mit Vergnügen Hamburg Scraper
 * Scrapes bar/restaurant tips and recommendations from hamburg.mitvergnuegen.com
 */

const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const CACHE_FILE = path.join(__dirname, 'mitvergnuegen_cache.json');
const CHROME_PATH = '/home/openclaw/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';

const BAR_KEYWORDS = /bar|kneipe|pub|cocktail|drink|wein|wine|bier|beer|after.?work|happy.?hour|trinken|aperitif|nightlife|nachtleben|feiern|party|rooftop|feierabend|day.?drinking|boozy/i;
const FOOD_KEYWORDS = /restaurant|essen|food|café|cafe|brunch|frühstück|pizza|burger|sushi|comfort|küche/i;

async function main() {
  console.log('🎉 Mit Vergnügen Hamburg Scraper starting...');
  
  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  
  const page = await browser.newPage({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  
  // Step 1: Get all article links from homepage
  console.log('  🔍 Scraping homepage...');
  await page.goto('https://hamburg.mitvergnuegen.com/', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(4000);
  try { await page.click('text=Akzeptieren', { timeout: 3000 }); } catch(e) {}
  await page.waitForTimeout(1000);
  
  // Scroll to load everything
  for (let i = 0; i < 15; i++) {
    await page.evaluate(() => window.scrollBy(0, 1500));
    await page.waitForTimeout(500);
  }
  await page.waitForTimeout(1000);
  
  // Extract articles: links have no text (image cards), so walk up to parent for title
  const articleLinks = await page.evaluate(() => {
    const results = [];
    const seen = new Set();
    document.querySelectorAll('a').forEach(a => {
      const href = a.href;
      if (href.indexOf('/202') === -1 || href.indexOf('mitvergnuegen') === -1) return;
      if (href.indexOf('/author/') > -1 || href.indexOf('/category/') > -1) return;
      if (seen.has(href)) return;
      seen.add(href);
      
      // Walk up to find containing card with text
      let el = a;
      let title = '';
      for (let up = 0; up < 5; up++) {
        el = el.parentElement;
        if (!el) break;
        const t = el.innerText || '';
        if (t.length > 15 && t.length < 300) {
          const firstLine = t.split('\n').map(l => l.trim())
            .filter(l => l.length > 10 && !/^(Von |MEHR|Mehr)/.test(l))[0];
          if (firstLine) { title = firstLine; break; }
        }
      }
      
      if (title) results.push({ url: href, title });
    });
    return results;
  });
  
  console.log(`  📋 Found ${articleLinks.length} articles`);
  
  // Categorize
  const articles = articleLinks.map(a => ({
    ...a,
    source: 'mitvergnuegen',
    isBarRelevant: BAR_KEYWORDS.test(a.title),
    isFoodRelevant: FOOD_KEYWORDS.test(a.title),
    scrapedAt: new Date().toISOString()
  }));
  
  // Step 2: Scrape bar/food articles for venue details
  const relevantArticles = articles.filter(a => a.isBarRelevant || a.isFoodRelevant).slice(0, 8);
  console.log(`  🍸 Scraping ${relevantArticles.length} bar/food articles for venues...`);
  
  let allBars = [];
  for (const article of relevantArticles) {
    console.log(`    📖 ${article.title.substring(0, 60)}...`);
    try {
      await page.goto(article.url, { waitUntil: 'networkidle', timeout: 20000 });
      await page.waitForTimeout(3000);
      
      const venues = await page.evaluate(() => {
        const text = document.body.innerText;
        const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
        const venues = [];
        
        for (let i = 0; i < lines.length; i++) {
          // Venue pattern: "Name\n,\nAddress, PLZ City"
          if (lines[i] === ',' && i >= 1 && i + 1 < lines.length) {
            const name = lines[i - 1];
            const address = lines[i + 1];
            if (name && name.length >= 2 && name.length <= 60 && address && /\d/.test(address) &&
                !/^(Von |MEHR|Copyright|MIT VERGNÜGEN|Franziska|Martyna|Anna|Lisa|Andreas|Lena|Tim)/.test(name)) {
              let neighborhood = null;
              const hoodMatch = address.match(/(Altona|St\.?\s*Pauli|Eimsbüttel|Winterhude|Sternschanze|Schanzenviertel|HafenCity|Barmbek|Ottensen|Wandsbek|Eppendorf|Neustadt|Altstadt|St\.?\s*Georg|Harvestehude|Rotherbaum|Uhlenhorst|Karoviertel|Bahrenfeld|Hamm|Eilbek|Hohenfelde|Hoheluft)/i);
              if (hoodMatch) neighborhood = hoodMatch[1];
              venues.push({ name, address, neighborhood });
            }
          }
        }
        return venues;
      });
      
      venues.forEach(v => {
        v.source = 'mitvergnuegen';
        v.articleUrl = article.url;
        v.articleTitle = article.title;
      });
      allBars.push(...venues);
    } catch(e) {
      console.log(`    ⚠️ Failed: ${e.message}`);
    }
    await page.waitForTimeout(2000);
  }
  
  await browser.close();
  
  // Deduplicate bars
  const seenBars = new Map();
  for (const bar of allBars) {
    const key = bar.name.toLowerCase().replace(/[^a-zäöüß0-9]/g, '');
    if (!seenBars.has(key)) seenBars.set(key, bar);
  }
  const dedupBars = Array.from(seenBars.values());
  
  const result = {
    lastUpdated: new Date().toISOString(),
    source: 'hamburg.mitvergnuegen.com',
    articles,
    events: articles.filter(a => /event|veranstaltung|festival|konzert|flohm/i.test(a.title)),
    barRelevant: articles.filter(a => a.isBarRelevant),
    foodRelevant: articles.filter(a => a.isFoodRelevant),
    bars: dedupBars
  };
  
  fs.writeFileSync(CACHE_FILE, JSON.stringify(result, null, 2));
  console.log(`\n🎉 Done: ${articles.length} articles, ${result.events.length} events, ${dedupBars.length} bars`);
  console.log(`   Bar-relevant: ${result.barRelevant.length}, Food-relevant: ${result.foodRelevant.length}`);
}

main().catch(err => {
  console.error('❌ Fatal error:', err.message);
  process.exit(1);
});
