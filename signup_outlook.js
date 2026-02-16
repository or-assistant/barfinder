const { chromium } = require('playwright-core');

const EMAIL = 'maxbergmann.hh@outlook.de';
const PASSWORD = 'Hb7xKm!42dPqWz9';

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  const browser = await chromium.launch({
    executablePath: '/home/openclaw/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome',
    headless: true,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled']
  });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 900 }, locale: 'de-DE', timezoneId: 'Europe/Berlin'
  });
  const page = await ctx.newPage();
  await page.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => false }); });

  // Step 1: Enter email
  await page.goto('https://signup.live.com/', { waitUntil: 'domcontentloaded', timeout: 15000 });
  await sleep(4000);
  const emailInput = await page.$('input[type=email], input#MemberName');
  await emailInput.click();
  await page.keyboard.type(EMAIL, { delay: 60 });
  await sleep(500);
  await page.click('#iSignupAction, button[type=submit]');
  console.log('✅ Step 1: Email entered');
  await sleep(5000);

  // Step 2: Password
  const pwInput = await page.$('input[type=password]');
  if (pwInput) {
    await pwInput.click();
    await page.keyboard.type(PASSWORD, { delay: 50 });
    await sleep(500);
    await page.click('#iSignupAction, button[type=submit]');
    console.log('✅ Step 2: Password entered');
  }
  await sleep(5000);
  await page.screenshot({ path: '/tmp/outlook_step2.png' });

  // Step 3: Name
  const firstNameInput = await page.$('#FirstName, input[name=FirstName]');
  if (firstNameInput) {
    await firstNameInput.click();
    await page.keyboard.type('Max', { delay: 60 });
    const lastNameInput = await page.$('#LastName, input[name=LastName]');
    if (lastNameInput) {
      await lastNameInput.click();
      await page.keyboard.type('Bergmann', { delay: 60 });
    }
    await sleep(500);
    await page.click('#iSignupAction, button[type=submit]');
    console.log('✅ Step 3: Name entered');
  }
  await sleep(5000);
  await page.screenshot({ path: '/tmp/outlook_step3.png' });

  // Step 4: Birthday
  const monthSelect = await page.$('#BirthMonth, select[name=BirthMonth]');
  if (monthSelect) {
    await monthSelect.selectOption('3'); // March
    const daySelect = await page.$('#BirthDay, select[name=BirthDay]');
    if (daySelect) await daySelect.selectOption('15');
    const yearInput = await page.$('#BirthYear, input[name=BirthYear]');
    if (yearInput) { await yearInput.click(); await page.keyboard.type('1988', { delay: 60 }); }
    await sleep(500);
    await page.click('#iSignupAction, button[type=submit]');
    console.log('✅ Step 4: Birthday entered');
  }
  await sleep(8000);
  await page.screenshot({ path: '/tmp/outlook_step4.png' });

  // Check what's next (captcha, phone, etc)
  console.log('URL:', page.url());
  const text = await page.evaluate(() => document.body.innerText.substring(0, 2000));
  console.log(text);
  
  // Check for captcha iframe
  const frames = page.frames();
  console.log('Frames:', frames.map(f => f.url()).filter(u => u !== 'about:blank'));

  // Screenshot
  await page.screenshot({ path: '/tmp/outlook_final.png' });

  await browser.close();
})();
