const {chromium} = require('playwright-core');

(async () => {
  const b = await chromium.launch({
    executablePath: '/home/openclaw/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  const p = await b.newPage();
  await p.goto('https://api-dashboard.search.brave.com/register', {waitUntil: 'networkidle', timeout: 30000});
  
  await p.fill('#email', 'oroessling_assistant@aol.com');
  await p.fill('#password', 'Bajtyv-turfys-qagca2');
  await p.fill('#passwordVerification', 'Bajtyv-turfys-qagca2');
  await p.fill('#name', 'Oliver Roessling');
  await p.fill('#company', 'CAPS & COLLARS GmbH');
  await p.selectOption('#referral', 'search_engine');
  
  console.log('Form filled. Waiting for PoW...');
  await p.waitForFunction(() => !document.getElementById('captcha-button')?.disabled, {timeout: 120000});
  console.log('PoW solved. Submitting...');
  
  const [response] = await Promise.all([
    p.waitForResponse(r => r.url().includes('register'), {timeout: 15000}).catch(() => null),
    p.click('#captcha-button')
  ]);
  if (response) console.log('Response status:', response.status());
  
  await p.waitForTimeout(5000);
  console.log('URL:', p.url());
  
  // Check for alerts/errors
  const alerts = await p.evaluate(() => {
    const els = document.querySelectorAll('.alert, [class*=error], [class*=alert], [class*=success], [class*=message]');
    return Array.from(els).map(e => e.textContent.trim()).filter(t => t.length > 3);
  });
  if (alerts.length) console.log('Alerts:', JSON.stringify(alerts));
  
  const bodyText = await p.textContent('body');
  if (bodyText.includes('verify')) console.log('>>> VERIFY EMAIL NEEDED');
  if (bodyText.includes('already')) console.log('>>> ALREADY REGISTERED');
  if (bodyText.includes('success')) console.log('>>> SUCCESS');
  if (bodyText.includes('dashboard')) console.log('>>> DASHBOARD REACHED');
  
  // Get visible messages
  const msgs = await p.evaluate(() => {
    return Array.from(document.querySelectorAll('p, h2, h3')).map(e => e.textContent.trim()).filter(t => t.length > 5 && t.length < 200);
  });
  console.log('Messages:', JSON.stringify(msgs.slice(0, 10)));
  
  await b.close();
})().catch(e => console.error('Error:', e.message));
