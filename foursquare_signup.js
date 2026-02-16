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
  
  await p.goto('https://foursquare.com/developers/signup', {waitUntil: 'networkidle', timeout: 30000});
  console.log('On:', p.url());
  
  // Click "Sign up" link
  const signupLink = await p.$('a:has-text("Sign up")');
  if (signupLink) {
    await signupLink.click();
    await p.waitForTimeout(3000);
    console.log('After signup click:', p.url());
    
    const text = await p.evaluate(() => document.body.innerText.substring(0, 1500));
    console.log(text);
    
    // Try to fill signup form
    const emailInput = await p.$('input[name="email"], input[type="email"]');
    if (emailInput) {
      await emailInput.fill('oroessling_assistant@aol.com');
      // Look for password field
      const pwInput = await p.$('input[name="password"], input[type="password"]');
      if (pwInput) {
        await pwInput.fill('Bajtyv-turfys-qagca2');
      }
      // Submit
      const submitBtn = await p.$('button[type="submit"], button:has-text("Sign up"), button:has-text("Continue")');
      if (submitBtn) {
        await submitBtn.click();
        await p.waitForTimeout(5000);
        console.log('After submit:', p.url());
        const result = await p.evaluate(() => document.body.innerText.substring(0, 1000));
        console.log(result);
      }
    }
  } else {
    console.log('No signup link found');
  }
  
  await b.close();
})().catch(e => console.error('Error:', e.message));
