const {chromium} = require('playwright-core');

(async () => {
  const b = await chromium.launch({
    executablePath: '/home/openclaw/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  const ctx = await b.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const p = await ctx.newPage();
  
  await p.goto('https://api-dashboard.search.brave.com/login', {waitUntil: 'networkidle', timeout: 30000});
  console.log('Login page loaded');
  
  await p.fill('input[name="email"]', 'oroessling_assistant@aol.com');
  await p.fill('input[name="password"]', 'Bajtyv-turfys-qagca2');
  
  // Find and click login button
  await p.click('button[type="submit"], button:has-text("Log in"), button:has-text("Login")');
  await p.waitForTimeout(5000);
  
  console.log('URL after login:', p.url());
  const text = await p.evaluate(() => document.body.innerText.substring(0, 1000));
  console.log(text);
  
  // If logged in, try to get API key
  if (p.url().includes('app') || p.url().includes('dashboard')) {
    console.log('=== LOGGED IN ===');
    await p.goto('https://api-dashboard.search.brave.com/app/keys', {waitUntil: 'networkidle', timeout: 15000});
    const keysText = await p.evaluate(() => document.body.innerText);
    console.log('Keys page:', keysText.substring(0, 1000));
  }
  
  await b.close();
})().catch(e => console.error('Error:', e.message));
