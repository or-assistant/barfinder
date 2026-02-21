#!/usr/bin/env node
/**
 * Google Maps Popular Times Scraper
 * Uses playwright-core with stealth techniques to extract Popular Times data from Google Maps.
 */

const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const CHROMIUM_PATH = '/home/openclaw/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const CACHE_FILE = path.join(__dirname, 'google_popular_times_cache.json');

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
];

const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
  { width: 1366, height: 768 },
];

const BARS = [
  { name: 'Aalhaus Hamburg', query: 'Aalhaus Hamburg Bar' },
  { name: 'Frau Möller Hamburg', query: 'Frau Möller Hamburg Bar' },
  { name: "Christiansen's Hamburg", query: "Christiansen's Hamburg Bar" },
];

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function randomDelay(min = 3000, max = 8000) {
  return new Promise(r => setTimeout(r, min + Math.random() * (max - min)));
}

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

async function dismissConsent(page) {
  // Try multiple selectors for Google consent
  const selectors = [
    'button:has-text("Alle akzeptieren")',
    'button:has-text("Accept all")',
    'button:has-text("Alle ablehnen")',
    'button:has-text("Reject all")',
    '[aria-label="Alle akzeptieren"]',
    '[aria-label="Accept all"]',
    'form[action*="consent"] button:first-of-type',
  ];
  for (const sel of selectors) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 2000 })) {
        await btn.click();
        console.log(`  ✓ Consent dismissed via: ${sel}`);
        await page.waitForTimeout(2000);
        return true;
      }
    } catch {}
  }
  return false;
}

async function randomMouseMove(page) {
  for (let i = 0; i < 3; i++) {
    await page.mouse.move(200 + Math.random() * 800, 200 + Math.random() * 400);
    await page.waitForTimeout(100 + Math.random() * 300);
  }
}

async function extractPopularTimes(page) {
  return await page.evaluate(() => {
    const result = { popularTimes: {}, rating: null, reviewCount: null, livebusyness: null };

    // Rating
    const ratingEl = document.querySelector('[class*="fontDisplayLarge"], span.ceNzKf, span[aria-hidden="true"]');
    if (ratingEl) {
      const val = parseFloat(ratingEl.textContent);
      if (val > 0 && val <= 5) result.rating = val;
    }

    // Try getting rating from aria-label on stars
    if (!result.rating) {
      const starsEl = document.querySelector('[role="img"][aria-label*="star"], [role="img"][aria-label*="Stern"]');
      if (starsEl) {
        const m = starsEl.getAttribute('aria-label').match(/([\d,.]+)/);
        if (m) result.rating = parseFloat(m[1].replace(',', '.'));
      }
    }

    // Review count
    const reviewEls = document.querySelectorAll('[aria-label*="review"], [aria-label*="Rezension"], button[jsaction*="review"]');
    for (const el of reviewEls) {
      const label = el.getAttribute('aria-label') || el.textContent;
      const m = label.match(/([\d.,]+)\s*(review|Rezension|Bewertung)/i);
      if (m) { result.reviewCount = parseInt(m[1].replace(/[.,]/g, '')); break; }
    }
    if (!result.reviewCount) {
      // Try text pattern like "(1,234)"
      const allText = document.body.innerText;
      const m = allText.match(/\(([\d.,]+)\s*(?:review|Rezension|Bewertung)/i);
      if (m) result.reviewCount = parseInt(m[1].replace(/[.,]/g, ''));
    }

    // Popular Times - look for the histogram bars
    // Google uses aria-label on divs like "Currently 45% busy" or percentage-based heights
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
                       'Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
    
    // Method 1: aria-label based bars
    const bars = document.querySelectorAll('[aria-label*="busy"], [aria-label*="ausgelastet"], [aria-label*="% um"], [aria-label*="% at"]');
    if (bars.length > 0) {
      for (const bar of bars) {
        const label = bar.getAttribute('aria-label') || '';
        const pctMatch = label.match(/(\d+)\s*%/);
        if (pctMatch) {
          // Try to figure out day and hour from context
          // These are typically grouped by day
        }
      }
    }

    // Method 2: Look for the popular times section by heading
    const headings = document.querySelectorAll('h2, h3, [class*="header"]');
    for (const h of headings) {
      const text = h.textContent.toLowerCase();
      if (text.includes('popular times') || text.includes('stoßzeiten') || text.includes('beliebte zeiten')) {
        result._foundSection = true;
        break;
      }
    }

    // Method 3: Extract from graph elements with height-based percentages
    const graphBars = document.querySelectorAll('[style*="height"][aria-label], .g2BVhd');
    for (const bar of graphBars) {
      const style = bar.getAttribute('style') || '';
      const label = bar.getAttribute('aria-label') || '';
      const heightMatch = style.match(/height:\s*(\d+)/);
      if (heightMatch) {
        // Collect bar data
      }
    }

    // Live busyness
    const liveEls = document.querySelectorAll('[class*="live"], [aria-label*="Live"]');
    for (const el of liveEls) {
      const text = el.textContent || el.getAttribute('aria-label') || '';
      if (text.match(/live|aktuell/i)) {
        result.livebusyness = text.trim();
        break;
      }
    }

    // Broader approach: get ALL aria-labels that contain percentage+time patterns
    const allElements = document.querySelectorAll('[aria-label]');
    const timeData = [];
    for (const el of allElements) {
      const label = el.getAttribute('aria-label');
      // Pattern like "40 % ausgelastet um 18 Uhr." or "40% busy at 6 PM."
      if (label && (label.match(/\d+\s*%.*(?:um|at)\s*\d+/i) || label.match(/(?:Usually|Normalerweise).*\d+\s*%/i))) {
        timeData.push(label);
      }
    }
    if (timeData.length > 0) {
      result._rawTimeLabels = timeData;
    }

    return result;
  });
}

async function scrapeBar(browser, bar) {
  const viewport = pick(VIEWPORTS);
  const context = await browser.newContext({
    userAgent: pick(USER_AGENTS),
    viewport,
    locale: 'de-DE',
    geolocation: { latitude: 53.5511, longitude: 9.9937 },
    permissions: ['geolocation'],
  });

  const page = await context.newPage();
  console.log(`\n🔍 Scraping: ${bar.name}`);

  try {
    // Search Google Maps
    const url = `https://www.google.com/maps/search/${encodeURIComponent(bar.query)}`;
    console.log(`  URL: ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    // Dismiss consent
    await dismissConsent(page);
    await randomMouseMove(page);
    await page.waitForTimeout(3000);

    // Check if we landed on a place page or search results
    // If search results, click first result
    try {
      const firstResult = page.locator('a[href*="/maps/place/"]').first();
      if (await firstResult.isVisible({ timeout: 3000 })) {
        await firstResult.click();
        console.log('  ✓ Clicked first search result');
        await page.waitForTimeout(3000);
      }
    } catch {}

    await randomMouseMove(page);

    // Scroll the left panel down aggressively to find Popular Times
    const scrollable = page.locator('[role="main"], .m6QErb.DxyBCb').first();
    for (let i = 0; i < 12; i++) {
      try {
        await scrollable.evaluate(el => {
          // Find the scrollable container inside the panel
          const containers = el.querySelectorAll('[class*="m6QErb"], [tabindex="-1"]');
          for (const c of containers) {
            if (c.scrollHeight > c.clientHeight) { c.scrollBy(0, 500); return; }
          }
          el.scrollBy(0, 500);
        });
      } catch {
        await page.mouse.wheel(0, 500);
      }
      await page.waitForTimeout(600);
    }
    
    // Also try clicking on specific day tabs if Popular Times section exists
    // and scroll within the panel area by moving mouse there first
    await page.mouse.move(250, 400);
    for (let i = 0; i < 5; i++) {
      await page.mouse.wheel(0, 400);
      await page.waitForTimeout(500);
    }

    // Extract data
    const data = await extractPopularTimes(page);
    
    // Also get the page title / place name for verification
    const title = await page.title();
    console.log(`  Page title: ${title}`);
    
    // Get the visible place name
    const placeName = await page.evaluate(() => {
      const h1 = document.querySelector('h1');
      return h1 ? h1.textContent.trim() : null;
    });
    console.log(`  Place name: ${placeName || 'not found'}`);
    console.log(`  Rating: ${data.rating || 'not found'}`);
    console.log(`  Reviews: ${data.reviewCount || 'not found'}`);
    console.log(`  Live: ${data.livebusyness || 'not found'}`);
    console.log(`  Popular Times labels found: ${(data._rawTimeLabels || []).length}`);
    
    if (data._rawTimeLabels && data._rawTimeLabels.length > 0) {
      console.log(`  Sample labels: ${data._rawTimeLabels.slice(0, 3).join(' | ')}`);
      // Parse the labels into structured data
      data.popularTimes = parseTimeLabels(data._rawTimeLabels);
    }

    // Take a screenshot for debugging
    const ssPath = path.join(__dirname, `debug_${bar.name.replace(/[^a-z0-9]/gi, '_')}.png`);
    await page.screenshot({ path: ssPath, fullPage: false });
    console.log(`  📸 Screenshot: ${ssPath}`);

    return {
      query: bar.query,
      name: placeName || bar.name,
      rating: data.rating,
      reviewCount: data.reviewCount,
      livebusyness: data.livebusyness,
      popularTimes: data.popularTimes || {},
      rawLabelsCount: (data._rawTimeLabels || []).length,
      scrapedAt: new Date().toISOString(),
    };
  } catch (err) {
    console.error(`  ✗ Error: ${err.message}`);
    return { query: bar.query, name: bar.name, error: err.message, scrapedAt: new Date().toISOString() };
  } finally {
    await context.close();
  }
}

function parseTimeLabels(labels) {
  const days = {};
  // Try to parse labels like "40 % ausgelastet um 18 Uhr" or "40% busy at 6 PM"
  for (const label of labels) {
    const deMatch = label.match(/(\d+)\s*%.*um\s*(\d+)\s*Uhr/i);
    const enMatch = label.match(/(\d+)\s*%.*at\s*(\d+)\s*(AM|PM)?/i);
    if (deMatch) {
      const pct = parseInt(deMatch[1]);
      const hour = parseInt(deMatch[2]);
      // We don't know the day from a single label, store by hour
      if (!days['_unknown']) days['_unknown'] = {};
      days['_unknown'][hour] = pct;
    } else if (enMatch) {
      const pct = parseInt(enMatch[1]);
      let hour = parseInt(enMatch[2]);
      if (enMatch[3] === 'PM' && hour < 12) hour += 12;
      if (enMatch[3] === 'AM' && hour === 12) hour = 0;
      if (!days['_unknown']) days['_unknown'] = {};
      days['_unknown'][hour] = pct;
    }
  }
  return days;
}

async function main() {
  console.log('🍺 Google Maps Popular Times Scraper');
  console.log('=====================================\n');

  const browser = await chromium.launch({
    executablePath: CHROMIUM_PATH,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
    ],
  });

  const results = {};
  try {
    for (let i = 0; i < BARS.length; i++) {
      const bar = BARS[i];
      results[bar.name] = await scrapeBar(browser, bar);
      if (i < BARS.length - 1) {
        const delay = 3000 + Math.random() * 5000;
        console.log(`  ⏳ Waiting ${(delay / 1000).toFixed(1)}s...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  } finally {
    await browser.close();
  }

  // Save results
  const cache = { lastUpdated: new Date().toISOString(), bars: results };
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  console.log(`\n✅ Results saved to ${CACHE_FILE}`);
}

main().catch(console.error);
