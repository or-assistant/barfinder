#!/usr/bin/env node
// migrate_to_db.js — One-time migration from JSON files to SQLite
// Run: node migrate_to_db.js

const fs = require('fs');
const path = require('path');
const { initDB, upsertPlace, upsertEvent, addRatingHistory, slugify, getDB } = require('./db');

const DIR = __dirname;
const read = (f) => { try { return JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch { return null; } };

console.log('=== Barfinder Migration to SQLite ===\n');
const db = initDB();

// ─── 1. Migrate highlights.json → places ───
const highlights = read('highlights.json');
let placesInserted = 0, placesSkipped = 0;

if (highlights && Array.isArray(highlights)) {
  console.log(`[1/3] Migrating ${highlights.length} places from highlights.json...`);

  const insertMany = db.transaction((bars) => {
    for (const bar of bars) {
      if (!bar.name || !bar.lat || !bar.lon) { placesSkipped++; continue; }
      try {
        upsertPlace({ ...bar, highlight: true, source: 'manual' });
        placesInserted++;
      } catch (e) {
        console.warn(`  WARN: ${bar.name}: ${e.message}`);
        placesSkipped++;
      }
    }
  });

  insertMany(highlights);
  console.log(`  ✓ ${placesInserted} places inserted, ${placesSkipped} skipped\n`);
} else {
  console.log('[1/3] No highlights.json found or empty\n');
}

// ─── 2. Migrate event caches → events ───
const eventFiles = [
  'afterwork_events_cache.json',
  'bar_events_cache.json',
  'ecosystem_events_cache.json',
  'eventbrite_events_cache.json',
  'facebook_events_cache.json',
  'hamburg_events_cache.json',
  'hamburg_new_events_cache.json',
  'hamburgwork_events_cache.json',
  'network_events_cache.json',
  'new_sources_events_cache.json',
  'reddit_events_cache.json',
  'rural_events_cache.json',
];

let totalEvents = 0, eventsInserted = 0, eventsSkipped = 0;

console.log('[2/3] Migrating events from cache files...');

// Build a slug→id map for place matching
const placeMap = {};
db.prepare('SELECT id, slug, name FROM places').all().forEach(p => {
  placeMap[p.slug] = p.id;
});

function matchPlace(locationName) {
  if (!locationName) return null;
  // Try to extract venue name (before comma usually)
  const venue = locationName.split(',')[0].trim();
  const slug = slugify(venue);
  return placeMap[slug] || null;
}

for (const file of eventFiles) {
  const data = read(file);
  if (!data) continue;

  // Events can be in .events, .results, or top-level array
  let events = data.events || data.results || (Array.isArray(data) ? data : []);
  if (!Array.isArray(events)) continue;

  const sourceName = file.replace('_cache.json', '').replace('_events', '');

  for (const evt of events) {
    if (!evt.title && !evt.name) continue;
    totalEvents++;
    try {
      const placeId = matchPlace(evt.location || evt.venue);
      upsertEvent({
        title: evt.title || evt.name,
        place_id: placeId,
        location_name: evt.location || evt.venue || null,
        date: evt.date || evt.start_date || null,
        time: evt.time || evt.start_time || null,
        end_time: evt.end_time || null,
        description: evt.description || null,
        category: evt.category || null,
        price: evt.price || null,
        url: evt.url || evt.link || null,
        source: evt.source || sourceName,
        source_id: evt.id || evt.source_id || null,
        is_recurring: evt.recurrence ? true : false,
        tags: evt.tags || null,
      });
      eventsInserted++;
    } catch (e) {
      eventsSkipped++;
    }
  }
}

// Also migrate events_cache.json (nested structure: events.general, events.bar_name, etc.)
const mainEvents = read('events_cache.json');
if (mainEvents && mainEvents.events && typeof mainEvents.events === 'object') {
  for (const [key, evts] of Object.entries(mainEvents.events)) {
    if (!Array.isArray(evts)) continue;
    for (const evt of evts) {
      if (!evt.title && !evt.name) continue;
      totalEvents++;
      try {
        const placeId = matchPlace(evt.location || evt.venue || key);
        upsertEvent({
          title: evt.title || evt.name,
          place_id: placeId,
          location_name: evt.location || evt.venue || null,
          date: evt.date || evt.start_date || null,
          time: evt.time || evt.start_time || null,
          description: evt.description || null,
          category: evt.category || null,
          price: evt.price || null,
          url: evt.url || null,
          source: evt.source || 'events-pipeline',
          is_recurring: evt.recurrence ? true : false,
        });
        eventsInserted++;
      } catch (e) {
        eventsSkipped++;
      }
    }
  }
}

console.log(`  ✓ ${eventsInserted}/${totalEvents} events inserted, ${eventsSkipped} skipped\n`);

// ─── 3. Migrate ratings → rating_history ───
let ratingsInserted = 0;
console.log('[3/3] Migrating ratings...');

const googleRatings = read('google_ratings_cache.json');
if (googleRatings && Array.isArray(googleRatings)) {
  for (const r of googleRatings) {
    if (!r.name || !r.rating) continue;
    const slug = slugify(r.name);
    const placeId = placeMap[slug];
    if (placeId) {
      try {
        addRatingHistory(placeId, 'google', r.rating, r.rating_n || null);
        // Also update the place's google_rating
        db.prepare('UPDATE places SET google_rating = ?, google_reviews = ?, last_rating_check = CURRENT_TIMESTAMP WHERE id = ?')
          .run(r.rating, r.rating_n || null, placeId);
        ratingsInserted++;
      } catch (e) {}
    }
  }
}

const yelpData = read('yelp_cache.json');
if (yelpData && yelpData.bars && Array.isArray(yelpData.bars)) {
  for (const r of yelpData.bars) {
    if (!r.name || !r.rating) continue;
    const slug = slugify(r.name);
    const placeId = placeMap[slug];
    if (placeId) {
      try {
        addRatingHistory(placeId, 'yelp', r.rating, r.review_count || null);
        db.prepare('UPDATE places SET yelp_rating = ?, yelp_reviews = ? WHERE id = ?')
          .run(r.rating, r.review_count || null, placeId);
        ratingsInserted++;
      } catch (e) {}
    }
  }
}

console.log(`  ✓ ${ratingsInserted} rating entries inserted\n`);

// ─── Summary ───
const stats = {
  places: db.prepare('SELECT COUNT(*) as c FROM places').get().c,
  events: db.prepare('SELECT COUNT(*) as c FROM events').get().c,
  ratings: db.prepare('SELECT COUNT(*) as c FROM rating_history').get().c,
};
console.log('=== Migration Complete ===');
console.log(`  Places:  ${stats.places}`);
console.log(`  Events:  ${stats.events}`);
console.log(`  Ratings: ${stats.ratings}`);
console.log(`\nDatabase: ${path.join(DIR, 'barfinder.db')}`);
