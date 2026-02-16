#!/usr/bin/env node
// test_db.js — Basic tests for the SQLite database module

const fs = require('fs');
const path = require('path');

// Use a test database — swap the DB_PATH before loading
const TEST_DB = path.join(__dirname, 'barfinder_test.db');
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);

// We need to make db.js use a different path. Simplest: set env var.
process.env.BARFINDER_DB_PATH = TEST_DB;
const db = require('./db');

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

// Init DB
console.log('\n=== DB Tests ===\n');
const handle = db.initDB();
assert(handle !== null, 'initDB returns db handle');

// Slugify
console.log('\n--- Slugify ---');
assert(db.slugify('Ä Bräu Stüble') === 'ae-braeu-stueble', 'slugify umlauts');
assert(db.slugify('Zum Silbersack') === 'zum-silbersack', 'slugify simple');
assert(db.slugify('Le Lion - Bar de Paris') === 'le-lion-bar-de-paris', 'slugify with dash');

// Upsert Place
console.log('\n--- Upsert Place ---');
const id1 = db.upsertPlace({ name: 'Test Bar', lat: 53.55, lon: 9.99, category: 'bar', highlight: true });
assert(typeof id1 === 'number' && id1 > 0, `upsertPlace returns id: ${id1}`);

// Dedup by slug
const id2 = db.upsertPlace({ name: 'Test Bar', lat: 53.551, lon: 9.991, category: 'cocktail' });
assert(id1 === id2, `dedup by slug: ${id1} === ${id2}`);

// Check update worked
const place = db.getDB().prepare('SELECT * FROM places WHERE id = ?').get(id1);
assert(place.category === 'cocktail', 'upsert updated category');
assert(place.lat === 53.551, 'upsert updated lat');

// Upsert Event
console.log('\n--- Upsert Event ---');
const eid1 = db.upsertEvent({ title: 'Test Event', date: '2026-02-15', source: 'test', category: 'music' });
assert(typeof eid1 === 'number' && eid1 > 0, `upsertEvent returns id: ${eid1}`);

// Dedup
const eid2 = db.upsertEvent({ title: 'Test Event', date: '2026-02-15', source: 'test', description: 'updated' });
assert(eid1 === eid2, 'event dedup works');

// Different date = new event
const eid3 = db.upsertEvent({ title: 'Test Event', date: '2026-02-16', source: 'test' });
assert(eid3 !== eid1, 'different date = new event');

// Feedback
console.log('\n--- Feedback ---');
db.addFeedback(id1, 'thumbs_up', { comment: 'great place' });
db.addFeedback(id1, 'thumbs_down', { comment: 'too loud' });
db.addFeedback(id1, 'favorite', {});

const p2 = db.getDB().prepare('SELECT * FROM places WHERE id = ?').get(id1);
assert(p2.times_positive_feedback === 2, `positive count: ${p2.times_positive_feedback}`);
assert(p2.times_negative_feedback === 1, `negative count: ${p2.times_negative_feedback}`);

// Vibe bonus
const vibe = db.computeLearnedVibeBonus(id1);
assert(vibe > 0, `vibe bonus positive after more positive feedback: ${vibe.toFixed(2)}`);

// Get Places
console.log('\n--- Queries ---');
const places = db.getPlaces({ category: 'cocktail' });
assert(places.length >= 1, `getPlaces with category filter: ${places.length}`);

const nearby = db.getPlaces({ lat: 53.55, lon: 9.99, radiusKm: 1 });
assert(nearby.length >= 1, `getPlaces with radius: ${nearby.length}`);

// Get Events
const events = db.getEvents({ date: '2026-02-15' });
assert(events.length >= 1, `getEvents by date: ${events.length}`);

// Learned Prefs
console.log('\n--- Learned Prefs ---');
db.updateLearnedPref('preferred_category', 'cocktail', 0.8);
const prefs = db.getLearnedPrefs();
assert(prefs.length === 1 && prefs[0].key === 'preferred_category', 'learned pref stored');

// Scrape Run Log
console.log('\n--- Scrape Runs ---');
db.logScrapeRun('test-scraper', 'success', { items_found: 10, items_new: 5 });
const stats = db.getStats();
assert(stats.recentScrapes.length >= 1, 'scrape run logged');

// Health
const health = db.getHealth();
assert(health.places > 0, `health shows places: ${health.places}`);

// Rating History
console.log('\n--- Rating History ---');
db.addRatingHistory(id1, 'google', 4.5, 120);
const hist = db.getRatingHistory(id1);
assert(hist.length === 1 && hist[0].rating === 4.5, 'rating history works');

// Cleanup
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
fs.unlinkSync(TEST_DB);
process.exit(failed > 0 ? 1 : 0);
