const {chromium} = require('playwright-core');

(async () => {
  const b = await chromium.launch({
    executablePath: '/home/openclaw/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  const ctx = await b.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    locale: 'de-DE'
  });
  const p = await ctx.newPage();
  
  console.log('Navigating to Foursquare developer signup...');
  await p.goto('https://foursquare.com/developers/signup', {waitUntil: 'networkidle', timeout: 30000});
  console.log('URL:', p.url());
  console.log('Title:', await p.title());
  
  const text = await p.evaluate(() => document.body.innerText.substring(0, 1500));
  console.log(text);
  
  await b.close();
})().catch(e => console.error('Error:', e.message));
