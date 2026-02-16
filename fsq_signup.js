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
  
  // Go directly to signup
  await p.goto('https://auth.studio.foursquare.com/u/signup/identifier?state=hKFo2SBJNEE1SWljNEg2QkRWSDk2cDYtTGpaLVFzbm1lZGh2NqFur3VuaXZlcnNhbC1sb2dpbqN0aWTZIFpuOGFhU2ZZaVBVY05hR3gzV2R3UndTSmQ4UG5HdDl2o2NpZNkgZFZ5NzFrNkV4ejd6Y3BJUnBRaEJoWGZTTjRvY2dqRkU', {waitUntil: 'networkidle', timeout: 30000});

  // Fill email
  await p.fill('input[name="email"]', 'oroessling_assistant@aol.com');
  await p.click('button[type="submit"]');
  await p.waitForTimeout(3000);
  
  console.log('After email:', p.url());
  let text = await p.evaluate(() => document.body.innerText.substring(0, 1000));
  console.log(text);
  
  // Should now show password field
  const pwField = await p.$('input[name="password"], input[type="password"]');
  if (pwField) {
    console.log('Password field found');
    await pwField.fill('Bajtyv-turfys-qagca2');
    // Look for name fields
    const nameField = await p.$('input[name="name"], input[name="username"]');
    if (nameField) await nameField.fill('Oliver Roessling');
    
    await p.click('button[type="submit"]');
    await p.waitForTimeout(5000);
    console.log('After password submit:', p.url());
    text = await p.evaluate(() => document.body.innerText.substring(0, 1000));
    console.log(text);
  }
  
  await b.close();
})().catch(e => console.error('Error:', e.message));
