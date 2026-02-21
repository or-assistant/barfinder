// db.js — SQLite database module for Barfinder Hamburg
// Synchronous API via better-sqlite3

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.BARFINDER_DB_PATH || path.join(__dirname, 'barfinder.db');
let db = null;

// ─── Slugify: normalize name for dedup ───
function slugify(name) {
  return name
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// ─── Initialize DB ───
function initDB() {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS places (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      slug TEXT UNIQUE,
      lat REAL NOT NULL,
      lon REAL NOT NULL,
      category TEXT,
      subcategory TEXT,
      address TEXT,
      opening_hours TEXT,
      opening_hours_estimated BOOLEAN DEFAULT 0,
      phone TEXT,
      website TEXT,
      description TEXT,
      tags TEXT,
      smoker BOOLEAN DEFAULT 0,
      highlight BOOLEAN DEFAULT 0,
      source TEXT DEFAULT 'manual',
      community_score REAL,
      yelp_rating REAL,
      yelp_reviews INTEGER,
      vibe_base_score REAL,
      times_recommended INTEGER DEFAULT 0,
      times_positive_feedback INTEGER DEFAULT 0,
      times_negative_feedback INTEGER DEFAULT 0,
      last_verified DATETIME,
      last_rating_check DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(name, lat, lon)
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      place_id INTEGER REFERENCES places(id),
      location_name TEXT,
      lat REAL,
      lon REAL,
      date TEXT,
      time TEXT,
      end_time TEXT,
      description TEXT,
      category TEXT,
      price TEXT,
      url TEXT,
      source TEXT NOT NULL,
      source_id TEXT,
      event_quality INTEGER DEFAULT 50,
      is_recurring BOOLEAN DEFAULT 0,
      tags TEXT,
      last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(title, date, source)
    );

    CREATE TABLE IF NOT EXISTS rating_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      place_id INTEGER NOT NULL REFERENCES places(id),
      source TEXT NOT NULL,
      rating REAL,
      review_count INTEGER,
      checked_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      place_id INTEGER REFERENCES places(id),
      event_id INTEGER REFERENCES events(id),
      feedback_type TEXT NOT NULL,
      comment TEXT,
      context TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS scrape_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scraper TEXT NOT NULL,
      status TEXT NOT NULL,
      items_found INTEGER DEFAULT 0,
      items_new INTEGER DEFAULT 0,
      items_updated INTEGER DEFAULT 0,
      duration_ms INTEGER,
      error_message TEXT,
      run_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS learned_prefs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT UNIQUE NOT NULL,
      value TEXT NOT NULL,
      confidence REAL DEFAULT 0.5,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      display_name TEXT,
      role TEXT DEFAULT 'user' CHECK(role IN ('admin','user')),
      email_verified INTEGER DEFAULT 0,
      verification_token TEXT,
      reset_token TEXT,
      reset_expires INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_login DATETIME
    );

    CREATE TABLE IF NOT EXISTS favorites (
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      place_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, place_id)
    );

    CREATE TABLE IF NOT EXISTS user_ratings (
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      place_id INTEGER,
      rating INTEGER CHECK(rating BETWEEN 1 AND 5),
      comment TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, place_id)
    );

    CREATE TABLE IF NOT EXISTS saved_locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      address TEXT,
      is_default INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS user_preferences (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      preferred_categories TEXT DEFAULT '[]',
      preferred_districts TEXT DEFAULT '[]',
      vibe_preference TEXT DEFAULT 'any',
      radius_km INTEGER DEFAULT 3,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS search_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      query TEXT,
      lat REAL,
      lng REAL,
      filters TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS recently_viewed (
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      place_id INTEGER,
      viewed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, place_id)
    );

    CREATE TABLE IF NOT EXISTS vibe_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      place_id INTEGER NOT NULL,
      predicted_vibe INTEGER,
      actual_vibe TEXT CHECK(actual_vibe IN ('too_low','accurate','too_high')),
      comment TEXT,
      visited_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS user_stats (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      bars_visited INTEGER DEFAULT 0,
      feedbacks_given INTEGER DEFAULT 0,
      favorites_count INTEGER DEFAULT 0,
      member_since DATETIME DEFAULT CURRENT_TIMESTAMP,
      badge_level TEXT DEFAULT 'newcomer'
    );

    CREATE INDEX IF NOT EXISTS idx_places_coords ON places(lat, lon);
    CREATE INDEX IF NOT EXISTS idx_places_category ON places(category);
    CREATE INDEX IF NOT EXISTS idx_events_date ON events(date);
    CREATE INDEX IF NOT EXISTS idx_events_source ON events(source);
    CREATE INDEX IF NOT EXISTS idx_feedback_place ON feedback(place_id);
    CREATE INDEX IF NOT EXISTS idx_rating_history_place ON rating_history(place_id);
    CREATE INDEX IF NOT EXISTS idx_saved_locations_user ON saved_locations(user_id);
    CREATE INDEX IF NOT EXISTS idx_search_history_user ON search_history(user_id);
    CREATE INDEX IF NOT EXISTS idx_recently_viewed_user ON recently_viewed(user_id);
    CREATE INDEX IF NOT EXISTS idx_vibe_feedback_user ON vibe_feedback(user_id);
    CREATE INDEX IF NOT EXISTS idx_vibe_feedback_place ON vibe_feedback(place_id);
  `);

  console.log('[DB] Initialized barfinder.db');
  return db;
}

// ─── Get raw db handle ───
function getDB() {
  if (!db) initDB();
  return db;
}

// ─── Upsert Place ───
function upsertPlace(place) {
  const d = getDB();
  const slug = slugify(place.name);
  const tags = place.tags ? (typeof place.tags === 'string' ? place.tags : JSON.stringify(place.tags)) : null;

  const stmt = d.prepare(`
    INSERT INTO places (name, slug, lat, lon, category, subcategory, address, opening_hours,
      opening_hours_estimated, phone, website, description, tags, smoker, highlight, source,
      community_score, yelp_rating, yelp_reviews, vibe_base_score,
      last_verified, last_rating_check)
    VALUES (@name, @slug, @lat, @lon, @category, @subcategory, @address, @opening_hours,
      @opening_hours_estimated, @phone, @website, @description, @tags, @smoker, @highlight, @source,
      @community_score, @yelp_rating, @yelp_reviews, @vibe_base_score,
      @last_verified, @last_rating_check)
    ON CONFLICT(slug) DO UPDATE SET
      lat=COALESCE(@lat, lat), lon=COALESCE(@lon, lon),
      category=COALESCE(@category, category), subcategory=COALESCE(@subcategory, subcategory),
      address=COALESCE(@address, address), opening_hours=COALESCE(@opening_hours, opening_hours),
      opening_hours_estimated=COALESCE(@opening_hours_estimated, opening_hours_estimated),
      phone=COALESCE(@phone, phone), website=COALESCE(@website, website),
      description=COALESCE(@description, description), tags=COALESCE(@tags, tags),
      smoker=COALESCE(@smoker, smoker), highlight=COALESCE(@highlight, highlight),
      source=COALESCE(@source, source),
      community_score=COALESCE(@community_score, community_score),
      yelp_rating=COALESCE(@yelp_rating, yelp_rating),
      yelp_reviews=COALESCE(@yelp_reviews, yelp_reviews),
      updated_at=CURRENT_TIMESTAMP
    RETURNING id
  `);

  const result = stmt.get({
    name: place.name,
    slug,
    lat: place.lat,
    lon: place.lon,
    category: place.category || null,
    subcategory: place.subcategory || null,
    address: place.address || null,
    opening_hours: place.opening_hours || null,
    opening_hours_estimated: place.opening_hours_estimated ? 1 : 0,
    phone: place.phone || null,
    website: place.website || null,
    description: place.description || null,
    tags,
    smoker: place.smoker ? 1 : 0,
    highlight: place.highlight ? 1 : 0,
    source: place.source || 'manual',
    community_score: place.community_score || null,
    yelp_rating: place.yelp_rating || null,
    yelp_reviews: place.yelp_reviews || null,
    vibe_base_score: place.vibe_base_score || null,
    last_verified: place.last_verified || null,
    last_rating_check: place.last_rating_check || null,
  });

  return result.id;
}

// ─── Upsert Event ───
function upsertEvent(event) {
  const d = getDB();
  const tags = event.tags ? (typeof event.tags === 'string' ? event.tags : JSON.stringify(event.tags)) : null;

  const stmt = d.prepare(`
    INSERT INTO events (title, place_id, location_name, lat, lon, date, time, end_time,
      description, category, price, url, source, source_id, event_quality, is_recurring, tags)
    VALUES (@title, @place_id, @location_name, @lat, @lon, @date, @time, @end_time,
      @description, @category, @price, @url, @source, @source_id, @event_quality, @is_recurring, @tags)
    ON CONFLICT(title, date, source) DO UPDATE SET
      description=COALESCE(@description, description),
      url=COALESCE(@url, url),
      price=COALESCE(@price, price),
      last_seen=CURRENT_TIMESTAMP
    RETURNING id
  `);

  const result = stmt.get({
    title: event.title,
    place_id: event.place_id || null,
    location_name: event.location_name || null,
    lat: event.lat || null,
    lon: event.lon || null,
    date: event.date || null,
    time: event.time || null,
    end_time: event.end_time || null,
    description: event.description || null,
    category: event.category || null,
    price: event.price || null,
    url: event.url || null,
    source: event.source || 'unknown',
    source_id: event.source_id || null,
    event_quality: event.event_quality || 50,
    is_recurring: event.is_recurring ? 1 : 0,
    tags,
  });

  return result.id;
}

// ─── Log Scrape Run ───
function logScrapeRun(scraper, status, stats = {}) {
  const d = getDB();
  d.prepare(`
    INSERT INTO scrape_runs (scraper, status, items_found, items_new, items_updated, duration_ms, error_message)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(scraper, status, stats.items_found || 0, stats.items_new || 0,
    stats.items_updated || 0, stats.duration_ms || null, stats.error_message || null);
}

// ─── Add Feedback ───
function addFeedback(placeId, feedbackType, options = {}) {
  const d = getDB();
  const ctx = options.context ? (typeof options.context === 'string' ? options.context : JSON.stringify(options.context)) : null;

  d.prepare(`
    INSERT INTO feedback (place_id, event_id, feedback_type, comment, context)
    VALUES (?, ?, ?, ?, ?)
  `).run(placeId || null, options.event_id || null, feedbackType, options.comment || null, ctx);

  // Update counters on place
  if (placeId) {
    if (feedbackType === 'thumbs_up' || feedbackType === 'favorite' || feedbackType === 'visited') {
      d.prepare('UPDATE places SET times_positive_feedback = times_positive_feedback + 1 WHERE id = ?').run(placeId);
    } else if (feedbackType === 'thumbs_down' || feedbackType === 'dismissed') {
      d.prepare('UPDATE places SET times_negative_feedback = times_negative_feedback + 1 WHERE id = ?').run(placeId);
    }
  }
}

// ─── Get Places ───
function getPlaces(filters = {}) {
  const d = getDB();
  let where = [];
  let params = {};

  if (filters.category) { where.push('category = @category'); params.category = filters.category; }
  if (filters.highlight !== undefined) { where.push('highlight = @highlight'); params.highlight = filters.highlight ? 1 : 0; }
  if (filters.search) { where.push('(name LIKE @search OR description LIKE @search)'); params.search = `%${filters.search}%`; }

  // Radius filter (rough bounding box then Haversine)
  if (filters.lat && filters.lon && filters.radiusKm) {
    const dlat = filters.radiusKm / 111.0;
    const dlon = filters.radiusKm / (111.0 * Math.cos(filters.lat * Math.PI / 180));
    where.push('lat BETWEEN @minLat AND @maxLat AND lon BETWEEN @minLon AND @maxLon');
    params.minLat = filters.lat - dlat;
    params.maxLat = filters.lat + dlat;
    params.minLon = filters.lon - dlon;
    params.maxLon = filters.lon + dlon;
  }

  const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const limit = filters.limit || 500;
  return d.prepare(`SELECT * FROM places ${whereClause} ORDER BY name LIMIT ${limit}`).all(params);
}

// ─── Get Events ───
function getEvents(filters = {}) {
  const d = getDB();
  let where = [];
  let params = {};

  if (filters.date) { where.push('date = @date'); params.date = filters.date; }
  if (filters.category) { where.push('category = @category'); params.category = filters.category; }
  if (filters.source) { where.push('source = @source'); params.source = filters.source; }
  if (filters.search) { where.push('(title LIKE @search OR description LIKE @search)'); params.search = `%${filters.search}%`; }

  if (filters.lat && filters.lon && filters.radiusKm) {
    const dlat = filters.radiusKm / 111.0;
    const dlon = filters.radiusKm / (111.0 * Math.cos(filters.lat * Math.PI / 180));
    where.push('lat BETWEEN @minLat AND @maxLat AND lon BETWEEN @minLon AND @maxLon');
    params.minLat = filters.lat - dlat;
    params.maxLat = filters.lat + dlat;
    params.minLon = filters.lon - dlon;
    params.maxLon = filters.lon + dlon;
  }

  const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const limit = filters.limit || 200;
  return d.prepare(`SELECT * FROM events ${whereClause} ORDER BY date, time LIMIT ${limit}`).all(params);
}

// ─── Rating History ───
function getRatingHistory(placeId) {
  return getDB().prepare('SELECT * FROM rating_history WHERE place_id = ? ORDER BY checked_at DESC').all(placeId);
}

// ─── Learned Preferences ───
function getLearnedPrefs() {
  return getDB().prepare('SELECT * FROM learned_prefs ORDER BY confidence DESC').all();
}

function updateLearnedPref(key, value, confidence = 0.5) {
  const val = typeof value === 'string' ? value : JSON.stringify(value);
  getDB().prepare(`
    INSERT INTO learned_prefs (key, value, confidence, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value=?, confidence=?, updated_at=CURRENT_TIMESTAMP
  `).run(key, val, confidence, val, confidence);
}

// ─── Compute Vibe Bonus from feedback (with time decay) ───
function computeLearnedVibeBonus(placeId) {
  const rows = getDB().prepare(`
    SELECT feedback_type, created_at FROM feedback WHERE place_id = ? ORDER BY created_at DESC
  `).all(placeId);

  if (!rows.length) return 0;

  const now = Date.now();
  let score = 0;
  for (const row of rows) {
    const ageMs = now - new Date(row.created_at).getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    // Half-life of 90 days
    const decay = Math.pow(0.5, ageDays / 90);
    const weight = {
      'thumbs_up': 1, 'favorite': 2, 'visited': 0.5,
      'thumbs_down': -1.5, 'dismissed': -0.5,
    }[row.feedback_type] || 0;
    score += weight * decay;
  }

  // Normalize to roughly -10 to +10 range
  return Math.max(-10, Math.min(10, score));
}

// ─── Places needing rating refresh ───
function needsRatingRefresh(olderThanDays = 7) {
  return getDB().prepare(`
    SELECT * FROM places
    WHERE last_rating_check IS NULL
       OR last_rating_check < datetime('now', '-' || ? || ' days')
    ORDER BY last_rating_check ASC NULLS FIRST
  `).all(olderThanDays);
}

// ─── Places needing verification ───
function needsVerification(olderThanDays = 30) {
  return getDB().prepare(`
    SELECT * FROM places
    WHERE last_verified IS NULL
       OR last_verified < datetime('now', '-' || ? || ' days')
    ORDER BY last_verified ASC NULLS FIRST
  `).all(olderThanDays);
}

// ─── Add Rating History Entry ───
function addRatingHistory(placeId, source, rating, reviewCount) {
  getDB().prepare(`
    INSERT INTO rating_history (place_id, source, rating, review_count)
    VALUES (?, ?, ?, ?)
  `).run(placeId, source, rating, reviewCount);
}

// ─── Stats ───
function getStats() {
  const d = getDB();
  return {
    places: d.prepare('SELECT COUNT(*) as count FROM places').get().count,
    events: d.prepare('SELECT COUNT(*) as count FROM events').get().count,
    feedback: d.prepare('SELECT COUNT(*) as count FROM feedback').get().count,
    recentScrapes: d.prepare('SELECT * FROM scrape_runs ORDER BY run_at DESC LIMIT 20').all(),
  };
}

function getHealth() {
  const d = getDB();
  return {
    places: d.prepare('SELECT COUNT(*) as count FROM places').get().count,
    highlights: d.prepare('SELECT COUNT(*) as count FROM places WHERE highlight = 1').get().count,
    events: d.prepare('SELECT COUNT(*) as count FROM events').get().count,
    ratings: d.prepare('SELECT COUNT(*) as count FROM rating_history').get().count,
    feedback: d.prepare('SELECT COUNT(*) as count FROM feedback').get().count,
    lastScrape: d.prepare('SELECT scraper, status, run_at FROM scrape_runs ORDER BY run_at DESC LIMIT 1').get() || null,
  };
}

module.exports = {
  initDB, getDB, slugify,
  upsertPlace, upsertEvent, logScrapeRun, addFeedback,
  getPlaces, getEvents, getRatingHistory,
  getLearnedPrefs, updateLearnedPref,
  computeLearnedVibeBonus,
  needsRatingRefresh, needsVerification,
  addRatingHistory, getStats, getHealth,
};
