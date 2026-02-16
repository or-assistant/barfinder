const { chromium } = require('playwright-core');
const https = require('https');

const MAILTM_EMAIL = 'maxbergmann@dollicons.com';
const MAILTM_PASS = '4g7jRxxLZ_AIh59iWX0B_w';
const PROTON_USER = 'maxbergmann.hh';
const PROTON_PASS = 'Hb7xKm!42dPqWz9';

function httpJson(method, url, body, headers={}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = { hostname: u.hostname, path: u.pathname + u.search, method, headers: { 'Content-Type': 'application/json', ...headers } };
    const req = https.request(opts, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve({raw: d}); } }); });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

async function getMailToken() {
  const r = await httpJson('POST', 'https://api.mail.tm/token', { address: MAILTM_EMAIL, password: MAILTM_PASS });
  return r.token;
}

async function waitForCode(token, maxWait = 60000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    const msgs = await httpJson('GET', 'https://api.mail.tm/messages', null, { Authorization: 'Bearer ' + token });
    if (msgs['hydra:member']?.length > 0) {
      const msg = await httpJson('GET', 'https://api.mail.tm/messages/' + msgs['hydra:member'][0].id, null, { Authorization: 'Bearer ' + token });
      const text = msg.text || msg.html || '';
      const match = text.match(/\b(\d{6})\b/);
      if (match) return match[1];
    }
    await new Promise(r => setTimeout(r, 3000));
  }
  return null;
}

function fillInput(page, selector, value) {
  return page.evaluate(({sel, val}) => {
    const el = typeof sel === 'string' ? document.querySelector(sel) : sel;
    if (!el) return false;
    el.focus();
    const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    s.call(el, val);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
    return true;
  }, {sel: selector, val: value});
}

(async () => {
  const mailToken = await getMailToken();
  console.log('✅ Mail.tm token obtained');

  const browser = await chromium.launch({
    executablePath: '/home/openclaw/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome',
    headless: true,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled']
  });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 900 }, locale: 'de-DE'
  });
  const page = await ctx.newPage();
  await page.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => false }); });

  // Step 1: Load signup
  await page.goto('https://account.proton.me/signup?plan=free', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(3000);
  console.log('✅ Signup page loaded');

  // Step 2: Fill form
  await fillInput(page, '#username', PROTON_USER);
  await page.waitForTimeout(300);
  await fillInput(page, '#password', PROTON_PASS);
  await page.waitForTimeout(300);
  // Confirm password (second password field)
  const filled = await page.evaluate((pass) => {
    const pws = [...document.querySelectorAll('input[type=password]')];
    if (pws.length > 1) {
      pws[1].focus();
      const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      s.call(pws[1], pass);
      pws[1].dispatchEvent(new Event('input', { bubbles: true }));
      pws[1].dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    return false;
  }, PROTON_PASS);
  console.log('✅ Form filled, confirm pw:', filled);
  await page.screenshot({ path: '/tmp/proton_step2.png' });

  // Step 3: Submit
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('Beginne'));
    if (btn) btn.click();
  });
  console.log('✅ Submit clicked');
  await page.waitForTimeout(5000);

  // Step 4: Dismiss upsell if present
  const dismissed = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button, a')].find(b => b.textContent.includes('Nein, danke'));
    if (btn) { btn.click(); return true; }
    return false;
  });
  console.log(dismissed ? '✅ Upsell dismissed' : '⏩ No upsell');
  await page.waitForTimeout(3000);
  await page.screenshot({ path: '/tmp/proton_step4.png' });

  // Step 5: Handle verification
  const pageText = await page.evaluate(() => document.body.innerText);
  console.log('Page contains verification:', pageText.includes('Verification') || pageText.includes('Verifizierung'));

  // Find and fill verification email input
  const emailFilled = await page.evaluate((email) => {
    // Try all inputs in modals/dialogs
    const allInputs = document.querySelectorAll('input');
    for (const inp of allInputs) {
      if (inp.type === 'email' || (inp.placeholder && inp.placeholder.toLowerCase().includes('mail')) || 
          inp.getAttribute('data-testid')?.includes('email')) {
        inp.focus();
        const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        s.call(inp, email);
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
    }
    return false;
  }, MAILTM_EMAIL);
  console.log('Email verification input filled:', emailFilled);
  await page.waitForTimeout(500);
  await page.screenshot({ path: '/tmp/proton_step5.png' });

  // Click "Verifizierungscode anfordern"
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(b => 
      b.textContent.includes('Verifizierungscode') || b.textContent.includes('verification code') || b.textContent.includes('Send')
    );
    if (btn) { btn.click(); return true; }
    return false;
  });
  console.log('✅ Verification code requested');
  await page.waitForTimeout(5000);
  await page.screenshot({ path: '/tmp/proton_step5b.png' });

  // Step 6: Wait for code in mail.tm
  console.log('⏳ Waiting for verification code in inbox...');
  const code = await waitForCode(mailToken, 45000);
  
  if (code) {
    console.log('✅ Got code:', code);
    
    // Enter code
    await page.evaluate((c) => {
      const inputs = document.querySelectorAll('input');
      for (const inp of inputs) {
        if (inp.type === 'text' && inp.closest('[class*=erif]')) {
          const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          s.call(inp, c);
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          inp.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
    }, code);
    
    // Click verify
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find(b => 
        b.textContent.includes('Bestätigen') || b.textContent.includes('Verify') || b.textContent.includes('überprüfen')
      );
      if (btn) btn.click();
    });
    
    await page.waitForTimeout(15000);
    await page.screenshot({ path: '/tmp/proton_step6.png' });
    console.log('Final URL:', page.url());
  } else {
    console.log('❌ No code received');
    await page.screenshot({ path: '/tmp/proton_nocode.png' });
  }

  const finalText = await page.evaluate(() => document.body.innerText.substring(0, 1500));
  console.log(finalText);

  await browser.close();
})();
