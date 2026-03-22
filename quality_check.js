#!/usr/bin/env node
/**
 * Barfinder Quality Check — runs automatically via cron
 * Detects and fixes: duplicates, bad coords, category issues, stale data
 */

const fs = require('fs');
const path = require('path');

const HIGHLIGHTS_PATH = path.join(__dirname, 'highlights.json');
const REPORT_PATH = path.join(__dirname, 'quality_report.json');

function run() {
  const h = JSON.parse(fs.readFileSync(HIGHLIGHTS_PATH, 'utf8'));
  const issues = [];
  let autoFixes = 0;

  // 1. EXACT NAME DUPLICATES
  const nameMap = new Map();
  const toRemove = new Set();
  h.forEach((p, i) => {
    const k = p.name.toLowerCase().trim();
    if (nameMap.has(k)) {
      issues.push({ type: 'duplicate', severity: 'high', name: p.name, index: i, existingIndex: nameMap.get(k) });
      toRemove.add(i);
      autoFixes++;
    } else {
      nameMap.set(k, i);
    }
  });

  // 2. COORDINATE DUPLICATES (same spot, different names — flag for review)
  const coordMap = new Map();
  h.forEach((p, i) => {
    if (toRemove.has(i)) return;
    const k = p.lat.toFixed(4) + ',' + p.lon.toFixed(4);
    if (!coordMap.has(k)) coordMap.set(k, []);
    coordMap.get(k).push({ i, name: p.name });
  });
  coordMap.forEach((entries, coord) => {
    if (entries.length > 1) {
      issues.push({ type: 'coord_overlap', severity: 'medium', coord, names: entries.map(e => e.name) });
    }
  });

  // 3. MISSING ESSENTIAL DATA
  h.forEach((p, i) => {
    if (toRemove.has(i)) return;
    if (!p.lat || !p.lon) issues.push({ type: 'no_coords', severity: 'critical', name: p.name, index: i });
    if (!p.category) issues.push({ type: 'no_category', severity: 'high', name: p.name, index: i });
    if (!p.name || p.name.trim().length < 2) issues.push({ type: 'no_name', severity: 'critical', index: i });
  });

  // 4. CATEGORY CONSISTENCY
  h.forEach((p, i) => {
    if (toRemove.has(i)) return;
    if (p.category === 'weinbar') {
      p.category = 'wine';
      autoFixes++;
    }
  });

  // 5. UNPARSEABLE OPENING HOURS
  h.forEach((p, i) => {
    if (toRemove.has(i)) return;
    if (!p.opening_hours) return;
    if (p.opening_hours === 'Eventabhängig' || p.opening_hours === 'varies') {
      p.opening_hours = '';
      p.opening_hours_estimated = true;
      autoFixes++;
      issues.push({ type: 'bad_hours_fixed', severity: 'low', name: p.name, was: 'Eventabhängig' });
    }
    // Check for hours without proper time format
    if (p.opening_hours && !/\d{1,2}:\d{2}/.test(p.opening_hours) && p.opening_hours !== '24/7') {
      issues.push({ type: 'unparseable_hours', severity: 'medium', name: p.name, hours: p.opening_hours });
    }
  });

  // 6. COORDINATES OUTSIDE VALID RANGE (Hamburg + rural area)
  h.forEach((p, i) => {
    if (toRemove.has(i)) return;
    if (p.lat < 53.3 || p.lat > 54.7 || p.lon < 9.4 || p.lon > 10.5) {
      issues.push({ type: 'coords_out_of_range', severity: 'critical', name: p.name, lat: p.lat, lon: p.lon });
    }
  });

  // 7. STALE DATA CHECK
  const noHoursCount = h.filter((p, i) => !toRemove.has(i) && !p.opening_hours).length;
  const noWebsiteCount = h.filter((p, i) => !toRemove.has(i) && !p.website).length;
  const noDescCount = h.filter((p, i) => !toRemove.has(i) && !p.description).length;

  // Apply auto-fixes
  if (toRemove.size > 0) {
    const cleaned = h.filter((_, i) => !toRemove.has(i));
    fs.writeFileSync(HIGHLIGHTS_PATH, JSON.stringify(cleaned, null, 2));
    console.log(`Auto-removed ${toRemove.size} duplicates`);
  } else {
    // Still save category/hours fixes
    fs.writeFileSync(HIGHLIGHTS_PATH, JSON.stringify(h, null, 2));
  }

  // ── Category auto-correction ──
  let catFixes = 0;
  const catRules = [
    { test: /^(bar)$/, nameTest: /cocktail/i, descTest: /cocktailbar|speakeasy|mixology/i, to: 'cocktailbar' },
    { test: /^(bar|restaurant)$/, nameTest: /wein|wine|vino|vin\b/i, descTest: /weinbar|wine.?bar|vinothek|weinstube/i, to: 'wine', exclude: /irish|pub|cocktail/i },
    { test: /^(bar|pub)$/, nameTest: /biergarten|beer.?garden/i, descTest: /biergarten|brauerei.*garten/i, to: 'biergarten' },
    { test: /^(pub|bar)$/, nameTest: /^café\b|^cafe\b/i, descTest: null, to: 'cafe', exclude: /bar|pub|cocktail|wein/i },
  ];
  h.forEach(p => {
    if (toRemove.has(p.name)) return;
    const nd = ((p.name||'')+' '+(p.description||'')).toLowerCase();
    for (const rule of catRules) {
      if (!rule.test.test(p.category)) continue;
      const nameHit = rule.nameTest && rule.nameTest.test(p.name);
      const descHit = rule.descTest && rule.descTest.test(nd);
      if (!nameHit && !descHit) continue;
      if (rule.exclude && rule.exclude.test(nd)) continue;
      // Only re-categorize pure matches (description strongly suggests)
      if (descHit) {
        p.category = rule.to;
        catFixes++;
        break;
      }
    }
  });
  if (catFixes) console.log(`Category corrections: ${catFixes}`);

  const report = {
    timestamp: new Date().toISOString(),
    totalEntries: h.length - toRemove.size,
    issues: issues.length,
    autoFixes,
    criticalIssues: issues.filter(i => i.severity === 'critical').length,
    highIssues: issues.filter(i => i.severity === 'high').length,
    mediumIssues: issues.filter(i => i.severity === 'medium').length,
    dataCompleteness: {
      withHours: h.length - toRemove.size - noHoursCount,
      withoutHours: noHoursCount,
      withWebsite: h.length - toRemove.size - noWebsiteCount,
      withoutWebsite: noWebsiteCount,
      withDescription: h.length - toRemove.size - noDescCount,
      withoutDescription: noDescCount
    },
    issueDetails: issues
  };

  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));

  // Summary
  console.log(`\n=== Quality Report ===`);
  console.log(`Entries: ${report.totalEntries}`);
  console.log(`Issues: ${issues.length} (${report.criticalIssues} critical, ${report.highIssues} high, ${report.mediumIssues} medium)`);
  console.log(`Auto-fixes: ${autoFixes}`);
  console.log(`Data completeness: ${report.dataCompleteness.withHours}/${report.totalEntries} hours, ${report.dataCompleteness.withWebsite}/${report.totalEntries} websites`);

  return report;
}

if (require.main === module) {
  run();
}
module.exports = { run };
