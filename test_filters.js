const {chromium} = require('playwright-core');

(async () => {
  const b = await chromium.launch({
    executablePath: '/home/openclaw/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome',
    headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  const p = await b.newPage();
  
  // Capture console logs
  const logs = [];
  p.on('console', msg => {
    if (msg.text().includes('[DEBUG]')) logs.push(msg.text());
  });
  
  await p.goto('http://localhost:3002/', {waitUntil: 'networkidle', timeout: 30000});
  console.log('Page loaded');
  
  // Wait for data to load
  await p.waitForTimeout(3000);
  
  // Check S.places
  const placesInfo = await p.evaluate(() => {
    const cats = {};
    (window.S?.places || []).forEach(p => { cats[p.category] = (cats[p.category]||0)+1; });
    return { total: window.S?.places?.length || 0, categories: cats };
  });
  console.log('S.places:', JSON.stringify(placesInfo));
  
  // Click Irish Pub filter
  console.log('\n=== Clicking Irish Pub filter ===');
  await p.evaluate(() => toggleFilter('irish'));
  await p.waitForTimeout(500);
  
  // Get debug logs
  console.log('Debug logs:', logs.join('\n'));
  
  // Check what's shown
  const shown = await p.evaluate(() => {
    const cards = document.querySelectorAll('#tonightSection .tc-card, #tonightSection [class*=card]');
    return Array.from(cards).slice(0, 5).map(c => c.textContent.substring(0, 100));
  });
  console.log('Shown cards:', shown.length);
  shown.forEach((c, i) => console.log(`  ${i}: ${c.trim().substring(0, 80)}`));
  
  // Test other filters
  logs.length = 0;
  console.log('\n=== Clicking Wine filter ===');
  await p.evaluate(() => { toggleFilter('irish'); toggleFilter('wine'); });
  await p.waitForTimeout(500);
  console.log('Debug logs:', logs.join('\n'));
  
  await b.close();
})().catch(e => console.error(e.message));
