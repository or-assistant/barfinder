#!/usr/bin/env node
/**
 * Facebook Events Scraper
 * Attempts to scrape bar events from Facebook using mobile site + stealth.
 * Gracefully handles login walls.
 */

const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const CHROMIUM_PATH = '/home/openclaw/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const CACHE_FILE = path.join(__dirname, 'facebook_events_cache.json');

const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1';

const BAR_PAGES = [
  { name: 'Aalhaus Hamburg', url: 'https://m.facebook.com/AalhausHamburg/events/' },
  { name: 'Frau Möller', url: 'https://m.facebook.com/FrauMoellerHamburg/events/' },
  { name: 'Christiansens', url: 'https://m.facebook.com/ChristiansensFineBar/events/' },
];

const SEARCH_URL = 'https://m.facebook.com/events/search/?q=hamburg+bar+party';

function randomDelay(min = 3000, max = 8000) {
  return new Promise(r => setTimeout(r, min + Math.random() * (max - min)));
}

async function dismissConsent(page) {
  const selectors = [
    'button[data-cookiebanner="accept_button"]',
    'button:has-text("Alle Cookies erlauben")',
    'button:has-text("Allow all cookies")',
    'button:has-text("Accept All")',
    'button:has-text("Alle akzeptieren")',
    '[title="Alle Cookies erlauben"]',
  ];
  for (const sel of selectors) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 2000 })) {
        await btn.click();
        console.log(`  ✓ Consent dismissed: ${sel}`);
        await page.waitForTimeout(1500);
        return true;
      }
    } catch {}
  }
  return false;
}

async function checkLoginWall(page) {
  const url = page.url();
  if (url.includes('/login') || url.includes('checkpoint')) {
    return true;
  }
  const hasLoginForm = await page.evaluate(() => {
    return !!document.querySelector('input[name="email"], #login_form, [data-sigil="login_password_input"]');
  });
  return hasLoginForm;
}

async function extractEvents(page) {
  return await page.evaluate(() => {
    const events = [];
    // Look for event cards/links
    const eventLinks = document.querySelectorAll('a[href*="/events/"]');
    for (const link of eventLinks) {
      const href = link.getAttribute('href');
      if (href && href.match(/\/events\/\d+/)) {
        const text = link.textContent.trim();
        if (text && text.length > 3 && text.length < 500) {
          events.push({ title: text.substring(0, 200), url: 'https://m.facebook.com' + href });
        }
      }
    }
    // Also look for structured event data
    const cards = document.querySelectorAll('[data-sigil*="event"], [class*="event"]');
    for (const card of cards) {
      const text = card.textContent.trim().substring(0, 300);
      if (text) events.push({ raw: text });
    }
    return events;
  });
}

async function scrapePage(browser, target) {
  const context = await browser.newContext({
    userAgent: MOBILE_UA,
    viewport: { width: 390, height: 844 },
    locale: 'de-DE',
    isMobile: true,
  });
  const page = await context.newPage();
  const label = target.name || target.url;
  console.log(`\n🔍 Scraping: ${label}`);
  console.log(`  URL: ${target.url}`);

  try {
    await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);
    await dismissConsent(page);
    await page.waitForTimeout(2000);

    if (await checkLoginWall(page)) {
      console.log(`  ⚠️  Login wall detected! URL: ${page.url()}`);
      const ssPath = path.join(__dirname, `debug_fb_${(target.name || 'search').replace(/[^a-z0-9]/gi, '_')}.png`);
      await page.screenshot({ path: ssPath });
      console.log(`  📸 Screenshot: ${ssPath}`);
      return { source: label, status: 'login_wall', url: page.url(), events: [], scrapedAt: new Date().toISOString() };
    }

    // Scroll to load more
    for (let i = 0; i < 3; i++) {
      await page.mouse.wheel(0, 500);
      await page.waitForTimeout(1000);
    }

    const events = await extractEvents(page);
    console.log(`  Found ${events.length} event references`);

    const ssPath = path.join(__dirname, `debug_fb_${(target.name || 'search').replace(/[^a-z0-9]/gi, '_')}.png`);
    await page.screenshot({ path: ssPath });

    return { source: label, status: 'ok', events, scrapedAt: new Date().toISOString() };
  } catch (err) {
    console.error(`  ✗ Error: ${err.message}`);
    return { source: label, status: 'error', error: err.message, events: [], scrapedAt: new Date().toISOString() };
  } finally {
    await context.close();
  }
}

async function main() {
  console.log('📘 Facebook Events Scraper');
  console.log('==========================\n');

  const browser = await chromium.launch({
    executablePath: CHROMIUM_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  });

  const results = [];
  try {
    // Try search first
    results.push(await scrapePage(browser, { name: 'Event Search', url: SEARCH_URL }));
    await randomDelay();

    // Try individual bar pages
    for (let i = 0; i < BAR_PAGES.length; i++) {
      results.push(await scrapePage(browser, BAR_PAGES[i]));
      if (i < BAR_PAGES.length - 1) await randomDelay();
    }
  } finally {
    await browser.close();
  }

  const cache = { lastUpdated: new Date().toISOString(), results };
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  console.log(`\n✅ Results saved to ${CACHE_FILE}`);
}

main().catch(console.error);
