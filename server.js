const http = require('http');
const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const crypto = require('crypto');

// ═══ LOAD .env ═══
try {
  const envFile = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  envFile.split('\n').forEach(line => {
    const [key, ...val] = line.split('=');
    if (key && val.length) process.env[key.trim()] = val.join('=').trim();
  });
} catch(e) {}

const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || (() => { console.error('⚠️ FATAL: JWT_SECRET not set in .env! Using random secret (sessions will not persist across restarts)'); return require('crypto').randomBytes(64).toString('hex'); })();
const JWT_EXPIRY = '7d';
const BCRYPT_ROUNDS = 12;

// ═══ RATE LIMITING (In-Memory, per IP) ═══
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 60; // max requests per window
const rateLimitStore = new Map();

function getRateLimitKey(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
         req.socket.remoteAddress || 'unknown';
}

function checkRateLimit(req) {
  const key = getRateLimitKey(req);
  const now = Date.now();
  let entry = rateLimitStore.get(key);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    entry = { windowStart: now, count: 0 };
    rateLimitStore.set(key, entry);
  }
  entry.count++;
  const remaining = Math.max(0, RATE_LIMIT_MAX - entry.count);
  const resetAt = entry.windowStart + RATE_LIMIT_WINDOW_MS;
  return { allowed: entry.count <= RATE_LIMIT_MAX, remaining, resetAt };
}

// Cleanup stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitStore) {
    if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS * 2) rateLimitStore.delete(key);
  }
}, 5 * 60 * 1000);

// ═══ AUTH RATE LIMITING (stricter: 5 per minute per IP for auth endpoints) ═══
const authRateLimitStore = new Map();
function checkAuthRateLimit(req) {
  const key = 'auth_' + getRateLimitKey(req);
  const now = Date.now();
  let entry = authRateLimitStore.get(key);
  if (!entry || now - entry.windowStart > 60000) {
    entry = { windowStart: now, count: 0 };
    authRateLimitStore.set(key, entry);
  }
  entry.count++;
  return entry.count <= 5;
}

// ═══ AUTH HELPERS ═══
function parseJWT(req) {
  // Check Authorization header first
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  // Check cookie
  const cookies = (req.headers.cookie || '').split(';').reduce((acc, c) => {
    const [k, ...v] = c.trim().split('=');
    if (k) acc[k] = v.join('=');
    return acc;
  }, {});
  return cookies['bf_token'] || null;
}

function verifyUser(req) {
  const token = parseJWT(req);
  if (!token) return null;
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch(e) {
    return null;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e6) reject(new Error('Body too large')); });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { reject(e); } });
  });
}

// ═══ INPUT SANITIZATION ═══
function sanitizeString(str, maxLen = 500) {
  if (typeof str !== 'string') return str;
  return str.slice(0, maxLen).replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/[<>]/g, c => c === '<' ? '&lt;' : '&gt;');
}

function sanitizeInput(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const clean = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string') clean[k] = sanitizeString(v);
    else if (typeof v === 'number' && isFinite(v)) clean[k] = v;
    else if (typeof v === 'boolean') clean[k] = v;
    else if (Array.isArray(v)) clean[k] = v.map(i => typeof i === 'string' ? sanitizeString(i) : i);
    else if (typeof v === 'object' && v !== null) clean[k] = sanitizeInput(v);
    else clean[k] = v;
  }
  return clean;
}

// ═══ ALLOWED ORIGINS ═══
const ALLOWED_ORIGINS = new Set([
  'https://oliver-roessling.claw.clawy.io',
  'http://localhost:3002'
]);

function getCorsOrigin(req) {
  const origin = req.headers['origin'];
  if (origin && ALLOWED_ORIGINS.has(origin)) return origin;
  // Allow same-origin requests (no Origin header)
  if (!origin) return null;
  return null; // Block unknown origins
}

// ═══ SECURITY HEADERS ═══
function setSecurityHeaders(req, res) {
  const origin = getCorsOrigin(req);
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(self), camera=(), microphone=(), payment=()');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' https://unpkg.com https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://unpkg.com https://cdn.jsdelivr.net; img-src 'self' data: blob: https://*.tile.openstreetmap.org https://*.basemaps.cartocdn.com; connect-src 'self' https://nominatim.openstreetmap.org; font-src 'self'; frame-ancestors 'none'");
}

// ═══ GZIP RESPONSE HELPER ═══
function sendJSON(req, res, statusCode, data, cacheHeader) {
  const json = JSON.stringify(data);
  setSecurityHeaders(req, res);
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheHeader || 'no-cache',
  };

  const acceptEncoding = req.headers['accept-encoding'] || '';
  if (acceptEncoding.includes('gzip') && json.length > 1024) {
    headers['Content-Encoding'] = 'gzip';
    res.writeHead(statusCode, headers);
    zlib.gzip(Buffer.from(json), (err, compressed) => {
      if (err) { res.end(json); return; }
      res.end(compressed);
    });
  } else {
    res.writeHead(statusCode, headers);
    res.end(json);
  }
}

function sendError(req, res, statusCode, message) {
  sendJSON(req, res, statusCode, { error: message, status: statusCode }, 'no-store');
}

// ═══ SERVER START TIME ═══
const SERVER_START_TIME = Date.now();

const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'barfinder_config.json'), 'utf8'));
const eventsConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'events_config.json'), 'utf8'));
const PORT = process.env.PORT || config.PORT || 3002;

// ═══ SQLITE DATABASE (additive — JSON still works) ═══
const barfinderDB = require('./db');
try {
  barfinderDB.initDB();
  console.log('✅ SQLite database initialized');
} catch (e) {
  console.warn('⚠️ SQLite init failed (non-fatal):', e.message);
}

// ═══ COMMUNITY SCORE (eigene Metrik, 0-100) ═══
// Score basiert auf Qualitaet und Beliebtheits-Indikatoren aus der Datenbank

// ═══════════════════════════════════════════════════════════════
// 🌤️ WEATHER CACHE (Open-Meteo, refreshed every 30min)
// ═══════════════════════════════════════════════════════════════
let weatherCache = { current: null, hourly: null, fetchedAt: 0 };

function fetchWeather() {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${config.WEATHER_LAT}&longitude=${config.WEATHER_LON}&current_weather=true&hourly=precipitation_probability,temperature_2m,weathercode,apparent_temperature,windspeed_10m,is_day&daily=sunrise,sunset&timezone=Europe/Berlin&forecast_days=2`;
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          // Save previous weather for dynamics comparison (once per day)
          const prevDate = weatherCache.fetchedAt ? new Date(weatherCache.fetchedAt).toDateString() : null;
          const nowDate = new Date().toDateString();
          if (prevDate && prevDate !== nowDate && weatherCache.current) {
            _yesterdayWeather = { ...weatherCache.current };
          }
          weatherCache = {
            current: data.current_weather || null,
            hourly: data.hourly || null,
            daily: data.daily || null,
            fetchedAt: Date.now()
          };
          console.log(`🌤️ Weather updated: ${weatherCache.current?.temperature}°C, code ${weatherCache.current?.weathercode}`);
          resolve(weatherCache);
        } catch (e) { console.log('⚠️ Weather parse error:', e.message); reject(e); }
      });
    }).on('error', e => { console.log('⚠️ Weather fetch error:', e.message); reject(e); });
  });
}

// Fetch on start + every 30 min
fetchWeather().catch(() => {});
setInterval(() => fetchWeather().catch(() => {}), 30 * 60 * 1000);

function getWeatherFactor(place) {
  if (!weatherCache.current) return { multiplier: 1.0, label: null };
  const code = weatherCache.current.weathercode;
  const temp = weatherCache.current.temperature;
  const cat = (place.category || '').toLowerCase();
  const desc = ((place.description || '') + ' ' + (place.name || '')).toLowerCase();
  const isOutdoor = cat === 'biergarten' || /biergarten|terrasse|outdoor|draußen|beach|strand|garten/i.test(desc);
  const isIndoor = !isOutdoor; // bars, clubs, pubs etc.

  let multiplier = 1.0;
  let label = null;

  // Heavy rain/storm (code >= 61)
  if (code >= 61) {
    multiplier = isOutdoor ? 0.5 : 1.1; // Indoor gets slight boost
    label = isOutdoor ? '🌧️ Regen — weniger los draußen' : '🌧️ Regen — mehr Leute drinnen';
  }
  // Light rain/drizzle (code 51-60)
  else if (code >= 51) {
    multiplier = isOutdoor ? 0.7 : 1.1;
    label = isOutdoor ? '🌦️ Niesel — weniger Outdoor' : '🌦️ Niesel — ab in die Bar!';
  }
  // Fog (45-48)
  else if (code >= 45) {
    multiplier = 0.9;
    label = '🌫️ Nebel';
  }
  // Clear/sunny + warm
  else if (code < 3 && temp >= 20) {
    multiplier = isOutdoor ? 1.2 : 0.95;
    label = isOutdoor ? '☀️ Perfektes Biergarten-Wetter!' : '☀️ Schönes Wetter';
  }
  // Cold < 0°C
  if (temp < 0) {
    multiplier *= 0.8;
    label = '🥶 Frost — weniger Leute unterwegs';
  }

  return { multiplier, label };
}

// ═══════════════════════════════════════════════════════════════
// 🎉 MAJOR EVENTS — Hamburger Großevents
// ═══════════════════════════════════════════════════════════════
const MAJOR_EVENTS = eventsConfig.major_events;

function getActiveMajorEvents(date) {
  if (!date) date = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Berlin' }));
  const month = date.getMonth() + 1; // 1-12
  const day = date.getDate();
  const active = [];

  for (const ev of MAJOR_EVENTS) {
    // DOM has multiple periods
    if (ev.periods) {
      for (const p of ev.periods) {
        if (month >= p.startMonth && month <= p.endMonth) {
          active.push(ev);
          break;
        }
      }
      continue;
    }
    // Events spanning months (e.g. Weihnachtsmärkte Nov-Dec)
    const endMonth = ev.endMonth || ev.startMonth;
    const endDay = ev.endDay || ev.startDay;
    const startVal = ev.startMonth * 100 + ev.startDay;
    const endVal = endMonth * 100 + endDay;
    const curVal = month * 100 + day;
    if (curVal >= startVal && curVal <= endVal) {
      active.push(ev);
    }
  }
  return active;
}

function getMajorEventBoost() {
  const active = getActiveMajorEvents();
  if (active.length === 0) return { boost: 1.0, events: [] };
  // Use highest boost if multiple events
  const maxBoost = Math.max(...active.map(e => e.boost));
  return { boost: maxBoost, events: active };
}
const CACHE_FILE = path.join(__dirname, 'cache.json');
const CACHE_TTL = config.CACHE_TTL;
const MIN_REQUEST_INTERVAL = config.MIN_REQUEST_INTERVAL;

let cache = {};
try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch(e) {}
let lastOverpassRequest = 0;

// ═══════════════════════════════════════════════════════════════
// 🔥 IMPROVED HOTSCORE DATA LOADING
// ═══════════════════════════════════════════════════════════════
let popularTimesData = {};
let eventsData = {};
let realTimeData = {};

try {
  // Versuche Popular Times zu laden
  if (fs.existsSync('./popular_times_cache.json')) {
    popularTimesData = JSON.parse(fs.readFileSync('./popular_times_cache.json', 'utf8'));
  }
  
  // Versuche Events zu laden
  if (fs.existsSync('./events_cache.json')) {
    const eventFileData = JSON.parse(fs.readFileSync('./events_cache.json', 'utf8'));
    eventsData = eventFileData.events || {};
  }
  
  // Versuche Real-Time Data zu laden
  if (fs.existsSync('./realtime_cache.json')) {
    realTimeData = JSON.parse(fs.readFileSync('./realtime_cache.json', 'utf8'));
  }
} catch (e) {
  console.log('External data files not available, using fallback algorithm');
}

// ═══════════════════════════════════════════════════════════════
// 🌟 COMMUNITY SCORES & YELP CACHE LOADING
// ═══════════════════════════════════════════════════════════════
let communityScoreCache = {};
let yelpCache = {};
let yelpReviewsCache = [];
let hamburgEventsCache = {};

// Load community scores from database
try {
  const allScores = barfinderDB.getDB().prepare('SELECT name, community_score FROM places WHERE community_score IS NOT NULL').all();
  allScores.forEach(p => { communityScoreCache[p.name.toLowerCase()] = p.community_score; });
  console.log(`✅ Community scores loaded: ${Object.keys(communityScoreCache).length} bars from database`);
} catch(e) { console.log('⚠️ Community scores not available:', e.message); }

try {
  if (fs.existsSync('./yelp_cache.json')) {
    const yData = JSON.parse(fs.readFileSync('./yelp_cache.json', 'utf8'));
    yelpCache = yData.bars || yData;
    console.log(`✅ Yelp cache loaded: ${Array.isArray(yelpCache) ? yelpCache.length : Object.keys(yelpCache).length} bars`);
  }
} catch(e) { console.log('⚠️ Yelp cache not available'); }

try {
  if (fs.existsSync('./yelp_reviews_cache.json')) {
    yelpReviewsCache = JSON.parse(fs.readFileSync('./yelp_reviews_cache.json', 'utf8'));
    console.log(`✅ Yelp reviews cache loaded: ${yelpReviewsCache.length} bars`);
  }
} catch(e) { console.log('⚠️ Yelp reviews cache not available'); }

try {
  if (fs.existsSync('./hamburg_events_cache.json')) {
    hamburgEventsCache = JSON.parse(fs.readFileSync('./hamburg_events_cache.json', 'utf8'));
    console.log(`✅ Hamburg events cache loaded`);
  }
} catch(e) { console.log('⚠️ Hamburg events cache not available'); }

// Pipeline events (Google News, Abendblatt, Hamburg Tourism, Meetup)
let pipelineEventsCache = { events: [] };
try {
  if (fs.existsSync('./events_pipeline_cache.json')) {
    pipelineEventsCache = JSON.parse(fs.readFileSync('./events_pipeline_cache.json', 'utf8'));
    console.log(`✅ Pipeline events cache loaded: ${(pipelineEventsCache.events||[]).length} events`);
  }
} catch(e) { console.log('⚠️ Pipeline events cache not available'); }

// Eventbrite events (via smry.ai proxy)
let eventbriteEventsCache = [];
try {
  if (fs.existsSync('./eventbrite_events_cache.json')) {
    eventbriteEventsCache = JSON.parse(fs.readFileSync('./eventbrite_events_cache.json', 'utf8'));
    console.log(`✅ Eventbrite events cache loaded: ${eventbriteEventsCache.length} events`);
  }
} catch(e) { console.log('⚠️ Eventbrite events cache not available'); }

// New sources events (startupcity, mopo, handelskammer, rausgegangen)
let newSourcesEventsCache = [];
try {
  if (fs.existsSync('./new_sources_events_cache.json')) {
    newSourcesEventsCache = JSON.parse(fs.readFileSync('./new_sources_events_cache.json', 'utf8'));
    console.log(`✅ New sources events cache loaded: ${newSourcesEventsCache.length} events`);
  }
} catch(e) { console.log('⚠️ New sources events cache not available'); }

// Mit Vergnügen events/tips
let mitvergnuegenCache = { articles: [], events: [], barRelevant: [], bars: [] };
try {
  if (fs.existsSync('./mitvergnuegen_cache.json')) {
    mitvergnuegenCache = JSON.parse(fs.readFileSync('./mitvergnuegen_cache.json', 'utf8'));
    console.log(`✅ Mit Vergnügen cache loaded: ${(mitvergnuegenCache.articles||[]).length} articles, ${(mitvergnuegenCache.bars||[]).length} bars`);
  }
} catch(e) { console.log('⚠️ Mit Vergnügen cache not available'); }

// Hamburg Digital/Startup Ecosystem events (hamburg-startups.net, hamburg-business.com)
let hamburgworkEventsCache = { events: [] };
try {
  if (fs.existsSync('./hamburgwork_events_cache.json')) {
    hamburgworkEventsCache = JSON.parse(fs.readFileSync('./hamburgwork_events_cache.json', 'utf8'));
    console.log(`✅ Hamburg@Work events cache loaded: ${(hamburgworkEventsCache.events||[]).length} events`);
  }
} catch(e) { console.log('⚠️ Hamburg@Work events cache not available'); }

// Rural events (Lentföhrden, Weddelbrook, Bad Bramstedt area)
let ruralEventsCache = { events: [] };
try {
  if (fs.existsSync('./rural_events_cache.json')) {
    ruralEventsCache = JSON.parse(fs.readFileSync('./rural_events_cache.json', 'utf8'));
    console.log(`✅ Rural events cache loaded: ${(ruralEventsCache.events||[]).length} events`);
  }
} catch(e) { console.log('⚠️ Rural events cache not available'); }

// Afterwork events
let afterworkEventsCache = { events: [] };
try {
  if (fs.existsSync('./afterwork_events_cache.json')) {
    afterworkEventsCache = JSON.parse(fs.readFileSync('./afterwork_events_cache.json', 'utf8'));
    console.log(`✅ Afterwork events cache loaded: ${(afterworkEventsCache.events||[]).length} events`);
  }
} catch(e) { console.log('⚠️ Afterwork events cache not available'); }

// Afterwork schedule (day-based)
let afterworkSchedule = { locations: [] };
try {
  if (fs.existsSync('./afterwork_schedule.json')) {
    afterworkSchedule = JSON.parse(fs.readFileSync('./afterwork_schedule.json', 'utf8'));
    console.log(`✅ Afterwork schedule loaded: ${afterworkSchedule.locations.length} locations`);
  }
} catch(e) { console.log('⚠️ Afterwork schedule not available'); }

// OpenTable ratings
let opentableCache = { restaurants: [] };
try {
  if (fs.existsSync('./opentable_cache.json')) {
    opentableCache = JSON.parse(fs.readFileSync('./opentable_cache.json', 'utf8'));
    console.log(`✅ OpenTable cache loaded: ${(opentableCache.restaurants||[]).length} restaurants`);
  }
} catch(e) { console.log('⚠️ OpenTable cache not available'); }

// Community Score lookup for a place
function getCommunityScore(placeName) {
  if (!placeName) return null;
  const norm = s => (s||'').toLowerCase().replace(/[^a-zäöüß0-9]/g, '');
  const pNorm = norm(placeName);
  
  // Try community score cache (from DB)
  for (const [key, score] of Object.entries(communityScoreCache)) {
    const kNorm = norm(key);
    if (pNorm === kNorm || pNorm.includes(kNorm) || kNorm.includes(pNorm)) {
      return Math.round(score);
    }
  }
  
  return null;
}

// Fuzzy name matching for Yelp/OpenTable data
function fuzzyMatchRating(placeName) {
  if (!placeName) return null;
  const norm = s => (s||'').toLowerCase().replace(/[^a-zäöüß0-9]/g, '');
  const pNorm = norm(placeName);
  
  // Try Yelp cache (legacy)
  const yelpList = Array.isArray(yelpCache) ? yelpCache : Object.values(yelpCache);
  for (const val of yelpList) {
    const kNorm = norm(val.name);
    if (pNorm === kNorm || pNorm.includes(kNorm) || kNorm.includes(pNorm)) {
      return { source: 'yelp', rating: val.rating, reviewCount: val.reviewCount };
    }
  }
  
  // Try Yelp reviews cache (smry.ai scraper)
  for (const val of yelpReviewsCache) {
    const kNorm = norm(val.name);
    if (pNorm === kNorm || pNorm.includes(kNorm) || kNorm.includes(pNorm)) {
      return { source: 'yelp', rating: val.rating, reviewCount: null, reviewSnippet: val.reviewSnippet };
    }
  }
  
  // Try OpenTable cache
  for (const val of (opentableCache.restaurants || [])) {
    const kNorm = norm(val.name);
    if (pNorm === kNorm || pNorm.includes(kNorm) || kNorm.includes(pNorm)) {
      return { source: 'opentable', rating: val.rating, reviewCount: val.reviewCount, cuisine: val.cuisine };
    }
  }
  
  return null;
}

function ratingVibeBonus(match, communityScore) {
  let bonus = 0;
  // Community score bonus (0-100 scale)
  if (communityScore) {
    if (communityScore >= 70) bonus += 10;
    else if (communityScore >= 55) bonus += 5;
    else if (communityScore >= 40) bonus += 2;
  }
  // Additional bonus from other rating sources
  if (match) {
    const r = match.rating || 0;
    const rc = match.reviewCount || 0;
    if (r >= 4.5) bonus += 5;
    else if (r >= 4.0) bonus += 3;
    if (rc > 500) bonus += 3;
    else if (rc > 200) bonus += 2;
    else if (rc > 50) bonus += 1;
  }
  return bonus;
}

const HIGHLIGHTS = JSON.parse(fs.readFileSync(path.join(__dirname, "highlights.json"), "utf8"));

// ═══════════════════════════════════════════════════════════════
// 🚀 VIBE SCORE CACHE (5 min TTL) — avoids recomputing on every request
// ═══════════════════════════════════════════════════════════════
const vibeScoreCache = { data: null, key: null, timestamp: 0 };
const VIBE_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// List fields for lightweight list responses
const LIST_FIELDS = ['name', 'lat', 'lon', 'category', 'vibeScore', 'vibeEmoji', 'isOpen', 'communityScore',
  '_dist', 'vibeLabel', 'vibeTrend', 'isNowPerfect', 'has_events', 'tags', 'address', 'hotScore',
  'openStatus', 'vibeReason', 'vibePeak', 'vibePeakHour', 'vibeFactors', 'neighborhood',
  'description', 'liveMusic', 'outdoor_seating', 'smoker'];

// ══════════════════════════════════════════
// 🎵 STATIC EVENTS (placeholder)
// TODO: Replace with weekly cron scraping from szene-hamburg.com, Meetup, Eventbrite
// ══════════════════════════════════════════
const STATIC_EVENTS = eventsConfig.static_events;

function getEventsToday() {
  const { dow } = getHamburgTime();
  const dayMap = { 0: 'Su', 1: 'Mo', 2: 'Di', 3: 'Mi', 4: 'Do', 5: 'Fr', 6: 'Sa' };
  const today = dayMap[dow];
  return STATIC_EVENTS.filter(e => e.date === today).map(e => {
    const loc = HIGHLIGHTS.find(h => h.name === e.location);
    return { ...e, lat: loc?.lat, lon: loc?.lon, address: loc?.address };
  });
}

function getNetworkEvents() {
  // Lade echte Network-Events aus Cache (falls verfügbar)
  let realEvents = [];
  try {
    if (fs.existsSync('./network_events_cache.json')) {
      const networkCache = JSON.parse(fs.readFileSync('./network_events_cache.json', 'utf8'));
      realEvents = networkCache.events || [];
      console.log(`📊 Loaded ${realEvents.length} real network events from cache`);
    }
  } catch (e) {
    console.log('⚠️ Could not load network events cache, using static fallback');
  }

  // ═══ DRY Event Merge Helper ═══
  function mergeEventsFromCache(events, sourceName, opts = {}) {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const { filterSources, defaultType, defaultLocation, qualityFn, skipDateFilter } = opts;
    try {
      for (const ev of events) {
        if (filterSources && !filterSources.includes(ev.source)) continue;
        if (!skipDateFilter) {
          if (!ev.date) continue;
          const eventDate = new Date(ev.date);
          if (eventDate < today) continue;
        }
        const quality = qualityFn ? qualityFn(ev) : 'medium';
        realEvents.push({
          id: (ev.source || sourceName) + '_' + (ev.title || '').replace(/[^a-z0-9]/gi, '_').substring(0, 40),
          title: ev.title,
          category: ev.type || defaultType || 'social',
          type: ev.type || defaultType || 'social',
          date: ev.date || '',
          time: ev.time || '',
          location: ev.venue || defaultLocation || 'Hamburg',
          description: ev.description || '',
          quality,
          source: ev.source || sourceName,
          url: ev.url || '',
          tags: [ev.type, ev.source || sourceName],
          recurrence: ev.recurrence || '',
          price: ev.price || '',
          free: ev.free || (ev.price === 'Eintritt frei')
        });
      }
    } catch(e) { /* ignore */ }
  }

  // Merge pipeline events (only real event sources, not news)
  mergeEventsFromCache(pipelineEventsCache.events || [], 'pipeline', {
    filterSources: ['meetup', 'hamburg-tourism'],
    qualityFn: ev => ev.relevanceScore >= 60 ? 'high' : 'medium'
  });

  // Merge Eventbrite events
  mergeEventsFromCache(eventbriteEventsCache, 'eventbrite', { skipDateFilter: true });

  // Merge new sources events (startupcity, mopo, handelskammer, rausgegangen)
  mergeEventsFromCache(newSourcesEventsCache, 'new_sources', {
    qualityFn: ev => ev.source === 'startupcity' ? 'high' : 'medium'
  });

  // Merge Mit Vergnügen events
  mergeEventsFromCache(mitvergnuegenCache.events || [], 'mitvergnuegen', {
    defaultType: 'events',
    qualityFn: ev => ev.isBarRelevant ? 'high' : 'medium'
  });

  // Merge Hamburg@Work / Digital Ecosystem events
  mergeEventsFromCache(hamburgworkEventsCache.events || [], 'hamburg-startups', {
    defaultType: 'business'
  });

  // Statische Fallback-Events für Hamburg (wenn kein Cache oder wenig Events)
  const staticEvents = eventsConfig.network_static_events;
  
  // Hamburg Events aus Cache — DISABLED: These are news articles, not real events
  // szene-hamburg.de and hamburg.de RSS contain bar reviews and news, not event listings
  let hamburgEvents = [];
  /* DISABLED — news articles were showing as events
  try {
    const sources = hamburgEventsCache.sources || [];
    const irrelevantRx = /konzert|festival|kino|cinema|theater|oper\b|opera|comedy|kabarett|musical|brettspiel|board.?game|tabletop|pen.?&.?paper|spieleabend|literatur|lesung|museum|ausstellung|dinosaur|harry.?potter|könig der löwen|indoor.?aktivität|hamburg.?card|frauen|female|women|ladies|mädels|frauennetzwerk|women'?s\s|stricken|häkeln|näh.?kreis|buchclub|garten.?brand|überfallen|verletzt|getötet|unfall|polizei.?sucht/i;
    const barNightlifeRx = /bar|club|nachtleben|party|after.?work|drinks?|cocktail|pub|kneipe|wein|beer|bier|feiern|dj|open.?air|location|szene|reeperbahn|st\.?\s*pauli|schanze/i;
    
    for (const src of sources) {
      if (!src.items) continue;
      const sourceName = (src.source || '').includes('hamburg-de') ? 'hamburg.de' : 'szene-hamburg';
      for (const item of src.items) {
        const text = ((item.title||'') + ' ' + (item.description||'') + ' ' + (item.excerpt||'')).toLowerCase();
        if (irrelevantRx.test(text)) continue;
        if (!barNightlifeRx.test(text) && sourceName !== 'szene-hamburg') continue;
        
        hamburgEvents.push({
          id: 'hh_' + (item.title||'').replace(/\W/g,'_').slice(0,40),
          title: item.title,
          description: item.excerpt || item.description || '',
          url: item.url,
          source: sourceName,
          image: item.image || null,
          date: item.date || null,
          location: item.location || 'Hamburg',
          tags: [sourceName, 'hamburg', 'nightlife'],
        });
      }
    }
  } catch(e) { console.log('⚠️ Hamburg events integration error:', e.message); }
  */
  
  // Merge rural events (Lentföhrden, Weddelbrook, Bad Bramstedt)
  mergeEventsFromCache(ruralEventsCache.events || [], 'rural', {
    defaultLocation: 'Lentföhrden'
  });

  mergeEventsFromCache(afterworkEventsCache.events || [], 'afterwork', {
    skipDateFilter: true
  });

  // Merge curated events (recurring + one-time from Sonnet research)
  try {
    if (fs.existsSync('./curated_events.json')) {
      const curated = JSON.parse(fs.readFileSync('./curated_events.json', 'utf8'));
      // One-time events
      if (curated.one_time) {
        mergeEventsFromCache(curated.one_time.map(e => ({
          title: e.name, date: e.date, time: e.time, venue: e.location,
          description: e.description, url: e.url, type: e.category,
          source: 'curated', price: e.price
        })), 'curated', { qualityFn: e => 'high' });
      }
      // Recurring events — generate instances for next 4 weeks
      if (curated.recurring) {
        const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Berlin' }));
        const dayNames = ['So','Mo','Di','Mi','Do','Fr','Sa'];
        curated.recurring.forEach(rec => {
          (rec.days || []).forEach(day => {
            // Find next 4 occurrences of this weekday
            for (let w = 0; w < 4; w++) {
              const d = new Date(now);
              const diff = (day - d.getDay() + 7) % 7 + w * 7;
              d.setDate(d.getDate() + diff);
              if (d < now && w === 0) { d.setDate(d.getDate() + 7); }
              const dateStr = d.toISOString().split('T')[0];
              realEvents.push({
                id: 'curated_' + (rec.name||'').replace(/[^a-z0-9]/gi,'_').slice(0,30) + '_' + dateStr,
                title: rec.name,
                category: rec.category || 'social',
                type: rec.category || 'social',
                date: dateStr,
                time: rec.time || '',
                location: rec.location || 'Hamburg',
                description: rec.description || '',
                quality: rec.confidence || 'medium',
                source: 'curated',
                url: rec.url || '',
                tags: [rec.category, 'curated'],
                recurrence: 'Jeden ' + dayNames[day],
                price: rec.price || '',
                free: rec.price === 'kostenlos'
              });
            }
          });
        });
      }
    }
  } catch(e) { console.log('⚠️ Curated events merge error:', e.message); }

  // NUR echte Events — keine Fake-Daten, keine News-Artikel
  const allEvents = [...realEvents, ...hamburgEvents];

  // ═══ EVENT ENRICHMENT: Kategorie, Qualität, Open Access ═══
  function enrichEvent(e) {
    const text = ((e.title || '') + ' ' + (e.description || '') + ' ' + (e.tags || []).join(' ')).toLowerCase();
    const src = (e.source || '').toLowerCase();

    // --- Kategorie ---
    let cat = 'other';
    if (/networking|mixer|meetup|meet\s*&\s*greet|after.?work|stammtisch|get.?together|netzwerk|austausch|social\s*melting/i.test(text)) cat = 'networking';
    else if (/founder|startup|pitch|gründer|entrepreneur|venture|accelerator|incubator/i.test(text)) cat = 'startup';
    else if (/socialmatch|tasting|wine|wein|cocktail|community\s*event|meet\s*&\s*eat|hangout|social/i.test(text)) cat = 'social';
    else if (/workshop|kurs|seminar|webinar|lernen|training|schulung|masterclass|bootcamp/i.test(text)) cat = 'workshop';
    else if (/konferenz|conference|summit|kongress|symposium/i.test(text)) cat = 'conference';
    else if (/theater|musik|konzert|oper\b|kunst|gallery|galerie|ausstellung|musical|ballett|orchester/i.test(text)) cat = 'culture';
    else if (/dorffest|gemeinde|ortsvere|feuerwehr|finanzausschuss|elternabend|chorprobe|handarbeit|ortsbeirat/i.test(text)) cat = 'community';

    // --- Qualitäts-Score ---
    let q = 30; // baseline

    // Open Access keywords
    if (/\b(open|free|kostenlos|offen|alle\s*willkommen|gratis|eintritt\s*frei|kostenfrei)\b/i.test(text)) q += 30;
    // Networking keywords
    if (/\b(networking|mixer|meet|austausch|get.?together|stammtisch|after.?work|netzwerk)\b/i.test(text)) q += 25;
    // Startup/Business
    if (/\b(startup|founder|investor|pitch|business|gründer|unternehmer|handelskammer)\b/i.test(text)) q += 15;
    // Specific high-value events
    if (/spökenkieker|deep\s*tech|meet\s*&\s*eat|open\s*door|founder\s*breakfast|ki\s*köpfe/i.test(text)) q += 20;

    // Negative signals
    if (/\bonline\b/i.test(text) && !/hybrid/i.test(text)) q -= 20;
    if (/\bwebinar\b/i.test(text)) q -= 25;
    if (/\bkurs\b/i.test(text)) q -= 15;
    if (/\bseminar\b/i.test(text)) q -= 10;
    // Expensive paid events
    if (/(\d{2,})\s*€/.test(text)) { const m = text.match(/(\d{2,})\s*€/); if (m && parseInt(m[1]) > 50) q -= 15; }
    if (/€\s*(\d{2,})/.test(text)) { const m = text.match(/€\s*(\d{2,})/); if (m && parseInt(m[1]) > 50) q -= 15; }

    // Source bonus/penalty
    if (src === 'startupcity') q += 10;
    else if (src === 'meetup') q += 10;
    else if (src === 'luma') q += 5;
    else if (src === 'mopo') q -= 10;
    else if (src === 'lentfoehrden.de') q -= 5;

    // Culture/community penalty
    if (cat === 'culture') q -= 15;
    if (cat === 'community') q -= 10;
    if (cat === 'workshop') q -= 10;

    q = Math.max(0, Math.min(100, q));

    // --- Open Access ---
    const isOpenAccess = /\b(open|free|kostenlos|offen|alle\s*willkommen|gratis|eintritt\s*frei|kostenfrei)\b/i.test(text);

    return { ...e, eventCategory: cat, eventQuality: q, isOpenAccess };
  }

  const enrichedEvents = allEvents.map(enrichEvent);

  // ═══ FILTER: Lentföhrden Gemeinde-Verwaltung raus ═══
  const lentExclude = /finanzausschuss|elternabend|chorprobe|handarbeit|ortsbeirat|bauausschuss|gemeindevertretung|seniorennachmittag/i;

  // Zentraler Relevanz-Filter
  const excludeRx = /konzert|festival|kino|cinema|oper\b|opera|jahreshauptversammlung|hauptversammlung|mitgliederversammlung|generalversammlung|kinder|jugend|familie|familien|baby|eltern|schüler|bastel|malen|vorles(?!ung)|märchen|puppentheater|kindergarten|senioren|rentner|ü60|ü65|ab\s*\d\s*jahre(?!n?\s*(?:erfahrung|beruf))|(?:ab|für)\s*(?:[3-9]|1[0-6])\s*jahre|spielenachmittag|spiele.?nachmittag|spieleabend|spiele.?abend|brettspiel|board.?game|tabletop|pen.?&.?paper|doko|doppelkopf|skat.?abend|pub.?quiz|quiz.?night|karaoke.?night|musical|ballett|figurentheater|comedy.?show|kabarett|stand.?up|lesung|literatur|museum|ausstellung|vernissage|flohmarkt|trödelmarkt|yoga|meditation|achtsamkeit|burnout|mental.?health|recruiting|karriere.?messe|career.?fair|bewerbung|hr.?kongress|job.?messe|azubi|ausbildung|momie|mommy|mütter|mami|mama.?treff|stillgruppe|krabbelgruppe|(?:^|\b)hr\b.*(?:braucht|strateg|c.?level|people|personal)|theater(?!.*plattdeutsch)|concert|live.?band|padel|tennis|badminton|squash|volleyball|basketball|lauf|marathon|triathlon|wanderung|hiking|pilates|zumba|fitness|spinning|crossfit|(?:^|\b)(?:dj|live)\s+\w+\s*$|frauen|female|women|ladies|mädels|girl.?boss|she\s|sisterhood|femme|frauennetzwerk|women'?s\s|for\s+(?:her|women|ladies)|(?:^|\b)ai\.?women|selbstverteidigung.*frau|stricken|häkeln|näh.?kreis|buchclub|lesekreis|garten.?brand|überfallen|verletzt|getötet|unfall|polizei.?sucht|vermisst|brand\s/i;
  
  return enrichedEvents.filter(e => {
    const text = ((e.title || '') + ' ' + (e.description || '')).toLowerCase();
    const isRural = e.source === 'rural' || e.source === 'recurring' || e.source === 'wolters-gasthof' || (e.tags && e.tags.includes('rural'));
    
    // Lentföhrden Gemeinde-Verwaltung → raus
    if (e.source === 'lentfoehrden.de' && lentExclude.test(text)) return false;
    
    // Online-only events → raus (check title, description AND location)
    const locText = (e.location || e.venue || '').toLowerCase();
    const isOnlineLoc = /\b(online|virtual|zoom|webinar|remote)\b/i.test(locText);
    const isOnlineText = /\b(online|virtual|zoom|webinar)\b/i.test(text) && !/\b(t-online|rp online|onlinemarketing)\b/i.test(text);
    if ((isOnlineLoc || isOnlineText) && !/hybrid/i.test(text) && !isRural) return false;
    
    // Low quality → raus (but keep rural)
    if (!isRural && e.eventQuality < 20) return false;
    
    if (isRural) return true;
    return !excludeRx.test(text);
  });
}

function cacheKey(lat, lon, radius, category) {
  return `${lat.toFixed(3)}_${lon.toFixed(3)}_${radius}_${category}`;
}

function buildOverpassQuery(lat, lon, radius, category) {
  const amenities = {
    all: ['bar','pub','cafe','nightclub','biergarten'],
    bar: ['bar','pub'],
    cafe: ['cafe'],
    cocktailbar: ['bar'],
    nightclub: ['nightclub'],
    wine: ['bar','wine_bar'],
    biergarten: ['biergarten'],
    'irish-pub': ['pub','bar']
  };
  const types = amenities[category] || amenities.all;
  // Query both nodes AND ways (many bars are mapped as building outlines)
  const around = `(around:${radius},${lat},${lon})`;
  let parts = [];
  for (const t of types) {
    parts.push(`node["amenity"="${t}"]${around};`);
    parts.push(`way["amenity"="${t}"]${around};`);
  }
  // For wine category, also query shop=wine and cuisine=wine_bar
  if (category === 'wine' || category === 'all') {
    parts.push(`node["shop"="wine"]${around};`);
    parts.push(`way["shop"="wine"]${around};`);
    parts.push(`node["cuisine"~"wine_bar"]${around};`);
    parts.push(`way["cuisine"~"wine_bar"]${around};`);
  }
  return `[out:json][timeout:25];\n(\n  ${parts.join('\n  ')}\n);\nout center body;`;
}

function fetchOverpass(query) {
  return new Promise((resolve, reject) => {
    const data = 'data=' + encodeURIComponent(query);
    const req = https.request({
      hostname: config.OVERPASS_HOSTS[0], path: '/api/interpreter', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(data) }
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function saveCache() {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
}

// Manuelle Kategorie-Korrekturen für falsch kategorisierte Orte in OSM
const CATEGORY_OVERRIDES = {
  "45'lik": 'bar',
};

async function getPlaces(lat, lon, radius, category) {
  const key = cacheKey(lat, lon, radius, category);
  const cached = cache[key];
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) return cached.data;

  const now = Date.now();
  if (now - lastOverpassRequest < MIN_REQUEST_INTERVAL) {
    if (cached) return cached.data;
    throw new Error('Rate limited, try again in a minute');
  }

  lastOverpassRequest = now;
  const query = buildOverpassQuery(lat, lon, radius, category);
  const result = await fetchOverpass(query);
  const places = (result.elements || []).map(e => ({
    id: e.id, name: e.tags?.name || e.tags?.brand || e.tags?.operator || e.tags?.['addr:street'] || null,
    lat: e.lat || e.center?.lat, lon: e.lon || e.center?.lon,
    category: CATEGORY_OVERRIDES[(e.tags?.name||'').toLowerCase()] || (/irish/i.test(e.tags?.name||'') ? 'irish-pub' : (e.tags?.amenity || e.tags?.bar || e.tags?.club || 'bar')),
    address: [e.tags?.['addr:street'], e.tags?.['addr:housenumber']].filter(Boolean).join(' ') || '',
    opening_hours: e.tags?.opening_hours || '',
    website: e.tags?.website || e.tags?.['contact:website'] || '',
    phone: e.tags?.phone || e.tags?.['contact:phone'] || '',
    cuisine: e.tags?.cuisine || '',
    outdoor_seating: e.tags?.outdoor_seating === 'yes',
    wheelchair: e.tags?.wheelchair || '',
    smoker: e.tags?.smoking === 'yes' || e.tags?.smoking === 'isolated' || e.tags?.smoking === 'separated'
  }));
  // Filter: nur Places MIT Namen behalten
  const namedPlaces = places.filter(p => p.name && p.name.trim().length > 0);
  cache[key] = { data: namedPlaces, timestamp: now };
  saveCache();
  return namedPlaces;
}

function getHamburgTime() {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Berlin',
    hour: 'numeric', minute: 'numeric', weekday: 'short',
    hour12: false
  });
  const parts = formatter.formatToParts(now);
  const weekday = parts.find(p => p.type === 'weekday').value;
  const hour = parseInt(parts.find(p => p.type === 'hour').value);
  const minute = parseInt(parts.find(p => p.type === 'minute').value);
  const dayMap = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 0 };
  return { hour, minute, dow: dayMap[weekday] || 0 };
}

function isOpenSmart(oh, category) {
  const result = isOpenNow(oh);
  if (result === null) {
    // Keine opening_hours vorhanden: konservative Schätzung je Kategorie
    const { hour, dow } = getHamburgTime();
    const isWeekend = (dow === 5 || dow === 6); // Fr/Sa
    const isSunday = (dow === 0);

    // Cafés: Mo-So 08:00-19:00 (konservativ)
    if (category === 'cafe') {
      return (hour >= 8 && hour < 19) ? 'likely' : 'likely_closed';
    }

    // Bars/Pubs/Cocktailbars: Mo-Do 18-01, Fr-Sa 18-03, So 18-00
    if (['bar','cocktailbar','pub','irish-pub','wine','weinbar'].includes(category)) {
      if (isWeekend) {
        return (hour >= 18 || hour < 3) ? 'likely' : 'likely_closed';
      } else if (isSunday) {
        return hour >= 18 ? 'likely' : 'likely_closed';
      } else {
        return (hour >= 18 || hour < 1) ? 'likely' : 'likely_closed';
      }
    }

    // Andere Kategorien: unbekannt
    return null;
  }
  return result;
}

function isOpenNow(oh) {
  if (!oh) return null;
  if (oh === '24/7') return true;
  const { hour, minute, dow } = getHamburgTime();
  const days = ['Su','Mo','Tu','We','Th','Fr','Sa'];
  const day = days[dow];
  const time = hour * 100 + minute;
  const parts = oh.split(';').map(s => s.trim());
  for (const part of parts) {
    const match = part.match(/^((?:Mo|Tu|We|Th|Fr|Sa|Su)(?:\s*-\s*(?:Mo|Tu|We|Th|Fr|Sa|Su))?(?:\s*,\s*(?:Mo|Tu|We|Th|Fr|Sa|Su)(?:\s*-\s*(?:Mo|Tu|We|Th|Fr|Sa|Su))?)*)\s+(\d{2}):(\d{2})\s*-\s*(\d{2}):(\d{2})/i);
    if (!match) continue;
    const dayRange = match[1];
    const openH = parseInt(match[2]) * 100 + parseInt(match[3]);
    const closeH = parseInt(match[4]) * 100 + parseInt(match[5]);
    if (isDayInRange(day, dayRange, days)) {
      const crossesMidnight = closeH <= openH;
      if (crossesMidnight) {
        if (time >= openH || time < closeH) return true;
      } else {
        if (time >= openH && time < closeH) return true;
      }
    }
    if (closeH <= openH) {
      const prevDay = days[(dow + 6) % 7];
      if (isDayInRange(prevDay, dayRange, days) && time < closeH) return true;
    }
  }
  return false;
}

function isDayInRange(day, rangeStr, days) {
  const dayIdx = days.indexOf(day);
  const ranges = rangeStr.split(',').map(s => s.trim());
  for (const r of ranges) {
    if (r.includes('-')) {
      const [start, end] = r.split('-').map(s => s.trim());
      const si = days.indexOf(start), ei = days.indexOf(end);
      if (si <= ei) { if (dayIdx >= si && dayIdx <= ei) return true; }
      else { if (dayIdx >= si || dayIdx <= ei) return true; }
    } else {
      if (days.indexOf(r.trim()) === dayIdx) return true;
    }
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════
// 🔥 IMPROVED HOTSCORE ALGORITHM
// ═══════════════════════════════════════════════════════════════


// ═══════════════════════════════════════════════════════════════
// 🔥 IMPROVED HOTSCORE ALGORITHM (Event-Integrated)
// ═══════════════════════════════════════════════════════════════
// Verbesserte Version mit Event-Integration und realistischer Score-Verteilung

// Event-Cache laden (einmalig beim Server-Start)
let eventsCache = {};
try {
  const eventsCacheData = JSON.parse(fs.readFileSync('./events_cache.json', 'utf8'));
  eventsCache = eventsCacheData.events || {};
  console.log(`✅ Events cache loaded: ${Object.keys(eventsCache).length} locations`);
} catch (e) {
  console.log('⚠️  Events cache not available, using fallback algorithm');
}

function computeHotScore(place, isHighlight = false) {
  const { hour, minute, dow } = getHamburgTime();
  const timeDecimal = hour + minute / 60;
  const placeKey = place.name?.toLowerCase().replace(/[^a-z0-9]/g, '_') || 'unknown';
  
  // Check if place is open
  const open = isOpenNow(place.opening_hours);
  if (open === false) {
    return { score: 0, label: 'Geschlossen', color: 'closed' };
  }
  
  let score = 0;
  let factors = {}; // For debugging
  
  // ═══════════════════════════════════════════════════════════════
  // 1. BASE POPULARITY BY CATEGORY
  // ═══════════════════════════════════════════════════════════════
  
  const estimatedScore = estimatePopularityByCategory(place.category, timeDecimal, dow);
  score += estimatedScore * 0.4;
  factors.estimated_popularity = estimatedScore * 0.4;
  
  // ═══════════════════════════════════════════════════════════════
  // 2. EVENT-BASED BOOSTS 🎉
  // ═══════════════════════════════════════════════════════════════
  
  const todayEvents = getTodaysEvents(placeKey, dow, hour);
  
  if (todayEvents.length > 0) {
    let eventBoost = 0;
    
    for (const event of todayEvents) {
      // Event-Type-spezifische Boosts
      const typeBoost = {
        'quiz': 25,        // Pub Quiz zieht stark
        'live_music': 30,  // Live Musik sehr beliebt
        'karaoke': 20,     // Karaoke moderate Anziehung
        'dj': 22,          // DJ Sets
        'football': 35,    // Bundesliga/Champions League
        'after_work': 15,  // After Work Events
        'happy_hour': 18,  // Happy Hour
        'party': 20        // Party Events
      }[event.type] || 15;
      
      // Zeit-basierte Event-Multiplikatoren
      const eventTime = parseEventTime(event.times) || getDefaultEventTime(event.type);
      const timeDiff = Math.abs(timeDecimal - eventTime);
      
      if (timeDiff <= 1) {
        eventBoost += typeBoost; // Volles Event-Boost
      } else if (timeDiff <= 2) {
        eventBoost += typeBoost * 0.7; // Reduziertes Boost
      } else if (timeDiff <= 3) {
        eventBoost += typeBoost * 0.4; // Minimales Boost
      }
    }
    
    score += Math.min(eventBoost, 40); // Max 40 Punkte für Events
    factors.event_boost = Math.min(eventBoost, 40);
  }
  
  // ═══════════════════════════════════════════════════════════════
  // 3. IMPROVED DAY FACTORS
  // ═══════════════════════════════════════════════════════════════
  
  const dayFactors = getImprovedDayFactors(dow, place.category, hour);
  score += dayFactors.base_score;
  factors.day_factor = dayFactors.base_score;
  
  if (dayFactors.weekend_bonus > 0) {
    score += dayFactors.weekend_bonus;
    factors.weekend_bonus = dayFactors.weekend_bonus;
  }
  
  // ═══════════════════════════════════════════════════════════════
  // 4. HIGHLIGHT BONUS
  // ═══════════════════════════════════════════════════════════════
  
  if (isHighlight) {
    const highlightBonus = 12;
    score += highlightBonus;
    factors.highlight_bonus = highlightBonus;
  }
  
  // ═══════════════════════════════════════════════════════════════
  // 5. CATEGORY-SPECIFIC TIME ADJUSTMENTS
  // ═══════════════════════════════════════════════════════════════
  
  const categoryAdjustment = getCategoryTimeAdjustment(place.category, hour);
  score += categoryAdjustment;
  factors.category_adjustment = categoryAdjustment;
  
  // ═══════════════════════════════════════════════════════════════
  // 6. ENHANCED DESCRIPTION KEYWORDS
  // ═══════════════════════════════════════════════════════════════
  
  const keywordBonus = getEnhancedDescriptionBonus(place.description || '');
  score += keywordBonus;
  factors.keyword_bonus = keywordBonus;
  
  // ═══════════════════════════════════════════════════════════════
  // 7. NORMALIZATION & REALISTIC DISTRIBUTION
  // ═══════════════════════════════════════════════════════════════
  
  // Clamp score to 0-100
  score = Math.max(0, Math.min(100, score));
  
  // Leichte Randomisierung für realistische Verteilung
  const nameHash = (place.name || '').split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  const randomFactor = (nameHash % 11) - 5; // -5 bis +5
  score = Math.max(0, Math.min(100, score + randomFactor));
  
  // ═══════════════════════════════════════════════════════════════
  // 8. ENHANCED LABELS & COLORS
  // ═══════════════════════════════════════════════════════════════
  
  const { label, color } = getEnhancedScoreLabel(score, place.category, todayEvents.length > 0);
  
  return {
    score: Math.round(score),
    label,
    color,
    has_events: todayEvents.length > 0,
    event_count: todayEvents.length,
    factors // For debugging (remove in production)
  };
}

// ═══════════════════════════════════════════════════════════════
// 🔥 DYNAMIC VIBE SCORE SYSTEM — Real-time data-driven scoring
// ═══════════════════════════════════════════════════════════════

// Compute a differentiated base vibe from enriched data + category + signals
// Returns 15–65 spread (not 30 for everyone)
function computeBaseVibe(place) {
  let score = 25; // neutral starting point
  const e = place.enriched || {};
  const cat = (place.category || '').toLowerCase();

  // 1. Category character bonus (bars/clubs inherently vibier than cafés/restaurants)
  const catBonus = {
    'nightclub': 18, 'cocktailbar': 14, 'bar': 12, 'pub': 10,
    'irish-pub': 10, 'biergarten': 10, 'wine': 8,
    'event-location': 15, 'cafe': 4, 'restaurant': 2, 'mittagstisch': 0
  };
  score += catBonus[cat] || 5;

  // 2. Crowd appeal (diverse/lively crowds = higher vibe)
  const crowdBonus = {
    'kreative': 8, 'gemischt': 6, 'locals': 5, 'studenten': 7,
    'ue35': 4, 'business': 3, 'touristen': 2
  };
  score += crowdBonus[e.crowd] || 0;

  // 3. Atmosphere/vibe descriptor
  const vibeBonus = {
    'wild': 12, 'ausgelassen': 10, 'lässig': 7, 'lebendig': 8,
    'kreativ': 6, 'gemütlich': 4, 'rustikal': 5, 'elegant': 5,
    'romantisch': 3, 'ruhig': 1
  };
  score += vibeBonus[e.vibe] || 0;

  // 4. Price level (mid-range = most accessible = slight boost)
  if (e.priceLevel === '€€') score += 3;
  else if (e.priceLevel === '€') score += 2;
  else if (e.priceLevel === '€€€') score += 1;

  // 5. Best time alignment (places peaking "abends"/"late-night" are bar-vibier)
  if (e.bestTime === 'late-night') score += 5;
  else if (e.bestTime === 'abends') score += 3;

  // 6. Date spot = social place
  if (e.dateSpot) score += 2;

  // 7. Specials/highlights boost (has unique offerings)
  if (e.specials && e.specials.length > 0) score += 3;
  if (e.highlights && e.highlights.length > 2) score += 2;

  // 8. Places with outdoor seating = more social
  if (place.outdoor_seating) score += 2;

  // Clamp to 15–65 range (still needs day/time multiplier to reach final score)
  return Math.max(15, Math.min(65, score));
}


// ═══════════════════════════════════════════════════════════════
// HOUR MULTIPLIER CURVES: How busy is a bar at each hour?
// Mo-Do: peak 20-22, Fr-Sa: peak 22-01
// ═══════════════════════════════════════════════════════════════
// ═══ STADTTEIL-INDEX: Demografie, Bar-Dichte, Nachtleben-Relevanz ═══
const STADTTEIL_INDEX = (() => {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'stadtteil_index.json'), 'utf8'));
    return raw.stadtteile || {};
  } catch(e) { console.log('⚠️ stadtteil_index.json not found, using defaults'); return {}; }
})();

// ═══ FEIERTAGE (Hamburg-relevant, cached yearly) ═══
let _holidays = { year: 0, dates: new Set(), map: {} };

async function fetchHolidays(year) {
  return new Promise((resolve) => {
    https.get(`https://date.nager.at/api/v3/PublicHolidays/${year}/DE`, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const all = JSON.parse(body);
          // Only global holidays or Hamburg (DE-HH) holidays
          const hh = all.filter(h => h.global || (h.counties && h.counties.includes('DE-HH')));
          const dates = new Set(hh.map(h => h.date));
          const map = {};
          hh.forEach(h => { map[h.date] = h.localName; });
          _holidays = { year, dates, map };
          console.log(`🎉 Holidays loaded: ${dates.size} for ${year}`);
          resolve(_holidays);
        } catch(e) { console.log('⚠️ Holiday parse error:', e.message); resolve(_holidays); }
      });
    }).on('error', e => { console.log('⚠️ Holiday fetch error:', e.message); resolve(_holidays); });
  });
}

// Load on start
fetchHolidays(new Date().getFullYear()).catch(() => {});

function isHoliday(date) {
  const d = date || new Date();
  if (d.getFullYear() !== _holidays.year) fetchHolidays(d.getFullYear()).catch(() => {});
  const ds = d.toISOString().split('T')[0];
  return _holidays.dates.has(ds);
}

function getHolidayName(date) {
  const ds = (date || new Date()).toISOString().split('T')[0];
  return _holidays.map[ds] || null;
}

function isBridgeDay(date) {
  // Brueckentag: Freitag nach Feiertag am Donnerstag, oder Montag vor Feiertag am Dienstag
  const d = date || new Date();
  const dow = d.getDay();
  if (dow === 5) { // Freitag: check if Donnerstag war Feiertag
    const thu = new Date(d); thu.setDate(thu.getDate() - 1);
    return isHoliday(thu);
  }
  if (dow === 1) { // Montag: check if Dienstag ist Feiertag
    const tue = new Date(d); tue.setDate(tue.getDate() + 1);
    return isHoliday(tue);
  }
  return false;
}

// Vorabend eines Feiertags (z.B. Silvester, Tag vor Christi Himmelfahrt)
function isHolidayEve(date) {
  const d = date || new Date();
  const tomorrow = new Date(d); tomorrow.setDate(tomorrow.getDate() + 1);
  return isHoliday(tomorrow);
}

// ═══ GROSSEVENTS HAMBURG (jaehrlich wiederkehrend + bekannte Termine) ═══
const MAJOR_EVENTS_HAMBURG = [
  // Format: { name, startMonth, startDay, endMonth, endDay, boost, stadtteile }
  // Monate 0-basiert (0=Jan)
  { name: 'Hafengeburtstag', startMonth: 4, startDay: 8, endMonth: 4, endDay: 11, boost: 20, stadtteile: ['st. pauli', 'altona', 'neustadt'] },
  { name: 'Reeperbahn Festival', startMonth: 8, startDay: 17, endMonth: 8, endDay: 20, boost: 25, stadtteile: ['st. pauli', 'sternschanze'] },
  { name: 'Hamburger DOM (Fruehling)', startMonth: 2, startDay: 20, endMonth: 3, endDay: 19, boost: 10, stadtteile: ['st. pauli'] },
  { name: 'Hamburger DOM (Sommer)', startMonth: 6, startDay: 24, endMonth: 7, endDay: 23, boost: 10, stadtteile: ['st. pauli'] },
  { name: 'Hamburger DOM (Winter)', startMonth: 10, startDay: 6, endMonth: 11, endDay: 5, boost: 10, stadtteile: ['st. pauli'] },
  { name: 'Schlagermove', startMonth: 6, startDay: 4, endMonth: 6, endDay: 4, boost: 20, stadtteile: ['st. pauli', 'sternschanze'] },
  { name: 'CSD Hamburg', startMonth: 7, startDay: 1, endMonth: 7, endDay: 2, boost: 15, stadtteile: ['st. pauli', 'neustadt', 'altona'] },
  { name: 'Altonale', startMonth: 5, startDay: 12, endMonth: 5, endDay: 28, boost: 10, stadtteile: ['ottensen', 'altona'] },
  { name: 'Weihnachtsmaerkte', startMonth: 10, startDay: 24, endMonth: 11, endDay: 23, boost: 8, stadtteile: ['neustadt', 'altstadt', 'wandsbek'] },
  { name: 'Silvester', startMonth: 11, startDay: 31, endMonth: 11, endDay: 31, boost: 30, stadtteile: null }, // ueberall
];

function getActiveMajorEventsEnriched(date) {
  const d = date || new Date();
  const month = d.getMonth();
  const day = d.getDate();
  return MAJOR_EVENTS_HAMBURG.filter(e => {
    if (e.startMonth === e.endMonth) return month === e.startMonth && day >= e.startDay && day <= e.endDay;
    if (month === e.startMonth) return day >= e.startDay;
    if (month === e.endMonth) return day <= e.endDay;
    return month > e.startMonth && month < e.endMonth;
  });
}

// ═══ UNI-SEMESTER HAMBURG (Vorlesungszeiten) ═══
// Vorlesungszeit: ca. Mitte Okt bis Mitte Feb, Mitte Apr bis Mitte Jul
function isVorlesungszeit(date) {
  const d = date || new Date();
  const m = d.getMonth(); // 0-basiert
  const day = d.getDate();
  // WiSe: 15. Okt bis 15. Feb
  if (m >= 9 && m <= 11) return day >= 15 || m > 9; // Okt ab 15., Nov, Dez
  if (m === 0) return true; // Jan komplett
  if (m === 1) return day <= 15; // Feb bis 15.
  // SoSe: 15. Apr bis 15. Jul
  if (m === 3) return day >= 15; // Apr ab 15.
  if (m >= 4 && m <= 5) return true; // Mai, Jun
  if (m === 6) return day <= 15; // Jul bis 15.
  return false;
}

// ═══ PAYWEEK-EFFEKT (Gehaltseingang) ═══
function getPayweekFactor(date) {
  const d = date || new Date();
  const day = d.getDate();
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  // Erste Woche (1-7): Gehalt gerade eingegangen, mehr Budget
  if (day <= 7) return 1.05;
  // Letzte Woche: Budget knapper
  if (day >= lastDay - 6) return 0.97;
  return 1.0;
}

// ═══ TAGESLICHT/DUNKELHEIT ═══
function getSunsetHour(weather) {
  if (!weather?.daily?.sunset?.[0]) return 18; // Fallback
  const sunset = weather.daily.sunset[0]; // "2026-02-21T17:45"
  const h = parseInt(sunset.split('T')[1]?.split(':')[0] || '18');
  return h;
}

function getSunriseHour(weather) {
  if (!weather?.daily?.sunrise?.[0]) return 7;
  const sunrise = weather.daily.sunrise[0];
  return parseInt(sunrise.split('T')[1]?.split(':')[0] || '7');
}

// ═══ STUNDLICHER WETTER-FORECAST ═══
function getHourlyWeather(hour, weatherData) {
  if (!weatherData?.hourly?.temperature_2m) return null;
  const idx = hour; // Index 0-23 for today
  if (idx < 0 || idx >= weatherData.hourly.temperature_2m.length) return null;
  return {
    temperature: weatherData.hourly.temperature_2m[idx],
    apparentTemperature: weatherData.hourly.apparent_temperature?.[idx] ?? null,
    windspeed: weatherData.hourly.windspeed_10m?.[idx] ?? null,
    weathercode: weatherData.hourly.weathercode?.[idx] ?? 0,
    isDay: weatherData.hourly.is_day?.[idx] ?? 1,
    precipitationProbability: weatherData.hourly.precipitation_probability?.[idx] ?? 0
  };
}

// Gefuehlte Temperatur fuer Vibe (ersetzt echte Temperatur wo relevant)
function getEffectiveTemperature(weather, hour, weatherData) {
  const hourly = getHourlyWeather(hour, weatherData);
  if (hourly && hourly.apparentTemperature !== null) return hourly.apparentTemperature;
  if (weather?.temperature) return weather.temperature;
  return 10; // Fallback
}

// Canonical name mapping for STADTTEILE aliases
const _STADTTEIL_CANONICAL = {
  'st. pauli': 'st. pauli', 'st.pauli': 'st. pauli', 'pauli': 'st. pauli', 'reeperbahn': 'st. pauli',
  'schanze': 'sternschanze', 'sternschanze': 'sternschanze',
  'eimsbuettel': 'eimsbuettel', 'eimsbüttel': 'eimsbuettel',
};

function getStadtteilForPlace(place) {
  if (!place.lat || !place.lon) return null;
  // First: exact bounding box match
  for (const [name, bounds] of Object.entries(STADTTEILE)) {
    if (place.lat >= bounds.latMin && place.lat <= bounds.latMax &&
        place.lon >= bounds.lonMin && place.lon <= bounds.lonMax) {
      const canonical = _STADTTEIL_CANONICAL[name] || name;
      return STADTTEIL_INDEX[canonical] || null;
    }
  }
  // Fallback: nearest Stadtteil center (within 2km)
  let nearest = null, nearestDist = 2000;
  for (const [name, bounds] of Object.entries(STADTTEILE)) {
    const centerLat = (bounds.latMin + bounds.latMax) / 2;
    const centerLon = (bounds.lonMin + bounds.lonMax) / 2;
    const dist = haversine(place.lat, place.lon, centerLat, centerLon);
    if (dist < nearestDist) {
      const canonical = _STADTTEIL_CANONICAL[name] || name;
      const idx = STADTTEIL_INDEX[canonical];
      if (idx) { nearest = idx; nearestDist = dist; }
    }
  }
  return nearest;
}

// ═══ CATEGORY-SPECIFIC HOUR CURVES ═══
// Cafes peak 15-17, Bars peak 20-23, Clubs peak 23-02
const HOUR_CURVES = {
  cafe_weekday: {
    0: 0.01, 1: 0.01, 2: 0.01, 3: 0.01, 4: 0.01, 5: 0.01,
    6: 0.05, 7: 0.15, 8: 0.35, 9: 0.50, 10: 0.60, 11: 0.65,
    12: 0.55, 13: 0.50, 14: 0.60, 15: 0.75, 16: 0.80, 17: 0.65,
    18: 0.40, 19: 0.20, 20: 0.10, 21: 0.05, 22: 0.02, 23: 0.01
  },
  cafe_weekend: {
    0: 0.01, 1: 0.01, 2: 0.01, 3: 0.01, 4: 0.01, 5: 0.01,
    6: 0.03, 7: 0.08, 8: 0.20, 9: 0.40, 10: 0.65, 11: 0.80,
    12: 0.70, 13: 0.60, 14: 0.70, 15: 0.85, 16: 0.90, 17: 0.70,
    18: 0.40, 19: 0.20, 20: 0.10, 21: 0.05, 22: 0.02, 23: 0.01
  },
  bar_weekday: {
    0: 0.25, 1: 0.15, 2: 0.08, 3: 0.03, 4: 0.01, 5: 0.01,
    6: 0.02, 7: 0.03, 8: 0.05, 9: 0.06, 10: 0.08, 11: 0.12,
    12: 0.18, 13: 0.15, 14: 0.12, 15: 0.14, 16: 0.18, 17: 0.30,
    18: 0.45, 19: 0.60, 20: 0.80, 21: 0.90, 22: 0.85, 23: 0.60
  },
  bar_weekend: {
    0: 0.65, 1: 0.50, 2: 0.35, 3: 0.20, 4: 0.08, 5: 0.03,
    6: 0.02, 7: 0.03, 8: 0.05, 9: 0.06, 10: 0.10, 11: 0.15,
    12: 0.20, 13: 0.18, 14: 0.16, 15: 0.20, 16: 0.25, 17: 0.35,
    18: 0.50, 19: 0.65, 20: 0.78, 21: 0.88, 22: 0.95, 23: 1.00
  },
  club_weekday: {
    0: 0.40, 1: 0.30, 2: 0.15, 3: 0.05, 4: 0.02, 5: 0.01,
    6: 0.01, 7: 0.01, 8: 0.01, 9: 0.01, 10: 0.01, 11: 0.01,
    12: 0.01, 13: 0.01, 14: 0.01, 15: 0.01, 16: 0.01, 17: 0.05,
    18: 0.08, 19: 0.12, 20: 0.25, 21: 0.40, 22: 0.65, 23: 0.85
  },
  club_weekend: {
    0: 0.90, 1: 0.85, 2: 0.70, 3: 0.50, 4: 0.30, 5: 0.15,
    6: 0.05, 7: 0.01, 8: 0.01, 9: 0.01, 10: 0.01, 11: 0.01,
    12: 0.01, 13: 0.01, 14: 0.01, 15: 0.02, 16: 0.05, 17: 0.10,
    18: 0.20, 19: 0.35, 20: 0.55, 21: 0.70, 22: 0.85, 23: 1.00
  },
  restaurant_weekday: {
    0: 0.02, 1: 0.01, 2: 0.01, 3: 0.01, 4: 0.01, 5: 0.01,
    6: 0.02, 7: 0.05, 8: 0.10, 9: 0.12, 10: 0.15, 11: 0.40,
    12: 0.70, 13: 0.65, 14: 0.35, 15: 0.20, 16: 0.15, 17: 0.25,
    18: 0.55, 19: 0.80, 20: 0.90, 21: 0.75, 22: 0.45, 23: 0.15
  },
  restaurant_weekend: {
    0: 0.05, 1: 0.02, 2: 0.01, 3: 0.01, 4: 0.01, 5: 0.01,
    6: 0.02, 7: 0.05, 8: 0.10, 9: 0.15, 10: 0.25, 11: 0.50,
    12: 0.75, 13: 0.70, 14: 0.40, 15: 0.25, 16: 0.20, 17: 0.30,
    18: 0.60, 19: 0.85, 20: 0.95, 21: 0.80, 22: 0.50, 23: 0.20
  }
};

function getCurveType(category) {
  const cat = (category || '').toLowerCase();
  if (['cafe', 'coffee'].includes(cat)) return 'cafe';
  if (['nightclub', 'club'].includes(cat)) return 'club';
  if (['restaurant', 'mittagstisch'].includes(cat)) return 'restaurant';
  return 'bar'; // Default: bar, pub, cocktailbar, wine, biergarten, etc.
}

function getHourMultiplier(dow, hour, category) {
  const isWeekend = (dow === 5 || dow === 6);
  const curveType = getCurveType(category);
  const key = `${curveType}_${isWeekend ? 'weekend' : 'weekday'}`;
  const curve = HOUR_CURVES[key] || HOUR_CURVES.bar_weekday;
  return curve[hour] || 0.1;
}

// ═══ WEATHER DYNAMICS: Temperature jumps, rain changes ═══
let _yesterdayWeather = null;

function getWeatherDynamicsBonus(weather) {
  if (!weather || !weather.temperature) return 0;
  let bonus = 0;
  const temp = weather.temperature;
  const code = weather.weathercode || 0;

  // Temperature jump from yesterday
  if (_yesterdayWeather && _yesterdayWeather.temperature) {
    const tempDiff = temp - _yesterdayWeather.temperature;
    if (tempDiff >= 10) bonus += 15;       // +10 Grad = massiver Outdoor-Effekt
    else if (tempDiff >= 5) bonus += 8;    // +5 Grad = spuerbar mehr los
    else if (tempDiff <= -10) bonus -= 10; // Kaelteeinbruch
    else if (tempDiff <= -5) bonus -= 5;

    // Rain to sunshine switch
    const wasRainy = _yesterdayWeather.weathercode >= 51;
    const isSunny = code < 3;
    if (wasRainy && isSunny && temp > 12) bonus += 10; // Regen -> Sonne = alle raus!
    if (!wasRainy && code >= 61) bonus -= 5;            // Sonne -> Regen = Daempfer
  }

  // First warm day of season (> 18 Grad nach langem Winter)
  const month = new Date().getMonth();
  if ([2, 3].includes(month) && temp > 18 && code < 3) bonus += 12; // Fruehlings-Effekt
  if ([8, 9].includes(month) && temp > 20 && code < 3) bonus += 5;  // Spaetsommer-Bonus

  return bonus;
}

// ═══ SEASON FACTOR (improved: considers daylight + temperature) ═══
function getSeasonFactor(weather) {
  const month = new Date().getMonth();
  const temp = weather?.temperature || 10;
  // Base season factor
  let factor = ([10,11,0,1].includes(month)) ? 0.7 : ([2,3,8,9].includes(month)) ? 0.85 : 1.0;
  // Temperature adjustment: warm winter day = boost, cold summer day = penalty
  if (factor < 1.0 && temp > 12) factor += 0.1; // Milder Wintertag
  if (factor >= 1.0 && temp < 12) factor -= 0.1; // Kalter Sommertag
  return Math.max(0.5, Math.min(1.1, factor));
}

function findDayPeak(place, targetDow, context) {
  const dayMult = { 0: 0.4, 1: 0.35, 2: 0.4, 3: 0.55, 4: 0.7, 5: 1.0, 6: 0.95 }[targetDow] || 0.4;
  const rawBase = place.vibeScore || place.enriched?.vibeScore || computeBaseVibe(place);
  const baseScore = Math.min(rawBase, 70);
  const month = new Date().getMonth();
  const seasonFactor = ([10,11,0,1].includes(month)) ? 0.7 : ([2,3,8,9].includes(month)) ? 0.85 : 1.0;
  const eventBoost = (context && context.hasEventToday) ? 12 : 0;
  const isAfterworkDay = (context && context.isAfterworkDay) ? 8 : 0;
  const weatherMod = (context && context.weather) ? getWeatherMod(place, context.weather) : 0;
  const weatherPenaltyPct = weatherMod < 0 ? (weatherMod / 100) : 0;
  const addBoosts = (eventBoost + isAfterworkDay + Math.max(0, weatherMod)) * seasonFactor;
  let peakScore = 0;
  let peakHour = 20;
  for (let h = 0; h < 24; h++) {
    const hourMult = getHourMultiplier(targetDow, h, place.category);
    const score = (baseScore * dayMult * hourMult + addBoosts) * (1 + weatherPenaltyPct);
    if (score > peakScore) { peakScore = score; peakHour = h; }
  }
  return { peakScore: Math.round(Math.min(100, peakScore)), peakHour };
}

function calculateVibeForDay(place, targetDow, currentHour) {
  const dayMult = { 0: 0.4, 1: 0.35, 2: 0.4, 3: 0.55, 4: 0.7, 5: 1.0, 6: 0.95 }[targetDow] || 0.4;
  const rawBase = place.vibeScore || place.enriched?.vibeScore || computeBaseVibe(place);
  const baseScore = Math.min(rawBase, 70);
  const hourMult = getHourMultiplier(targetDow, currentHour, place.category);
  const vibeAtHour = Math.round(Math.min(100, baseScore * dayMult * hourMult));
  const { peakScore, peakHour } = findDayPeak(place, targetDow, {});
  return { vibeAtHour, vibePeak: peakScore, vibePeakHour: peakHour };
}

function calculateDynamicVibe(place, context) {
  const { dow, hour, minute, weather, isAfterworkDay, hasEventToday } = context;

  const rawBase = place.vibeScore || place.enriched?.vibeScore || computeBaseVibe(place);
  const baseScore = Math.min(rawBase, 70);

  const openStatus = isOpenSmart(place.opening_hours || place.enriched?.opening_hours, place.category);
  const closedPenalty = (openStatus === false || openStatus === 'likely_closed') ? 0.25
    : (openStatus === 'likely') ? 0.7
    : (openStatus === null) ? 0.5
    : 1.0;

  // ── 1. DAY MULTIPLIER (Basis: Wochentag) ──
  // So=0.4, Mo=0.35, Di=0.4, Mi=0.55, Do=0.7, Fr=1.0, Sa=0.95
  let dayMultiplier = { 0: 0.4, 1: 0.35, 2: 0.4, 3: 0.55, 4: 0.7, 5: 1.0, 6: 0.95 }[dow] || 0.4;

  // Feiertag = wie Samstag (Leute haben frei, gehen abends raus)
  if (context.holiday) dayMultiplier = Math.max(dayMultiplier, 0.90);
  // Brueckentag = wie Freitag (viele haben frei genommen)
  if (context.bridgeDay) dayMultiplier = Math.max(dayMultiplier, 0.85);
  // Vorabend eines Feiertags = Boost (morgen frei = laenger feiern)
  if (context.holidayEve) dayMultiplier = Math.max(dayMultiplier, 0.90);

  // ── 2. HOUR MULTIPLIER (Kategorie-spezifische Kurven) ──
  const hourMultiplier = getHourMultiplier(dow, hour, place.category);

  // ── 3. WETTER (gefuehlte Temperatur + stuendlicher Forecast) ──
  // Fuer die relevante Ausgehzeit (17-23h) das stuendliche Wetter nehmen
  const relevantHour = (hour >= 17 && hour <= 23) ? hour : Math.max(hour, 19);
  const effectiveTemp = getEffectiveTemperature(weather, relevantHour, context.weatherData);
  // weatherMod mit effektiver Temperatur berechnen
  const weatherForVibe = weather ? { ...weather, temperature: effectiveTemp } : weather;
  const weatherMod = getWeatherMod(place, weatherForVibe);
  
  // Wind-Malus fuer Outdoor-Locations
  const hourlyW = getHourlyWeather(relevantHour, context.weatherData);
  let windPenalty = 0;
  if (hourlyW && hourlyW.windspeed > 30 && (place.outdoor_seating || (place.category || '') === 'biergarten')) {
    windPenalty = -8; // Starker Wind = Outdoor unangenehm
  } else if (hourlyW && hourlyW.windspeed > 50) {
    windPenalty = -5; // Sturm = auch Indoor weniger Leute unterwegs
  }

  const eventBoost = hasEventToday ? 12 : 0;
  const afterworkBoost = isAfterworkDay ? 8 : 0;

  const seasonFactor = getSeasonFactor(weather);

  // ── 4. STADTTEIL (Demografie + Peak-Days) ──
  const stadtteil = getStadtteilForPlace(place);
  let stadtteilMod = stadtteil ? (stadtteil.barDensityFactor - 0.5) * 15 : 0;
  
  // Stadtteil-Peak-Days: Bonus wenn heute ein Peak-Day fuer dieses Viertel ist
  if (stadtteil && stadtteil.peakDays && stadtteil.peakDays.includes(dow)) {
    stadtteilMod += 3; // Dieses Viertel ist heute besonders aktiv
  }

  // Weather dynamics (temperature jumps, rain-to-sun transitions)
  const weatherDynamics = getWeatherDynamicsBonus(weather);

  // ── 5. GROSSEVENTS (stadtteil-spezifisch) ──
  let majorEventBoost = 0;
  if (context.majorEventsEnriched && context.majorEventsEnriched.length > 0) {
    for (const evt of context.majorEventsEnriched) {
      if (!evt.stadtteile) { // ueberall (z.B. Silvester)
        majorEventBoost += evt.boost;
      } else if (stadtteil) {
        // Nur Boost wenn die Bar im betroffenen Stadtteil ist
        const stadtteilName = Object.entries(STADTTEIL_INDEX).find(([k, v]) => v === stadtteil)?.[0] || '';
        if (evt.stadtteile.includes(stadtteilName)) {
          majorEventBoost += evt.boost;
        }
      }
    }
  }

  // ── 6. SEMESTER-EFFEKT (Studenten-Stadtteile) ──
  let semesterMod = 0;
  if (stadtteil && ['jung', 'jung-gemischt'].includes(stadtteil.ageGroup)) {
    if (context.vorlesungszeit) {
      semesterMod = 3; // Studenten da = mehr los in jungen Vierteln
    } else {
      semesterMod = -4; // Semesterferien = weniger junge Leute
    }
  }

  // ── 7. PAYWEEK ──
  const payweekFactor = context.payweekFactor || 1.0;

  // ── 8. DUNKELHEIT/TAGESLICHT ──
  let daylightMod = 0;
  if (context.sunsetHour && place.outdoor_seating) {
    // Biergarten nach Sonnenuntergang: Attraktivitaet sinkt (ausser Sommer)
    const month = new Date().getMonth();
    if (hour > context.sunsetHour && ![5, 6, 7].includes(month)) {
      daylightMod = -3; // Dunkel + nicht Sommer = Outdoor weniger attraktiv
    }
    // Lange Sommerabende: Outdoor-Bonus
    if (context.sunsetHour >= 21 && hour <= context.sunsetHour) {
      daylightMod = 4; // Noch hell um 21h = Biergarten-Goldzeit
    }
  }

  // ── SCORE-BERECHNUNG ──
  const combinedMult = dayMultiplier * hourMultiplier;
  const baseWithTime = baseScore * combinedMult;
  
  // Additive Boosts (skaliert mit seasonFactor)
  const addBoosts = (eventBoost + afterworkBoost + Math.max(0, weatherMod) + stadtteilMod 
    + weatherDynamics + majorEventBoost + semesterMod + daylightMod + windPenalty) * seasonFactor;
  
  // Weather penalties als Prozent
  const weatherPenaltyPct = weatherMod < 0 ? (weatherMod / 100) : 0;
  
  // Payweek als Multiplikator auf Gesamtscore
  let dynamicScore = (baseWithTime + addBoosts) * (1 + weatherPenaltyPct) * closedPenalty * payweekFactor;
  dynamicScore = Math.max(0, Math.min(100, dynamicScore));

  // Peak for today
  const { peakScore, peakHour } = findDayPeak(place, dow, context);

  // Trend: compare current hour vs next hour
  const nextHour = (hour + 1) % 24;
  const currentHourMult = getHourMultiplier(dow, hour, place.category);
  const nextHourMult = getHourMultiplier(dow, nextHour, place.category);
  const diff = nextHourMult - currentHourMult;
  let vibeTrend = 'stable';
  if (diff > 0.10) vibeTrend = 'up';
  else if (diff > 0.03) vibeTrend = 'slightly_up';
  else if (diff < -0.10) vibeTrend = 'down';
  else if (diff < -0.03) vibeTrend = 'slightly_down';

  // ── REASONS (max 3 fuer bessere Erklaerung) ──
  const reasons = [];
  if (context.holiday) reasons.push('\u{1F389} Feiertag');
  else if (context.holidayEve) reasons.push('\u{1F389} Morgen frei!');
  else if (context.bridgeDay) reasons.push('\u{1F389} Brueckentag');
  else if (dow === 5 || dow === 6) reasons.push('\u{1F525} Weekend');
  if (majorEventBoost > 0) reasons.push('\u{1F3AA} ' + (context.majorEventsEnriched[0]?.name || 'Grossevent'));
  if (hasEventToday && majorEventBoost === 0) reasons.push('\u{1F389} Event heute');
  if (isAfterworkDay && hour >= 16 && hour <= 20) reasons.push('\u{1F37B} Afterwork');
  if (weatherMod > 0 && place.outdoor_seating) reasons.push('\u2600\uFE0F Biergarten-Wetter');
  else if (weatherMod > 5 && !place.outdoor_seating) reasons.push('\u{1F327}\uFE0F Gemuetlich drinnen');
  if (hourMultiplier > 0.7) reasons.push('\u23F0 Prime Time');
  if (stadtteil && stadtteil.barDensityFactor >= 0.9) reasons.push('\u{1F3D9}\uFE0F Hotspot-Viertel');
  if (weatherDynamics >= 8) reasons.push('\u2600\uFE0F Wetterumschwung!');
  if (daylightMod > 0) reasons.push('\u{1F305} Langer Abend');
  if (!context.vorlesungszeit && semesterMod < 0) reasons.push('\u{1F393} Semesterferien');
  const vibeReason = reasons.slice(0, 3).join(' + ');

  return {
    dynamicVibeScore: Math.round(dynamicScore),
    baseVibeScore: baseScore,
    vibeReason: vibeReason || null,
    vibePeak: peakScore,
    vibePeakHour: peakHour,
    vibeTrend: vibeTrend,
    neighborhood: stadtteil ? {
      nightlifeScore: stadtteil.nightlifeScore,
      vibe: stadtteil.vibe,
      ageGroup: stadtteil.ageGroup,
      barDensity: stadtteil.barDensity
    } : null,
    factors: {
      dayMultiplier: Math.round(dayMultiplier * 100) / 100,
      hourMultiplier,
      weatherMod,
      weatherDynamics,
      stadtteilMod: Math.round(stadtteilMod * 10) / 10,
      seasonFactor,
      eventBoost,
      afterworkBoost,
      majorEventBoost,
      semesterMod,
      payweekFactor,
      daylightMod,
      windPenalty,
      holiday: context.holiday || false,
      bridgeDay: context.bridgeDay || false,
      holidayEve: context.holidayEve || false
    }
  };
}


function getTimeCurve(category, hour) {
  const curves = {
    'cafe': {
      peaks: [[9, 14]], // 9-14 Uhr Peak
      maxBoost: 25
    },
    'bar': {
      peaks: [[19, 23]], // 19-23 Uhr Peak
      maxBoost: 30
    },
    'cocktailbar': {
      peaks: [[21, 1]], // 21-01 Uhr Peak (cross midnight)
      maxBoost: 35
    },
    'biergarten': {
      peaks: [[15, 21]], // 15-21 Uhr Peak
      maxBoost: 25
    },
    'pub': {
      peaks: [[18, 23]], // 18-23 Uhr Peak
      maxBoost: 28
    },
    'irish-pub': {
      peaks: [[17, 23]], // 17-23 Uhr Peak
      maxBoost: 28
    },
    'wine': {
      peaks: [[18, 22]], // 18-22 Uhr Peak
      maxBoost: 25
    },
    'nightclub': {
      peaks: [[22, 3]], // 22-03 Uhr Peak
      maxBoost: 40
    }
  };
  
  const cat = (category || '').toLowerCase();
  const curve = curves[cat] || curves['bar']; // default to bar
  
  let bestBoost = 0;
  
  for (const [start, end] of curve.peaks) {
    let inPeak = false;
    let distanceFromCenter = 99;
    
    if (end < start) { // crosses midnight (e.g., 21-01)
      if (hour >= start || hour <= end) {
        inPeak = true;
        const center = (start + (end + 24)) / 2;
        const adjustedHour = hour < start ? hour + 24 : hour;
        distanceFromCenter = Math.abs(adjustedHour - center);
      }
    } else {
      if (hour >= start && hour <= end) {
        inPeak = true;
        const center = (start + end) / 2;
        distanceFromCenter = Math.abs(hour - center);
      }
    }
    
    if (inPeak) {
      const maxDistance = Math.abs(end - start) / 2;
      const boost = curve.maxBoost * (1 - distanceFromCenter / maxDistance);
      bestBoost = Math.max(bestBoost, boost);
    } else {
      // Gradual falloff outside peak hours
      let nearDistance = Math.min(
        Math.abs(hour - start),
        Math.abs(hour - (end % 24)),
        24 - Math.abs(hour - start),
        24 - Math.abs(hour - (end % 24))
      );
      
      if (nearDistance <= 2) {
        const falloffBoost = curve.maxBoost * 0.3 * (1 - nearDistance / 2);
        bestBoost = Math.max(bestBoost, falloffBoost);
      }
    }
  }
  
  return Math.max(0, bestBoost);
}

function getWeatherMod(place, weather) {
  if (!weather || !weather.weathercode) return 0;
  
  const code = weather.weathercode;
  const temp = weather.temperature || 15;
  const cat = (place.category || '').toLowerCase();
  const desc = ((place.description || '') + ' ' + (place.name || '')).toLowerCase();
  const isOutdoor = place.outdoor_seating || cat === 'biergarten' || 
                   /biergarten|terrasse|outdoor|draußen|beach|strand|garten/i.test(desc);
  
  let mod = 0;
  
  // Very cold (< 0°C) — ALWAYS negative, nobody goes out in freezing weather
  if (temp < 0) {
    mod = -20; // Freezing = everyone stays home, indoor "cozy" doesn't compensate
    if (isOutdoor) mod = -40;
  }
  // Heavy rain/storm + cold (code >= 61, temp < 10)
  else if (code >= 61 && temp < 10) {
    if (isOutdoor) {
      mod = -30;
    } else {
      mod = -5; // Bad weather + cold = fewer people even indoors
    }
  }
  // Heavy rain/storm + warm (code >= 61, temp >= 10)
  else if (code >= 61) {
    if (isOutdoor) {
      mod = -30;
    } else {
      mod = 5; // Warm rain = some indoor cozy factor
    }
  }
  // Light rain/drizzle (code 51-60)  
  else if (code >= 51) {
    if (isOutdoor) {
      mod = -15;
    } else {
      mod = temp >= 10 ? 3 : -3; // Only slight boost if warm enough
    }
  }
  // Clear/sunny + warm
  else if (code < 3 && temp >= 20) {
    if (isOutdoor) {
      mod = 20;
    } else {
      mod = -5;
    }
  }
  // Cold but dry (0-5°C)
  else if (temp < 5) {
    mod = -10; // Cold = fewer people out
  }
  // Moderate cold (0-10°C)
  else if (temp < 10) {
    if (isOutdoor) {
      mod = -10;
    } else {
      mod = 5; // Warm bars are attractive
    }
  }
  
  return mod;
}

function getVibeLabel(score) {
  if (score >= 80) return '🔥 Jetzt perfekt!';
  if (score >= 65) return 'Sehr gute Vibe';
  if (score >= 50) return 'Gute Chancen';
  if (score >= 35) return 'Etwas los';
  if (score >= 20) return 'Ruhig bis mäßig';
  if (score >= 10) return 'Eher leer';
  return 'Tote Hose';
}

function getVibeEmoji(score) {
  // Spektrum: gelangweilt (nichts los) → Party (Hütte brennt)
  if (score >= 85) return '🎉';  // Party! Hütte brennt
  if (score >= 70) return '🔥';  // Richtig was los
  if (score >= 55) return '🥳';  // Gute Stimmung
  if (score >= 40) return '😊';  // Nett, gemütlich
  if (score >= 25) return '😐';  // Wenig los
  if (score >= 10) return '😴';  // Kaum was los
  return '🥱';                    // Tote Hose
}

function getCurrentVibeContext() {
  const { hour, minute, dow } = getHamburgTime();
  const weather = weatherCache.current;
  const now = new Date();
  
  // Check if today is an afterwork day for any location
  const todayLocations = afterworkSchedule.locations.filter(loc => loc.days.includes(dow));
  const isAfterworkDay = todayLocations.length > 0;
  
  // Check if there are major events today
  const majorEvents = getActiveMajorEvents();
  const hasEventToday = majorEvents.length > 0;

  // New enriched context
  const holiday = isHoliday(now);
  const holidayName = holiday ? getHolidayName(now) : null;
  const bridgeDay = isBridgeDay(now);
  const holidayEve = isHolidayEve(now);
  const majorEventsEnriched = getActiveMajorEventsEnriched(now);
  const vorlesungszeit = isVorlesungszeit(now);
  const payweekFactor = getPayweekFactor(now);
  const sunsetHour = getSunsetHour(weatherCache);
  const sunriseHour = getSunriseHour(weatherCache);
  
  return {
    dow,
    hour,
    minute,
    weather,
    weatherData: weatherCache, // full hourly data
    isAfterworkDay,
    hasEventToday,
    // Phase 1
    holiday,
    holidayName,
    bridgeDay,
    holidayEve,
    // Phase 2
    majorEventsEnriched,
    vorlesungszeit,
    payweekFactor,
    sunsetHour,
    sunriseHour
  };
}

// ═══════════════════════════════════════════════════════════════
// 🎉 LEGACY VIBE SCORE — "Wie wahrscheinlich triffst du Leute?"
// ═══════════════════════════════════════════════════════════════

function computeVibeScore(place, isHighlight = false) {
  const cat = (place.category || '').toLowerCase();
  const desc = ((place.description || '') + ' ' + (place.name || '')).toLowerCase();
  const open = isOpenNow(place.opening_hours);
  if (open === false) return { vibe: 0, vibeLabel: 'Geschlossen', vibeEmoji: '😴' };

  // Restaurants, Frühstück, Mittagstisch ohne Bar-Charakter: kein VibeScore
  const noVibeCats = ['restaurant', 'fruehstueck', 'mittagstisch', 'dinner'];
  if (noVibeCats.includes(cat) && !/bar|lounge|cocktail/i.test(desc)) {
    return { vibe: 0, vibeLabel: '', vibeEmoji: '🍽️' };
  }

  // === USE UNIFIED calculateDynamicVibe for consistency ===
  const ctx = getCurrentVibeContext();
  const dv = calculateDynamicVibe(place, ctx);
  const vibe = dv.dynamicVibeScore;
  return { vibe, vibeLabel: getVibeLabel(vibe), vibeEmoji: getVibeEmoji(vibe) };
}
// ═══════════════════════════════════════════════════════════════
// 🎯 HELPER FUNCTIONS FOR IMPROVED HOTSCORE
// ═══════════════════════════════════════════════════════════════

function estimatePopularityByCategory(category, timeDecimal, dow) {
  const curves = {
    'nightclub': { peak_hours: [23, 24, 1], base_multiplier: 0.6, weekend_multiplier: 1.8 },
    'cocktailbar': { peak_hours: [20, 21, 22, 23], base_multiplier: 0.7, weekend_multiplier: 1.5 },
    'pub': { peak_hours: [19, 20, 21, 22], base_multiplier: 0.8, weekend_multiplier: 1.4 },
    'irish-pub': { peak_hours: [18, 19, 20, 21, 22], base_multiplier: 0.8, weekend_multiplier: 1.4 },
    'wine': { peak_hours: [18, 19, 20, 21], base_multiplier: 0.6, weekend_multiplier: 1.3 },
    'cafe': { peak_hours: [10, 11, 12, 13, 14, 15], base_multiplier: 0.5, weekend_multiplier: 1.2 }
  };
  
  const curve = curves[category] || curves['pub'];
  const isWeekend = (dow === 5 || dow === 6);
  const hour = Math.floor(timeDecimal);
  
  let score = 0;
  
  // Peak Hours Check
  if (curve.peak_hours.includes(hour) || curve.peak_hours.includes(hour % 24)) {
    score += 40; // Peak time base score
    
    // Distance from peak center
    const peakCenter = curve.peak_hours[Math.floor(curve.peak_hours.length / 2)];
    const distanceFromPeak = Math.abs(hour - peakCenter);
    score += Math.max(0, 20 - distanceFromPeak * 5);
  } else {
    score += 10; // Off-peak base
  }
  
  // Weekend multiplier
  if (isWeekend) score *= curve.weekend_multiplier;
  
  // Category base multiplier
  score *= curve.base_multiplier;
  
  return Math.min(60, score); // Max 60 for estimated
}

function getTodaysEvents(placeKey, dow, hour) {
  const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const today = dayNames[dow];
  
  // Merge events from BOTH sources (eventsCache from events_cache.json AND eventsData)
  const cacheEvents = eventsCache[placeKey] || [];
  const dataEvents = eventsData[placeKey] || [];
  const allEvents = [...cacheEvents, ...dataEvents];
  
  return allEvents.filter(event => {
    // Check if event is today (support both formats)
    if (event.days && !event.days.includes(today)) return false;
    if (event.weekday && event.weekday.toLowerCase() !== today) return false;
    
    // Check if event is around current time (within 4 hours)
    if (event.start_hour) {
      return Math.abs(hour - event.start_hour) <= 4;
    }
    const eventTime = parseEventTime(event.times) || getDefaultEventTime(event.type);
    const timeDiff = Math.abs(hour - eventTime);
    return timeDiff <= 4;
  });
}

function parseEventTime(timeStrings) {
  if (!timeStrings || timeStrings.length === 0) return null;
  const timeStr = timeStrings[0]; // Take first time
  const match = timeStr.match(/(\d{1,2}):(\d{2})/);
  if (match) return parseInt(match[1]) + parseInt(match[2]) / 60;
  return null;
}

function getDefaultEventTime(eventType) {
  const defaults = {
    'quiz': 20, 'live_music': 21, 'karaoke': 21, 'dj': 22,
    'football': 20, 'after_work': 18, 'happy_hour': 17, 'party': 22
  };
  return defaults[eventType] || 20;
}

function getImprovedDayFactors(dow, category, hour) {
  // Verbesserte Tag-spezifische Scores
  const dayScores = {
    'cafe': { 0: 15, 1: 6, 2: 7, 3: 7, 4: 10, 5: 18, 6: 20 },        
    'pub': { 0: 12, 1: 5, 2: 7, 3: 10, 4: 15, 5: 23, 6: 25 },         
    'cocktailbar': { 0: 10, 1: 4, 2: 6, 3: 10, 4: 15, 5: 28, 6: 30 }, 
    'nightclub': { 0: 6, 1: 2, 2: 3, 3: 6, 4: 10, 5: 33, 6: 38 },     
    'wine': { 0: 10, 1: 5, 2: 7, 3: 10, 4: 12, 5: 20, 6: 22 },        
    'irish-pub': { 0: 15, 1: 8, 2: 10, 3: 12, 4: 15, 5: 25, 6: 28 }   
  };
  
  const scores = dayScores[category] || dayScores['pub'];
  const base_score = scores[dow] || 5;
  
  // Weekend Bonus (zeit-abhängig)
  let weekend_bonus = 0;
  if ((dow === 5 || dow === 6) && hour >= 21) { // Fr/Sa ab 21 Uhr
    weekend_bonus = {
      'nightclub': 15, 'cocktailbar': 12, 'pub': 8, 'irish-pub': 8, 'wine': 5, 'cafe': 3
    }[category] || 8;
  }
  
  return { base_score, weekend_bonus };
}

function getCategoryTimeAdjustment(category, hour) {
  let adjustment = 0;
  
  if (category === 'cafe') {
    if (hour >= 8 && hour <= 14) adjustment += 10;  
    if (hour >= 15 && hour <= 17) adjustment += 6;  
    if (hour >= 18) adjustment -= 8; 
  }
  
  if (category === 'nightclub') {
    if (hour >= 23 || hour <= 3) adjustment += 18; 
    if (hour >= 21 && hour < 23) adjustment += 10; 
    if (hour < 18) adjustment -= 15; 
  }
  
  if (category === 'cocktailbar') {
    if (hour >= 19 && hour <= 23) adjustment += 12; 
    if (hour >= 17 && hour < 19) adjustment += 6;   
    if (hour >= 0 && hour <= 2) adjustment += 10;   
  }
  
  if (category === 'wine') {
    if (hour >= 18 && hour <= 22) adjustment += 10; 
    if (hour >= 16 && hour < 18) adjustment += 4;   
  }
  
  return adjustment;
}

function getEnhancedDescriptionBonus(description) {
  if (!description) return 0;
  
  const desc = description.toLowerCase();
  let bonus = 0;
  
  // High-impact Keywords
  if (desc.includes('kult') || desc.includes('legendär') || desc.includes('legende')) bonus += 10;
  if (desc.includes('institution') || desc.includes('tradition')) bonus += 8;
  if (desc.includes('beliebt') || desc.includes('hotspot') || desc.includes('szene')) bonus += 6;
  
  // Event Keywords
  if (desc.includes('live musik') || desc.includes('live music')) bonus += 6;
  if (desc.includes('dj') || desc.includes('party') || desc.includes('event')) bonus += 5;
  if (desc.includes('quiz') || desc.includes('karaoke')) bonus += 5;
  if (desc.includes('konzert') || desc.includes('band')) bonus += 4;
  
  // Special Features
  if (desc.includes('happy hour')) bonus += 4;
  if (desc.includes('24/7') || desc.includes('24 stunden')) bonus += 6;
  if (desc.includes('biergarten') || desc.includes('terrasse')) bonus += 3;
  if (desc.includes('craft beer') || desc.includes('craft bier')) bonus += 3;
  
  return Math.min(bonus, 18); // Max 18 points
}

function getEnhancedScoreLabel(score, category, hasEvents) {
  if (hasEvents) {
    // Event-spezifische Labels
    if (score >= 80) return { label: 'Event heute - sehr voll!', color: 'hot' };
    else if (score >= 60) return { label: 'Event heute - gut besucht', color: 'warm' };
    else if (score >= 40) return { label: 'Event heute - mäßig belebt', color: 'medium' };
    else return { label: 'Event heute - entspannt', color: 'cool' };
  } else {
    // Standard Labels (verbessert)
    if (score >= 75) return { label: 'Wahrscheinlich sehr voll', color: 'hot' };
    else if (score >= 55) return { label: 'Gut besucht', color: 'warm' };
    else if (score >= 35) return { label: 'Mäßig belebt', color: 'medium' };
    else if (score >= 20) return { label: 'Eher ruhig', color: 'cool' };
    else return { label: 'Sehr ruhig', color: 'cold' };
  }
}


function getRealTimeAdjustment(placeKey) {
  const realTime = realTimeData[placeKey];
  if (!realTime) return 0;
  
  // Real-time factors (if available)
  let adjustment = 0;
  
  if (realTime.current_visitors) {
    // Adjust based on current visitor count vs. normal
    const ratio = realTime.current_visitors / (realTime.normal_visitors || 100);
    if (ratio > 1.5) adjustment += 15;      // Much busier than normal
    else if (ratio > 1.2) adjustment += 8;  // Somewhat busier
    else if (ratio < 0.5) adjustment -= 10; // Much quieter
    else if (ratio < 0.8) adjustment -= 5;  // Somewhat quieter
  }
  
  if (realTime.wait_time_minutes) {
    // Adjust based on wait times
    if (realTime.wait_time_minutes > 30) adjustment += 20;
    else if (realTime.wait_time_minutes > 15) adjustment += 10;
    else if (realTime.wait_time_minutes > 5) adjustment += 5;
  }
  
  return adjustment;
}

function computeWeeklyHeatmap(place, isHighlight) {
  const heatmap = [];
  for (let d = 0; d < 7; d++) {
    const row = [];
    const mockDow = (d + 1) % 7;
    for (let h = 0; h < 24; h++) {
      let s = 0;
      const cat = place.category;
      const dayScores = { 0: 8, 1: 3, 2: 5, 3: 8, 4: 12, 5: 22, 6: 25 };
      s += dayScores[mockDow] || 5;
      if (['nightclub'].includes(cat)) {
        if (h >= 23 || h < 3) s += 35; else if (h >= 21) s += 20; else s += 2;
      } else if (['cafe'].includes(cat)) {
        if (h >= 10 && h <= 14) s += 30; else if (h >= 15 && h <= 17) s += 20; else s += 3;
      } else {
        if (h >= 20 && h <= 23) s += 32; else if (h >= 17 && h < 20) s += 15; else if (h >= 0 && h < 3) s += 20; else s += 2;
      }
      if (isHighlight) s += 15;
      row.push(Math.min(100, Math.max(0, s)));
    }
    heatmap.push(row);
  }
  return { days: ['Mo','Di','Mi','Do','Fr','Sa','So'], heatmap };
}

function computePeakHours(place) {
  const cat = place.category;
  // Peak hours per category: [weekday start, weekday end, weekend start, weekend end]
  const peaks = {
    'pub':          { wd: [19, 23], we: [21, 25] }, // 25 = 01:00 next day
    'bar':          { wd: [19, 23], we: [21, 25] },
    'cocktailbar':  { wd: [20, 23], we: [21, 25] },
    'nightclub':    { wd: null, we: [23, 27] }, // 27 = 03:00
    'cafe':         { wd: [10, 14], we: [10, 14] },
    'wine':         { wd: [18, 22], we: [18, 22] },
    'irish-pub':    { wd: [19, 23], we: [20, 25] },
    'biergarten':   { wd: [17, 22], we: [14, 22] },
  };
  const p = peaks[cat] || peaks['bar'];
  const dayNames = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
  const weekly = [];
  for (let d = 0; d < 7; d++) {
    // d: 0=Mo, 1=Di, ..., 6=So (internal)
    const dow = (d + 1) % 7; // JS dow: 0=So, 1=Mo...
    const isWeekend = (dow === 5 || dow === 6); // Fr, Sa
    const pk = isWeekend ? p.we : p.wd;
    const dayLabel = dayNames[dow];
    if (!pk) {
      weekly.push({ day: dayLabel, dow, open: null, close: null, label: 'geschlossen' });
    } else {
      const openH = pk[0];
      const closeH = pk[1];
      const fmt = h => { const hh = h % 24; return `${String(hh).padStart(2,'0')}:00`; };
      weekly.push({ day: dayLabel, dow, open: openH, close: closeH, label: `${fmt(openH)} – ${fmt(closeH)}` });
    }
  }
  // Today's peak
  const { dow } = getHamburgTime();
  const todayPeak = weekly.find(w => w.dow === dow);
  // Hourly heatmap for today (16:00 to 04:00 = hours 16..28)
  const todayHeatmap = [];
  if (todayPeak && todayPeak.open !== null) {
    for (let h = 16; h <= 28; h++) {
      let intensity = 0;
      if (h >= todayPeak.open && h < todayPeak.close) {
        // Peak zone
        const mid = (todayPeak.open + todayPeak.close) / 2;
        const dist = Math.abs(h - mid);
        const range = (todayPeak.close - todayPeak.open) / 2;
        intensity = Math.round(100 - (dist / range) * 40);
      } else if (h >= todayPeak.open - 1 && h < todayPeak.close + 1) {
        intensity = 30;
      }
      todayHeatmap.push({ hour: h % 24, intensity: Math.max(0, Math.min(100, intensity)) });
    }
  }
  return { today: todayPeak, weekly, todayHeatmap };
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

async function getHotLocations(lat, lon, radius) {
  const highlightNames = new Set(HIGHLIGHTS.map(h => h.name.toLowerCase()));
  const results = [];

  HIGHLIGHTS.forEach(h => {
    const dist = haversine(lat, lon, h.lat, h.lon);
    if (dist <= radius) {
      const hs = computeHotScore(h, true);
      if (hs.score > 0) {
        const vs = computeVibeScore(h, true);
        const rm = fuzzyMatchRating(h.name);
        const bn = estimateBusyness(h, getHamburgTime().dow, getHamburgTime().hour);
        results.push({ ...h, _dist: dist, hotScore: hs.score, hotLabel: hs.label, hotColor: hs.color, has_events: hs.has_events, event_count: hs.event_count, vibeScore: vs.vibe, vibeLabel: vs.vibeLabel, vibeEmoji: vs.vibeEmoji, isOpen: isOpenSmart(h.opening_hours, h.category), openStatus: getOpenStatus(h), communityScore: getCommunityScore(h.name) || null, estimatedBusyness: bn.busyness, busynessLabel: bn.busynessLabel, busynessColor: bn.busynessColor, peakInfo: getPeakInfo(h) });
      }
    }
  });

  const key = cacheKey(lat, lon, radius, 'all');
  const cached = cache[key];
  if (cached) {
    cached.data.forEach(p => {
      if (highlightNames.has(p.name.toLowerCase())) return;
      const dist = haversine(lat, lon, p.lat, p.lon);
      if (dist <= radius) {
        const hs = computeHotScore(p, false);
        if (hs.score > 0) {
          const vs = computeVibeScore(p, false);
          const rm = fuzzyMatchRating(p.name);
          const bn = estimateBusyness(p, getHamburgTime().dow, getHamburgTime().hour);
          results.push({ ...p, _dist: dist, hotScore: hs.score, hotLabel: hs.label, hotColor: hs.color, has_events: hs.has_events, event_count: hs.event_count, vibeScore: vs.vibe, vibeLabel: vs.vibeLabel, vibeEmoji: vs.vibeEmoji, isOpen: isOpenSmart(p.opening_hours, p.category), openStatus: getOpenStatus(p), communityScore: getCommunityScore(p.name) || null, estimatedBusyness: bn.busyness, busynessLabel: bn.busynessLabel, busynessColor: bn.busynessColor, peakInfo: getPeakInfo(p) });
        }
      }
    });
  }

  results.sort((a, b) => b.hotScore - a.hotScore);
  return results.slice(0, 10);
}

// ═══════════════════════════════════════════════════════════════
// 📊 ESTIMATED BUSYNESS — Geschätzte Auslastung (0-100)
// ═══════════════════════════════════════════════════════════════

function getPeakInfo(place) {
  const curves = {
    'nightclub': { peak_hours: [23, 0, 1], weekend_boost: true },
    'cocktailbar': { peak_hours: [20, 21, 22, 23], weekend_boost: true },
    'pub': { peak_hours: [19, 20, 21, 22], weekend_boost: true },
    'irish-pub': { peak_hours: [18, 19, 20, 21, 22], weekend_boost: true },
    'wine': { peak_hours: [18, 19, 20, 21], weekend_boost: true },
    'cafe': { peak_hours: [10, 11, 12, 13, 14, 15], weekend_boost: false }
  };
  const cat = (place.category || 'pub').toLowerCase();
  const curve = curves[cat] || curves['pub'];
  const ph = curve.peak_hours;
  const from = ph[0];
  const to = (ph[ph.length - 1] + 1) % 24;
  const label = `${String(from).padStart(2,'0')}–${String(to).padStart(2,'0')} Uhr`;
  const days = curve.weekend_boost ? 'Fr–Sa beste Zeit' : 'Mo–So';
  return { peakFrom: from, peakTo: to, peakLabel: label, peakDays: days };
}

function estimateBusyness(place, dayOfWeek, hour) {
  // Check if open
  const open = isOpenNow(place.opening_hours);
  if (open === false) return { busyness: 0, busynessLabel: 'Geschlossen', busynessColor: '#666' };

  const cat = (place.category || 'bar').toLowerCase();
  const isWeekend = (dayOfWeek === 5 || dayOfWeek === 6); // Fr/Sa
  const isMidweek = (dayOfWeek === 3 || dayOfWeek === 4); // Mi/Do
  let score = 0;

  // ── 1. Category-specific peak curves ──
  const peakCurves = {
    'cocktailbar': { peaks: [[22, 1]], peakVal: 70, offPeak: 15 },
    'nightclub':   { peaks: [[22, 1]], peakVal: 75, offPeak: 10 },
    'club':        { peaks: [[22, 1]], peakVal: 75, offPeak: 10 },
    'pub':         { peaks: [[20, 23]], peakVal: 60, offPeak: 15 },
    'irish-pub':   { peaks: [[20, 23]], peakVal: 60, offPeak: 15 },
    'biergarten':  { peaks: [[17, 21]], peakVal: 55, offPeak: 10 },
    'wine':        { peaks: [[19, 22]], peakVal: 55, offPeak: 12 },
    'cafe':        { peaks: [[10, 12], [15, 17]], peakVal: 50, offPeak: 15 },
    'restaurant':  { peaks: [[12, 14], [18, 21]], peakVal: 55, offPeak: 12 },
    'bar':         { peaks: [[20, 23]], peakVal: 60, offPeak: 15 },
  };
  const curve = peakCurves[cat] || peakCurves['bar'];
  let inPeak = false;

  for (const [start, end] of curve.peaks) {
    const crossesMidnight = end < start;
    if (crossesMidnight) {
      if (hour >= start || hour <= end) inPeak = true;
    } else {
      if (hour >= start && hour <= end) inPeak = true;
    }
  }

  if (inPeak) {
    // Distance from peak center for gradient
    let bestDist = 99;
    for (const [start, end] of curve.peaks) {
      const mid = (start + ((end < start ? end + 24 : end) - start) / 2) % 24;
      const h = hour;
      const dist = Math.min(Math.abs(h - mid), 24 - Math.abs(h - mid));
      if (dist < bestDist) bestDist = dist;
    }
    score = curve.peakVal - bestDist * 5;
  } else {
    // Ramp up/down near peaks
    let minDist = 99;
    for (const [start, end] of curve.peaks) {
      const dStart = Math.min(Math.abs(hour - start), 24 - Math.abs(hour - start));
      const dEnd = Math.min(Math.abs(hour - (end < start ? end + 24 : end) % 24), 24 - Math.abs(hour - (end < start ? end + 24 : end) % 24));
      minDist = Math.min(minDist, dStart, dEnd);
    }
    if (minDist <= 2) {
      score = curve.offPeak + (curve.peakVal - curve.offPeak) * (1 - minDist / 2) * 0.5;
    } else {
      score = curve.offPeak;
    }
  }

  // ── 2. Day-of-week multiplier ──
  if (isWeekend) score *= 1.3;
  else if (isMidweek) score *= 1.0;
  else score *= 0.75; // So-Di

  // ── 3. Community Score boost ──
  const cs = getCommunityScore(place.name);
  if (cs) {
    if (cs >= 70) score *= 1.10;
    else if (cs >= 55) score *= 1.05;
  }

  // ── 4. Events boost ──
  const placeKey = (place.name || '').toLowerCase().replace(/[^a-z0-9]/g, '_');
  const todayEvents = getTodaysEvents(placeKey, dayOfWeek, hour);
  if (todayEvents.length > 0 || place.has_events) score *= 1.20;

  // ── 5. Smoker bonus (Stammkneipe) ──
  if (place.smoker) score *= 1.05;

  // ── 6. Biergarten summer check ──
  if (cat === 'biergarten') {
    const month = new Date().getMonth(); // 0-11
    if (month < 3 || month > 9) score *= 0.3; // Winter = kaum los
  }

  // ── 7. Weather factor ──
  const wf = getWeatherFactor(place);
  score *= wf.multiplier;

  // ── 8. Major events boost ──
  const meb = getMajorEventBoost();
  score *= meb.boost;

  // Clamp
  score = Math.max(0, Math.min(100, Math.round(score)));

  // Labels
  let busynessLabel, busynessColor;
  if (score === 0)    { busynessLabel = 'Geschlossen'; busynessColor = '#666'; }
  else if (score < 20) { busynessLabel = 'Leer'; busynessColor = '#48484A'; }
  else if (score < 40) { busynessLabel = 'Wenig los'; busynessColor = '#34C759'; }
  else if (score < 60) { busynessLabel = 'Mäßig'; busynessColor = '#FFD60A'; }
  else if (score < 80) { busynessLabel = 'Gut besucht'; busynessColor = '#FF9500'; }
  else                 { busynessLabel = 'Voll'; busynessColor = '#FF453A'; }

  return { busyness: score, busynessLabel, busynessColor };
}

// ═══════════════════════════════════════════════════════════════
// 🔍 SEMANTIC SEARCH ENGINE
// ═══════════════════════════════════════════════════════════════

// Stadtteil-Koordinaten (grobe Bounding-Boxes)
const STADTTEILE = {
  'st. pauli':      { latMin: 53.548, latMax: 53.555, lonMin: 9.955, lonMax: 9.970 },
  'st.pauli':       { latMin: 53.548, latMax: 53.555, lonMin: 9.955, lonMax: 9.970 },
  'pauli':          { latMin: 53.548, latMax: 53.555, lonMin: 9.955, lonMax: 9.970 },
  'reeperbahn':     { latMin: 53.548, latMax: 53.555, lonMin: 9.955, lonMax: 9.970 },
  'schanze':        { latMin: 53.555, latMax: 53.565, lonMin: 9.958, lonMax: 9.970 },
  'sternschanze':   { latMin: 53.555, latMax: 53.565, lonMin: 9.958, lonMax: 9.970 },
  'ottensen':       { latMin: 53.550, latMax: 53.558, lonMin: 9.920, lonMax: 9.940 },
  'eppendorf':      { latMin: 53.580, latMax: 53.595, lonMin: 9.975, lonMax: 10.000 },
  'winterhude':     { latMin: 53.578, latMax: 53.595, lonMin: 10.005, lonMax: 10.025 },
  'eimsbüttel':     { latMin: 53.570, latMax: 53.585, lonMin: 9.945, lonMax: 9.970 },
  'eimsbuettel':    { latMin: 53.570, latMax: 53.585, lonMin: 9.945, lonMax: 9.970 },
  'altona':         { latMin: 53.545, latMax: 53.560, lonMin: 9.930, lonMax: 9.955 },
  'barmbek':        { latMin: 53.575, latMax: 53.590, lonMin: 10.035, lonMax: 10.060 },
  'rotherbaum':     { latMin: 53.565, latMax: 53.580, lonMin: 9.975, lonMax: 9.995 },
  'harvestehude':   { latMin: 53.575, latMax: 53.590, lonMin: 9.985, lonMax: 10.005 },
  'uhlenhorst':     { latMin: 53.570, latMax: 53.580, lonMin: 10.010, lonMax: 10.030 },
  'hafencity':      { latMin: 53.535, latMax: 53.545, lonMin: 9.990, lonMax: 10.010 },
};

// Semantische Begriffe → Kategorien/Eigenschaften
const SEMANTIC_MAP = [
  { terms: ['kneipe', 'kneipen', 'pub', 'pubs'], categories: ['pub', 'irish-pub'] },
  { terms: ['cocktail', 'cocktails', 'cocktailbar', 'drinks', 'mixed'], categories: ['cocktailbar'] },
  { terms: ['bier', 'beer', 'pils', 'craft'], categories: ['pub', 'biergarten', 'irish-pub', 'brewery'] },
  { terms: ['wein', 'wine', 'weinbar', 'vino'], categories: ['wine', 'weinbar'] },
  { terms: ['club', 'clubs', 'disco', 'tanzen', 'feiern', 'party'], categories: ['nightclub'] },
  { terms: ['biergarten', 'garten', 'draußen', 'outdoor', 'terrasse'], prop: 'outdoor_seating' },
  { terms: ['raucher', 'rauchen', 'smoking', 'kippe'], prop: 'smoker' },
  { terms: ['musik', 'live', 'livemusik', 'live-musik', 'konzert', 'band'], tag: 'live-musik' },
  { terms: ['irish', 'irisch', 'guinness'], categories: ['irish-pub'] },
  { terms: ['café', 'cafe', 'kaffee', 'coffee'], categories: ['cafe'] },
  { terms: ['sport', 'fußball', 'fussball', 'bundesliga', 'champions'], categories: ['sports_bar'], tag: 'sport' },
  { terms: ['after work', 'afterwork', 'feierabend'], tag: 'after-work' },
  { terms: ['ruhig', 'gemütlich', 'chill', 'entspannt', 'leise'], mood: 'quiet' },
  { terms: ['laut', 'wild', 'action', 'voll', 'stimmung'], mood: 'loud' },
];

// Fuzzy-String-Match (Levenshtein-basiert, einfach)
function fuzzyScore(needle, haystack) {
  if (!needle || !haystack) return 0;
  const n = needle.toLowerCase();
  const h = haystack.toLowerCase();
  if (h === n) return 100;
  if (h.includes(n)) return 80;
  if (n.includes(h)) return 60;
  // Prefix match
  if (h.startsWith(n) || n.startsWith(h)) return 70;
  // Trigram overlap
  const trigrams = s => { const t = []; for (let i = 0; i <= s.length - 3; i++) t.push(s.slice(i, i+3)); return t; };
  const nt = trigrams(n), ht = new Set(trigrams(h));
  if (nt.length === 0) return 0;
  const overlap = nt.filter(t => ht.has(t)).length;
  return Math.round((overlap / nt.length) * 50);
}

async function semanticSearch(query, lat, lon) {
  const qLow = query.toLowerCase().trim();
  const qWords = qLow.split(/\s+/);

  // ── 1. Stadtteil erkennen ──
  let stadtteilFilter = null;
  let remainingWords = [...qWords];
  for (const [name, bounds] of Object.entries(STADTTEILE)) {
    if (qLow.includes(name)) {
      stadtteilFilter = bounds;
      remainingWords = remainingWords.filter(w => !name.split(/\s+/).includes(w) && !name.includes(w));
      break;
    }
  }
  const cleanQuery = remainingWords.join(' ').trim();

  // ── 2. Semantische Begriffe erkennen ──
  let matchCategories = [];
  let matchProp = null;
  let matchTag = null;
  let matchMood = null;

  for (const sem of SEMANTIC_MAP) {
    for (const term of sem.terms) {
      if (qLow.includes(term)) {
        if (sem.categories) matchCategories.push(...sem.categories);
        if (sem.prop) matchProp = sem.prop;
        if (sem.tag) matchTag = sem.tag;
        if (sem.mood) matchMood = sem.mood;
      }
    }
  }
  matchCategories = [...new Set(matchCategories)];

  // ── 3. Alle Places sammeln (O(1) Dedup via Set) ──
  const nameSet = new Set();
  const allPlaces = [];
  for (const p of HIGHLIGHTS) {
    const key = (p.name || '').toLowerCase();
    if (key && !nameSet.has(key)) { nameSet.add(key); allPlaces.push(p); }
  }
  for (const [, cached] of Object.entries(cache)) {
    if (cached && cached.data) {
      for (const p of cached.data) {
        const key = (p.name || '').toLowerCase();
        if (key && !nameSet.has(key)) { nameSet.add(key); allPlaces.push(p); }
      }
    }
  }

  // ── 4. Pre-filter by distance (skip places > 25km before scoring) ──
  const MAX_DIST = 25000;
  const nearby = [];
  for (const p of allPlaces) {
    if (!p.lat || !p.lon) continue;
    const dist = haversine(lat, lon, p.lat, p.lon);
    if (dist <= MAX_DIST) nearby.push({ ...p, _dist: dist });
  }

  // ── 5. Scoring (only on nearby places) ──
  const sq = cleanQuery || qLow;
  const scored = [];
  for (const p of nearby) {
    let score = 0;
    const pName = (p.name || '').toLowerCase();
    const pCat = (p.category || '').toLowerCase();
    const pAddr = (p.address || '').toLowerCase();
    const pDesc = (p.description || '').toLowerCase();
    const pTags = ((p.tags || []).join(' ') + ' ' + (p.keywords || []).join(' ')).toLowerCase();

    // a) Fast name check first (skip fuzzy if exact/includes match)
    if (pName === sq) score += 200;
    else if (pName.includes(sq)) score += 160;
    else if (sq.includes(pName)) score += 120;
    else { const ns = fuzzyScore(sq, pName); if (ns > 0) score += ns * 2; }

    // b) Semantische Kategorie-Treffer
    if (matchCategories.length > 0) {
      if (matchCategories.includes(pCat)) score += 60;
      const pCuisine = (p.cuisine || '').toLowerCase();
      if (matchCategories.some(c => pCuisine.includes(c) || pTags.includes(c))) score += 40;
    }

    // c) Property-Match
    if (matchProp === 'outdoor_seating' && p.outdoor_seating) score += 50;
    if (matchProp === 'smoker' && p.smoker) score += 50;

    // d) Tag-Match
    if (matchTag && (pTags.includes(matchTag) || pDesc.includes(matchTag) || (p.liveMusic && matchTag === 'live-musik'))) score += 40;

    // e) Mood-Match
    if (matchMood === 'quiet' && /ruhig|gemütlich|chill|cozy|entspannt/i.test(pDesc)) score += 30;
    if (matchMood === 'loud' && /laut|wild|party|stimmung|action|voll/i.test(pDesc)) score += 30;

    // f) Stadtteil-Filter
    if (stadtteilFilter) {
      if (p.lat >= stadtteilFilter.latMin && p.lat <= stadtteilFilter.latMax &&
          p.lon >= stadtteilFilter.lonMin && p.lon <= stadtteilFilter.lonMax) {
        score += 40;
      } else {
        score -= 100;
      }
    }

    // g) Einzelwort-Suche (fast includes check)
    const searchText = `${pName} ${pCat} ${pAddr} ${pDesc} ${pTags}`;
    for (const w of remainingWords) {
      if (w.length >= 2 && searchText.includes(w)) score += 15;
    }

    // h) Address/description fuzzy only if score still low (lazy evaluation)
    if (score < 20 && cleanQuery) {
      score += fuzzyScore(cleanQuery, pAddr) * 0.5;
      score += fuzzyScore(cleanQuery, pDesc) * 0.3;
      score += fuzzyScore(cleanQuery, pTags) * 0.4;
    }

    // Distance penalty
    const distKm = p._dist / 1000;
    if (distKm > 5) score -= (distKm - 5) * 3;
    if (distKm > 15) score -= (distKm - 15) * 5;

    if (score > 10) scored.push({ ...p, _searchScore: score });
  }

  // ── 6. Sort by score, take top 30 for enrichment ──
  scored.sort((a, b) => b._searchScore - a._searchScore);
  const top = scored.slice(0, 30);

  // ── 7. Enrichment (only top candidates) ──
  const highlightSet = new Set(HIGHLIGHTS.map(h => (h.name || '').toLowerCase()));
  let results = top.map(p => {
    const isHL = highlightSet.has((p.name || '').toLowerCase());
    const vs = computeVibeScore(p, isHL);
    const bn = estimateBusyness(p, getHamburgTime().dow, getHamburgTime().hour);
    return {
      ...p,
      isOpen: isOpenSmart(p.opening_hours, p.category),
      openStatus: getOpenStatus(p),
      vibeScore: vs.vibe,
      vibeLabel: vs.vibeLabel,
      vibeEmoji: vs.vibeEmoji,
      hotScore: computeHotScore(p, isHL).score,
      communityScore: getCommunityScore(p.name) || null,
      estimatedBusyness: bn.busyness,
      busynessLabel: bn.busynessLabel,
      busynessColor: bn.busynessColor,
      peakInfo: getPeakInfo(p),
      newlyAdded: false,
    };
  });

  // ── 8. Final sort: Relevanz > isOpen > Entfernung ──
  results.sort((a, b) => {
    const scoreDiff = b._searchScore - a._searchScore;
    if (Math.abs(scoreDiff) > 20) return scoreDiff;
    const aOpen = a.isOpen === true ? 1 : 0;
    const bOpen = b.isOpen === true ? 1 : 0;
    if (aOpen !== bOpen) return bOpen - aOpen;
    return (a._dist || 99999) - (b._dist || 99999);
  });

  return results.slice(0, 20);
}

// Overpass-Suche nach Name für Auto-Nachladen
async function overpassSearchByName(searchTerm, lat, lon) {
  if (!searchTerm || searchTerm.length < 2) return [];
  const now = Date.now();
  if (now - lastOverpassRequest < MIN_REQUEST_INTERVAL) return [];
  lastOverpassRequest = now;

  // Suche im Hamburger Raum nach name~"suchbegriff"
  const escaped = searchTerm.replace(/"/g, '\\"');
  const query = `[out:json][timeout:15];
(
  node["amenity"~"bar|pub|cafe|nightclub|biergarten"]["name"~"${escaped}",i](53.4,9.7,53.7,10.3);
  way["amenity"~"bar|pub|cafe|nightclub|biergarten"]["name"~"${escaped}",i](53.4,9.7,53.7,10.3);
);
out center body;`;

  const result = await fetchOverpass(query);
  return (result.elements || [])
    .filter(e => e.tags?.name)
    .map(e => ({
      id: e.id,
      name: e.tags.name,
      lat: e.lat || e.center?.lat,
      lon: e.lon || e.center?.lon,
      category: CATEGORY_OVERRIDES[(e.tags?.name || '').toLowerCase()] ||
                (/irish/i.test(e.tags?.name || '') ? 'irish-pub' : (e.tags?.amenity || 'bar')),
      address: [e.tags?.['addr:street'], e.tags?.['addr:housenumber']].filter(Boolean).join(' ') || '',
      opening_hours: e.tags?.opening_hours || '',
      website: e.tags?.website || e.tags?.['contact:website'] || '',
      phone: e.tags?.phone || e.tags?.['contact:phone'] || '',
      cuisine: e.tags?.cuisine || '',
      outdoor_seating: e.tags?.outdoor_seating === 'yes',
      smoker: e.tags?.smoking === 'yes' || e.tags?.smoking === 'isolated',
    }));
}

// ═══════════════════════════════════════════════════════════════
// 🕐 VERIFIED HOURS SYSTEM (cached data only, no scraping)
// ═══════════════════════════════════════════════════════════════
let verifiedHoursCache = {};
const VERIFIED_HOURS_FILE = path.join(__dirname, 'verified_hours.json');
try {
  if (fs.existsSync(VERIFIED_HOURS_FILE)) {
    verifiedHoursCache = JSON.parse(fs.readFileSync(VERIFIED_HOURS_FILE, 'utf8'));
    console.log(`✅ Verified hours loaded: ${Object.keys(verifiedHoursCache).length} locations`);
  }
} catch(e) { console.log('⚠️ Verified hours cache not available'); }

// Google hours scraping removed - using only database and OSM data

// Get verified hours for a place (returns null if not verified)
function getVerifiedHours(placeName) {
  if (!placeName) return null;
  const entry = verifiedHoursCache[placeName.toLowerCase()];
  if (!entry) return null;
  // Only use if less than 7 days old
  const age = Date.now() - new Date(entry.scrapedAt).getTime();
  if (age > 7 * 24 * 60 * 60 * 1000) return null;
  return entry;
}

// Nightly verification disabled (no Google scraping)
console.log('🕐 Nightly hours verification disabled (no scraping)');

// Weekly OSM Ground Truth Sync — run every Monday at 05:00 CET:
// crontab: 0 4 * * 1 cd /home/openclaw/.openclaw/workspace/barfinder && python3 overpass_sync.py >> logs/osm_sync.log 2>&1 && sudo systemctl restart barfinder-server

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // ═══ RATE LIMITING (only for /api/ routes) ═══
  if (url.pathname.startsWith('/api/')) {
    const rl = checkRateLimit(req);
    res.setHeader('X-RateLimit-Limit', RATE_LIMIT_MAX);
    res.setHeader('X-RateLimit-Remaining', rl.remaining);
    res.setHeader('X-RateLimit-Reset', Math.ceil(rl.resetAt / 1000));
    if (!rl.allowed) {
      return sendError(req, res, 429, 'Too many requests. Max 60 per minute.');
    }
  }

  // ═══ BLOCK SENSITIVE FILES ═══
  const blockedExtensions = ['.db', '.db-shm', '.db-wal', '.env', '.log', '.sh', '.py'];
  const blockedPaths = ['/barfinder_config.json', '/events_config.json', '/package.json', '/package-lock.json',
    '/highlights.json', '/user_data/', '/node_modules/', '/.env', '/db.js', '/server.js',
    '/cache.json', '/logs/', '/.git/', '/verify_places.js', '/verify_state.json', '/verify_log.json',
    '/stadtteil_index.json', '/barfinder.db', '/backup-db.sh', '/VIBE_SCORE_METRIK.md'];
  const pn = url.pathname.toLowerCase();
  if (blockedExtensions.some(ext => pn.endsWith(ext)) || blockedPaths.some(bp => pn === bp || pn.startsWith(bp))) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  // ═══ SECURITY HEADERS FOR ALL RESPONSES ═══
  setSecurityHeaders(req, res);

  // ═══ STATIC FILES ═══
  if (url.pathname === '/' || url.pathname === '/index.html' || url.pathname.startsWith('/v')) {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache', 'Expires': '0',
      'ETag': Date.now().toString()
    });
    fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);
    return;
  }

  // ═══ STATIC FILES (/static/) ═══
  if (url.pathname.startsWith('/static/')) {
    const safePath = path.normalize(url.pathname).replace(/^(\.\.(\/|\\|$))+/, '');
    if (safePath !== url.pathname) { res.writeHead(403); res.end('Forbidden'); return; }
    const filePath = path.join(__dirname, safePath);
    // Ensure file is within static/ directory
    if (!filePath.startsWith(path.join(__dirname, 'static'))) { res.writeHead(403); res.end('Forbidden'); return; }
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = { '.css': 'text/css', '.js': 'application/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.eot': 'application/vnd.ms-fontobject' };
    const mime = mimeTypes[ext] || 'application/octet-stream';
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=31536000, immutable' });
      fs.createReadStream(filePath).pipe(res);
    } else {
      res.writeHead(404); res.end('Not found');
    }
    return;
  }

  // ═══ ENHANCED HEALTH ENDPOINT ═══
  if (url.pathname === '/api/health' && req.method === 'GET') {
    try {
      const uptimeMs = Date.now() - SERVER_START_TIME;
      const uptimeSec = Math.floor(uptimeMs / 1000);
      const cacheFiles = [
        'yelp_cache.json', 'yelp_reviews_cache.json',
        'events_pipeline_cache.json', 'eventbrite_events_cache.json',
        'network_events_cache.json', 'rural_events_cache.json'
      ];
      const cacheStatus = {};
      for (const f of cacheFiles) {
        try {
          const stat = fs.statSync(path.join(__dirname, f));
          cacheStatus[f] = { exists: true, lastModified: stat.mtime.toISOString(), sizeKB: Math.round(stat.size / 1024) };
        } catch { cacheStatus[f] = { exists: false }; }
      }

      let dbHealth = null;
      try { dbHealth = barfinderDB.getHealth(); } catch {}

      return sendJSON(req, res, 200, {
        status: 'ok',
        uptime: { seconds: uptimeSec, human: `${Math.floor(uptimeSec/3600)}h ${Math.floor((uptimeSec%3600)/60)}m ${uptimeSec%60}s` },
        highlights: HIGHLIGHTS.length,
        overpassCacheKeys: Object.keys(cache).length,
        weatherCacheAge: weatherCache.fetchedAt ? Math.round((Date.now() - weatherCache.fetchedAt) / 1000) + 's ago' : 'never',
        communityScores: Object.keys(communityScoreCache).length,
        rateLimitStoreSize: rateLimitStore.size,
        cacheFiles: cacheStatus,
        database: dbHealth,
        memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
        nodeVersion: process.version,
        timestamp: new Date().toISOString()
      }, 'no-store');
    } catch (e) {
      return sendError(req, res, 500, 'Health check failed: ' + e.message);
    }
  }

  // ═══ REVERSE GEOCODING — GPS coords to address ═══
  if (url.pathname === '/api/reverse-geocode' && req.method === 'GET') {
    const lat = parseFloat(url.searchParams.get('lat'));
    const lon = parseFloat(url.searchParams.get('lon'));
    if (!lat || !lon) return sendError(req, res, 400, 'lat and lon required');
    try {
      const result = await new Promise((resolve, reject) => {
        const geoUrl = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&zoom=18&addressdetails=1`;
        https.get(geoUrl, { headers: { 'User-Agent': 'Barfinder/1.0' } }, geoRes => {
          let body = '';
          geoRes.on('data', c => body += c);
          geoRes.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { reject(e); } });
        }).on('error', reject);
      });
      const addr = result.address || {};
      const road = addr.road || addr.pedestrian || addr.footway || '';
      const houseNumber = addr.house_number || '';
      const suburb = addr.suburb || addr.neighbourhood || addr.city_district || '';
      const city = addr.city || addr.town || addr.village || 'Hamburg';
      let display = '';
      if (road) {
        display = road + (houseNumber ? ' ' + houseNumber : '');
        if (suburb) display += ', ' + suburb;
      } else if (suburb) {
        display = suburb + ', ' + city;
      } else {
        display = city;
      }
      return sendJSON(req, res, 200, { display, road, houseNumber, suburb, city, lat, lon }, 'max-age=3600');
    } catch(e) {
      return sendError(req, res, 500, 'Reverse geocoding failed');
    }
  }

  // ═══ FORWARD GEOCODING / LOCATION SEARCH ═══
  // ═══ NOMINATIM CACHE (in-memory, 24h TTL, max 500 entries) ═══
  if (!global._nominatimCache) global._nominatimCache = new Map();
  const NOMINATIM_CACHE_TTL = 24 * 60 * 60 * 1000;
  const NOMINATIM_CACHE_MAX = 500;

  if (url.pathname === '/api/location-search' && req.method === 'GET') {
    const q = (url.searchParams.get('q') || '').trim();
    if (!q || q.length < 1) return sendJSON(req, res, 200, { results: [] });

    // Check cache first
    const cacheKey = q.toLowerCase().trim();
    const cached = global._nominatimCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < NOMINATIM_CACHE_TTL) {
      return sendJSON(req, res, 200, { results: cached.data }, 'max-age=300');
    }

    try {
      const fetchNominatim = (query, viewbox) => new Promise((resolve, reject) => {
        const enc = encodeURIComponent(query);
        const vb = viewbox ? '&viewbox=9.7,53.4,10.3,53.7&bounded=1' : '';
        const geoUrl = `https://nominatim.openstreetmap.org/search?q=${enc}&format=json&limit=6&addressdetails=1&countrycodes=de${vb}`;
        https.get(geoUrl, { headers: { 'User-Agent': 'Barfinder/1.0' } }, geoRes => {
          let body = '';
          geoRes.on('data', c => body += c);
          geoRes.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { resolve([]); } });
        }).on('error', () => resolve([]));
      });

      // German street name normalization for typo tolerance
      function normalizeStreetQuery(input) {
        let s = input;
        // Common German street typos/abbreviations
        s = s.replace(/\bstr\b\.?/gi, 'Straße');
        s = s.replace(/\bstrasse\b/gi, 'Straße');
        s = s.replace(/\bstarsse\b/gi, 'Straße');
        s = s.replace(/\bstarse\b/gi, 'Straße');
        s = s.replace(/\bstraase\b/gi, 'Straße');
        s = s.replace(/\bstrasee\b/gi, 'Straße');
        s = s.replace(/\bstrsse\b/gi, 'Straße');
        s = s.replace(/\bstraße\b/gi, 'Straße');
        s = s.replace(/ss(?=e\b)/g, 'ß'); // "sse" → "ße" (common)
        s = s.replace(/\bpl\b\.?/gi, 'Platz');
        s = s.replace(/\bw\b\.?/gi, 'Weg');
        return s;
      }

      async function searchWithFallbacks(query) {
        // 1. Exact query in Hamburg viewbox
        let result = await fetchNominatim(query, true);
        if (result && result.length > 0) return result;
        // 2. With "Hamburg" appended
        result = await fetchNominatim(query + ' Hamburg', false);
        if (result && result.length > 0) return result;
        // 3. Without bounds
        result = await fetchNominatim(query, false);
        return result || [];
      }

      let result = await searchWithFallbacks(q);

      // If no results, try normalized version (typo correction)
      if (result.length === 0) {
        const normalized = normalizeStreetQuery(q);
        if (normalized !== q) {
          result = await searchWithFallbacks(normalized);
        }
      }

      // If still no results, try without house number (search street first)
      if (result.length === 0) {
        const withoutNum = q.replace(/\s+\d+[a-zA-Z]?\s*$/, '').trim();
        if (withoutNum !== q && withoutNum.length >= 3) {
          const normalizedWithout = normalizeStreetQuery(withoutNum);
          result = await searchWithFallbacks(normalizedWithout);
        }
      }
      
      const results = (result || []).map(d => {
        const parts = d.display_name.split(',');
        const addr = d.address || {};
        const road = addr.road || '';
        const houseNr = addr.house_number || '';
        const main = (road && houseNr) ? `${road} ${houseNr}` : road || parts[0].trim();
        const suburb = addr.suburb || addr.city_district || '';
        const sub = suburb ? suburb + (addr.city ? ', ' + addr.city : '') : parts.slice(1, 3).join(',').trim();
        return { lat: parseFloat(d.lat), lon: parseFloat(d.lon), main, sub };
      });
      // Cache results
      if (results.length > 0) {
        if (global._nominatimCache.size >= NOMINATIM_CACHE_MAX) {
          const oldest = global._nominatimCache.keys().next().value;
          global._nominatimCache.delete(oldest);
        }
        global._nominatimCache.set(cacheKey, { data: results, ts: Date.now() });
      }
      return sendJSON(req, res, 200, { results }, 'max-age=300');
    } catch(e) {
      return sendError(req, res, 500, 'Location search failed');
    }
  }

  if (url.pathname === '/api/places') {
    const lat = parseFloat(url.searchParams.get('lat')) || config.DEFAULT_LAT;
    const lon = parseFloat(url.searchParams.get('lon')) || config.DEFAULT_LON;
    const radius = parseInt(url.searchParams.get('radius')) || 5000;
    const category = url.searchParams.get('category') || 'all';
    const dayOffset = parseInt(url.searchParams.get('day')) || 0; // 0=today, 1=tomorrow, etc.
    try {
      // Get current vibe context for dynamic scoring
      const vibeContext = getCurrentVibeContext();
      // If user selected a different day, override dow
      if (dayOffset > 0) {
        vibeContext.dow = (vibeContext.dow + dayOffset) % 7;
      }
      
      // ═══ VIBE SCORE CACHE: reuse computed places for 5 min ═══
      const vibeCacheKey = `${lat.toFixed(3)}_${lon.toFixed(3)}_${radius}_${category}_${dayOffset}`;
      const now = Date.now();
      let places;
      if (vibeScoreCache.key === vibeCacheKey && (now - vibeScoreCache.timestamp) < VIBE_CACHE_TTL) {
        places = vibeScoreCache.data.map(p => ({ ...p })); // shallow clone
      } else {
      // Own DB only — no Overpass dependency
      places = [];
      HIGHLIGHTS.forEach(h => {
        if (!h.lat || !h.lon) return;
        const dist = haversine(lat, lon, h.lat, h.lon);
        if (dist > radius) return;
        if (category !== 'all') {
          if (category === 'livemusik' || category === 'live-musik') {
            if (!h.liveMusic && !((h.tags||[]).join(' ')+(h.keywords||[]).join(' ')).toLowerCase().includes('live')) return;
          } else if (h.category !== category) return;
        }
        
        const hs = computeHotScore(h, true);
        const rm = fuzzyMatchRating(h.name);
        const bn = estimateBusyness(h, getHamburgTime().dow, getHamburgTime().hour);
        const vh = getVerifiedHours(h.name);
        const effectiveHours = (vh && vh.opening_hours) ? vh.opening_hours : h.opening_hours;
        
        // Calculate dynamic vibe score
        const dynamicVibe = calculateDynamicVibe(h, vibeContext);
        
        // Check if location has events today (for more accurate context)
        const placeKey = (h.name || '').toLowerCase().replace(/[^a-z0-9]/g, '_');
        const todayEvents = getTodaysEvents(placeKey, vibeContext.dow, vibeContext.hour);
        const hasPlaceEventToday = todayEvents.length > 0;
        
        // Update context for this specific place
        const placeContext = {
          ...vibeContext,
          hasEventToday: hasPlaceEventToday || vibeContext.hasEventToday
        };
        
        // Recalculate with place-specific context
        const finalDynamicVibe = calculateDynamicVibe(h, placeContext);
        
        // Determine if "Jetzt perfekt" indicator should show
        const isNowPerfect = finalDynamicVibe.dynamicVibeScore > 70 && isOpenSmart(effectiveHours, h.category) === true;
        
        places.push({ 
          ...h, 
          opening_hours: effectiveHours, 
          _dist: dist, 
          isOpen: isOpenSmart(effectiveHours, h.category), 
          openStatus: getOpenStatus({ ...h, opening_hours: effectiveHours }), 
          hotScore: hs.score,
          
          // Dynamic Vibe Score (new)
          vibeScore: dayOffset > 0 ? finalDynamicVibe.vibePeak : finalDynamicVibe.dynamicVibeScore,
          baseVibeScore: finalDynamicVibe.baseVibeScore, // Keep static as reference
          vibeReason: finalDynamicVibe.vibeReason,
          vibePeak: finalDynamicVibe.vibePeak,
          vibePeakHour: finalDynamicVibe.vibePeakHour,
          vibeTrend: dayOffset > 0 ? null : finalDynamicVibe.vibeTrend,
          isNowPerfect: dayOffset > 0 ? false : isNowPerfect,
          vibeFactors: finalDynamicVibe.factors,
          neighborhood: finalDynamicVibe.neighborhood,
          
          // Legacy vibe data for backward compatibility
          vibeLabel: getVibeLabel(finalDynamicVibe.dynamicVibeScore),
          vibeEmoji: getVibeEmoji(finalDynamicVibe.dynamicVibeScore),
          
          has_events: hs.has_events || hasPlaceEventToday, 
          communityScore: getCommunityScore(h.name) || null, 
          estimatedBusyness: bn.busyness, 
          busynessLabel: bn.busynessLabel, 
          busynessColor: bn.busynessColor, 
          peakInfo: getPeakInfo(h), 
          hoursVerified: !!vh, 
          hoursSource: vh ? 'cached' : 'original' 
        });
      });
      
      // Sort by requested field (default: vibe DESC)
      const sortParam = url.searchParams.get('sort') || 'vibe';
      if (sortParam === 'vibe') {
        places.sort((a, b) => (b.vibeScore || 0) - (a.vibeScore || 0));
      } else if (sortParam === 'distance') {
        places.sort((a, b) => (a._dist || 0) - (b._dist || 0));
      } else if (sortParam === 'hot') {
        places.sort((a, b) => (b.hotScore || 0) - (a.hotScore || 0));
      } else {
        places.sort((a, b) => (b.vibeScore || 0) - (a.vibeScore || 0));
      }
      
      // Store in vibe cache
      vibeScoreCache.data = places.map(p => ({ ...p }));
      vibeScoreCache.key = vibeCacheKey;
      vibeScoreCache.timestamp = Date.now();
      } // end of cache miss block
      
      // City-wide vibe summary
      const openPlaces = places.filter(p => p.isOpen === true || p.isOpen === 'likely');
      // City vibe: only count bar-like venues (not cafes/restaurants that drag down average)
      const barCats = new Set(['bar','pub','cocktailbar','wine','irish-pub','nightclub','biergarten','lounge','sports_bar','brewery']);
      const vibeRelevant = openPlaces.filter(p => barCats.has(p.category) && (p.vibeScore || 0) > 0);
      const avgVibe = vibeRelevant.length > 0 ? Math.round(vibeRelevant.reduce((s, p) => s + (p.vibeScore || 0), 0) / vibeRelevant.length) : 0;
      const topPeak = places.reduce((best, p) => (p.vibePeak || 0) > (best.vibePeak || 0) ? p : best, places[0] || {});
      const { hour: currentHour } = getHamburgTime();
      const trendArrows = { up: '\u2191', slightly_up: '\u2197', stable: '\u2192', slightly_down: '\u2198', down: '\u2193' };
      // Majority trend
      const trendCounts = { up: 0, slightly_up: 0, stable: 0, slightly_down: 0, down: 0 };
      openPlaces.forEach(p => { if (p.vibeTrend) trendCounts[p.vibeTrend]++; });
      const cityTrend = Object.entries(trendCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'stable';

      const isFuture = dayOffset > 0;

      // Stadtteil-Vibe: Durchschnitt der offenen Bars im Stadtteil des Nutzers
      const userStadtteil = getStadtteilForPlace({ lat, lon });
      let stadtteilVibe = null;
      if (userStadtteil && !isFuture) {
        const stadtteilBars = vibeRelevant.filter(p => {
          const pSt = getStadtteilForPlace(p);
          return pSt === userStadtteil;
        });
        if (stadtteilBars.length >= 2) {
          const stAvg = Math.round(stadtteilBars.reduce((s, p) => s + (p.vibeScore || 0), 0) / stadtteilBars.length);
          const stTrendCounts = { up: 0, slightly_up: 0, stable: 0, slightly_down: 0, down: 0 };
          stadtteilBars.forEach(p => { if (p.vibeTrend) stTrendCounts[p.vibeTrend]++; });
          const stTrend = Object.entries(stTrendCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'stable';
          const stName = Object.entries(STADTTEIL_INDEX).find(([k, v]) => v === userStadtteil)?.[0] || '';
          stadtteilVibe = {
            vibeNow: stAvg,
            vibeTrend: stTrend,
            vibeTrendArrow: trendArrows[stTrend] || '\u2192',
            name: stName.charAt(0).toUpperCase() + stName.slice(1),
            barCount: stadtteilBars.length,
            nightlifeScore: userStadtteil.nightlifeScore || 0,
            vibe: userStadtteil.vibe || ''
          };
        }
      }

      const cityVibe = {
        vibeNow: isFuture ? null : avgVibe,
        vibePeak: topPeak?.vibePeak || 0,
        vibePeakHour: topPeak?.vibePeakHour || 22,
        vibeTrend: isFuture ? null : cityTrend,
        vibeTrendArrow: isFuture ? '' : (trendArrows[cityTrend] || '\u2192'),
        vibeLabel: isFuture ? 'Potenzial' : 'Stadt-Vibe',
        isFuture,
        openCount: openPlaces.length,
        currentHour,
        stadtteil: stadtteilVibe
      };

      // Deduplicate tags: remove tags that match category, and normalize duplicates
      places.forEach(p => {
        if (!p.tags || !Array.isArray(p.tags)) return;
        const cat = (p.category || '').toLowerCase().replace(/[-_]/g, '');
        const seen = new Set();
        p.tags = p.tags.filter(t => {
          if (!t || typeof t !== 'string') return false;
          const norm = t.toLowerCase().replace(/[-_]/g, '');
          if (norm === cat) return false;
          if (cat.includes(norm) || norm.includes(cat)) return false;
          if (['bar', 'pub', 'club', 'cafe', 'restaurant', 'curated', 'hamburg', 'nightlife'].includes(norm)) return false;
          if (seen.has(norm)) return false;
          seen.add(norm);
          return true;
        });
      });

      // ═══ BBOX FILTERING (viewport-based loading) ═══
      const bboxNorth = parseFloat(url.searchParams.get('north'));
      const bboxSouth = parseFloat(url.searchParams.get('south'));
      const bboxEast = parseFloat(url.searchParams.get('east'));
      const bboxWest = parseFloat(url.searchParams.get('west'));
      const hasBbox = !isNaN(bboxNorth) && !isNaN(bboxSouth) && !isNaN(bboxEast) && !isNaN(bboxWest);
      
      if (hasBbox) {
        places = places.filter(p => p.lat >= bboxSouth && p.lat <= bboxNorth && p.lon >= bboxWest && p.lon <= bboxEast);
      }

      const total = places.length;

      // ═══ PAGINATION ═══
      const limit = parseInt(url.searchParams.get('limit')) || 100;
      const offset = parseInt(url.searchParams.get('offset')) || 0;
      const paginatedPlaces = places.slice(offset, offset + limit);

      // ═══ FIELD PROJECTION ═══
      const fieldsParam = url.searchParams.get('fields');
      let outputPlaces;
      if (fieldsParam === 'full') {
        outputPlaces = paginatedPlaces;
      } else if (fieldsParam) {
        const requestedFields = fieldsParam.split(',');
        outputPlaces = paginatedPlaces.map(p => {
          const o = {};
          for (const f of requestedFields) { if (f in p) o[f] = p[f]; }
          return o;
        });
      } else {
        // Default: list fields (lightweight)
        outputPlaces = paginatedPlaces.map(p => {
          const o = {};
          for (const f of LIST_FIELDS) { if (f in p) o[f] = p[f]; }
          return o;
        });
      }

      sendJSON(req, res, 200, { count: outputPlaces.length, total, limit, offset, places: outputPlaces, cityVibe }, 'public, max-age=30');
    } catch(e) {
      sendError(req, res, e.message.includes('Rate limited') ? 429 : 500, e.message);
    }
    return;
  }

  if (url.pathname === '/api/hot') {
    const lat = parseFloat(url.searchParams.get('lat')) || config.DEFAULT_LAT;
    const lon = parseFloat(url.searchParams.get('lon')) || config.DEFAULT_LON;
    const radius = parseInt(url.searchParams.get('radius')) || 5000;
    try {
      const hot = await getHotLocations(lat, lon, radius);
      sendJSON(req, res, 200, hot, 'public, max-age=30');
    } catch(e) {
      sendError(req, res, 500, e.message);
    }
    return;
  }

  if (url.pathname === '/api/hotscore') {
    const name = url.searchParams.get('name');
    const h = HIGHLIGHTS.find(x => x.name.toLowerCase() === (name || '').toLowerCase());
    if (h) {
      const hs = computeHotScore(h, true);
      const heatmap = computeWeeklyHeatmap(h, true);
      const peak = computePeakHours(h);
      sendJSON(req, res, 200, { ...hs, heatmap: heatmap.heatmap, days: heatmap.days, peak }, 'public, max-age=60');
    } else {
      sendError(req, res, 404, 'Not found');
    }
    return;
  }

  if (url.pathname === '/api/highlights') {
    const enriched = HIGHLIGHTS.map(h => {
      const vs = computeVibeScore(h, true);
      return {
        ...h,
        isOpen: isOpenSmart(h.opening_hours, h.category), openStatus: getOpenStatus(h),
        hotScore: computeHotScore(h).score || 0,
        vibeScore: vs.vibe, vibeLabel: vs.vibeLabel, vibeEmoji: vs.vibeEmoji
      };
    });
    sendJSON(req, res, 200, { count: enriched.length, highlights: enriched }, 'public, max-age=60');
    return;
  }

  if (url.pathname === '/api/events') {
    try {
      const allEnriched = getNetworkEvents();
      const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Berlin' }));
      const todayStr = now.toISOString().split('T')[0];
      const todayEvents = allEnriched.filter(e => {
        if (!e.date) return false;
        const d = e.date.substring(0, 10);
        return d === todayStr;
      });
      // Also include afterwork events for the afterwork tab
      const afterworkEvents = allEnriched.filter(e => {
        const text = ((e.title || '') + ' ' + (e.description || '') + ' ' + (e.category || '') + ' ' + (e.type || '')).toLowerCase();
        return /after.?work|feierabend|aperitivo|sundowner/i.test(text);
      });
      sendJSON(req, res, 200, { today: todayEvents, all: allEnriched, afterwork: afterworkEvents }, 'public, max-age=120');
    } catch (e) { sendError(req, res, 500, e.message); }
    return;
  }

  if (url.pathname === '/api/network-events') {
    try {
      const networkEvents = getNetworkEvents();
      sendJSON(req, res, 200, { events: networkEvents }, 'public, max-age=120');
    } catch (e) { sendError(req, res, 500, e.message); }
    return;
  }

  // Debug: category distribution endpoint
  if (url.pathname === '/api/debug-categories') {
    const lat = parseFloat(url.searchParams.get('lat')) || config.DEFAULT_LAT;
    const lon = parseFloat(url.searchParams.get('lon')) || config.DEFAULT_LON;
    const radius = parseInt(url.searchParams.get('radius')) || 3000;
    const cats = {};
    HIGHLIGHTS.forEach(h => {
      const dist = haversine(lat, lon, h.lat, h.lon);
      if (dist <= radius) {
        cats[h.category] = (cats[h.category]||0)+1;
      }
    });
    sendJSON(req, res, 200, { totalHighlights: HIGHLIGHTS.length, inRadius: Object.values(cats).reduce((a,b)=>a+b,0), categories: cats, radius }, 'no-cache');
    return;
  }

  if (url.pathname === '/api/sources') {
    const stat = (f) => { try { return fs.statSync(f).mtime.toISOString(); } catch(e) { return null; } };
    const count = (f) => { try { const d=JSON.parse(fs.readFileSync(f,'utf8')); return Array.isArray(d)?d.length:Object.values(d).flat().length; } catch(e) { return 0; } };
    const base = __dirname + '/';
    const sources = [
      { name:'Eigene Datenbank', icon:'🗄️', description:'Kuratierte Locations aus Sonnet-Recherche, OSM, Web-Suche — vollständig kontrolliert', priority:1, status:'ok', statusText:'Aktiv', count: HIGHLIGHTS.length, lastRun: stat(base+'highlights.json') },
      { name:'Curated Highlights', icon:'⭐', description:'Manuell gepflegte Top-Locations mit Details, Öffnungszeiten, Smoker-Info', priority:1, status:'ok', statusText:'Aktiv', count: HIGHLIGHTS.length, lastRun: stat(base+'server.js') },
      { name:'Luma Events', icon:'🤝', description:'Network & Community Events aus lu.ma/hamburg', priority:2, status: stat(base+'network_events_cache.json')?'ok':'error', statusText: stat(base+'network_events_cache.json')?'Cache aktuell':'Kein Cache', count: count(base+'network_events_cache.json'), lastRun: stat(base+'network_events_cache.json') },
      { name:'Bar Events (Aalhaus etc.)', icon:'🍺', description:'Events von Bar-Websites (DJ, Quiz, Fußball, Specials)', priority:2, status: stat(base+'bar_events_cache.json')?'ok':'error', statusText: stat(base+'bar_events_cache.json')?'Cache aktuell':'Kein Cache', count: count(base+'bar_events_cache.json'), lastRun: stat(base+'bar_events_cache.json') },
      { name:'Community Score (eigene Metrik)', icon:'📊', description:'Eigene Bewertungsmetrik basierend auf Qualitaet und Beliebtheit (0-100)', priority:3, status: Object.keys(communityScoreCache).length > 0 ? 'ok' : 'pending', statusText: Object.keys(communityScoreCache).length + ' Bars bewertet', count: Object.keys(communityScoreCache).length, lastRun: null },
      { name:'Event Pipeline (RSS+Tourism)', icon:'📡', description:'Abendblatt, Hamburg Tourism, Meetup - RSS & HTML Scraper', priority:2, status: stat(base+'events_pipeline_cache.json')?'ok':'error', statusText: stat(base+'events_pipeline_cache.json')?'Cache aktuell':'Kein Cache', count: count(base+'events_pipeline_cache.json'), lastRun: stat(base+'events_pipeline_cache.json') },
      { name:'Eventbrite', icon:'🎫', description:'After-Work, Networking, Social, Startup Events via smry.ai Proxy', priority:2, status: stat(base+'eventbrite_events_cache.json')?'ok':'error', statusText: stat(base+'eventbrite_events_cache.json')?'Cache aktuell':'Kein Cache', count: count(base+'eventbrite_events_cache.json'), lastRun: stat(base+'eventbrite_events_cache.json') },
      { name:'Startup City Hamburg', icon:'🏙️', description:'Startup-Events, Founder Meetups, Innovation aus startupcity.hamburg', priority:1, status: stat(base+'new_sources_events_cache.json')?'ok':'error', statusText: stat(base+'new_sources_events_cache.json')?'Cache aktuell':'Kein Cache', count: count(base+'new_sources_events_cache.json'), lastRun: stat(base+'new_sources_events_cache.json') },
      { name:'Facebook Events', icon:'📘', description:'Bar- & Nightlife-Events von Facebook Pages', priority:3, status: stat(base+'facebook_events_cache.json')?'partial':'error', statusText: stat(base+'facebook_events_cache.json')?'Teilweise':'Geblockt', count: count(base+'facebook_events_cache.json'), lastRun: stat(base+'facebook_events_cache.json'), error:'Login-Wall blockiert öffentliche Events' },
      { name:'szene-hamburg.de', icon:'📰', description:'Hamburger Stadtmagazin — Bars & Events', priority:3, status: stat(base+'hamburg_events_cache.json')?'ok':'pending', statusText: stat(base+'hamburg_events_cache.json')?'Cache vorhanden':'In Entwicklung', count: count(base+'hamburg_events_cache.json'), lastRun: stat(base+'hamburg_events_cache.json') },
      { name:'Yelp Hamburg', icon:'⭐', description:'Ratings, Reviews & Kategorien via smry.ai Proxy', priority:4, status: (stat(base+'yelp_reviews_cache.json')||stat(base+'yelp_cache.json'))?'ok':'pending', statusText: stat(base+'yelp_reviews_cache.json')?'Reviews Cache aktuell':stat(base+'yelp_cache.json')?'Legacy Cache':'Kein Cache', count: yelpReviewsCache.length || count(base+'yelp_cache.json'), lastRun: stat(base+'yelp_reviews_cache.json')||stat(base+'yelp_cache.json') },
      { name:'Mit Vergnügen Hamburg', icon:'🎉', description:'Kuratierte Bar-Tipps, Events & Empfehlungen via smry.ai Proxy', priority:2, status: stat(base+'mitvergnuegen_cache.json')?'ok':'pending', statusText: stat(base+'mitvergnuegen_cache.json')?'Cache aktuell':'Kein Cache', count: count(base+'mitvergnuegen_cache.json'), lastRun: stat(base+'mitvergnuegen_cache.json') },
      { name:'OpenTable Hamburg', icon:'🍽️', description:'Restaurant/Bar-Ratings & Bewertungen via smry.ai Proxy', priority:4, status: stat(base+'opentable_cache.json')?'ok':'pending', statusText: stat(base+'opentable_cache.json')?'Cache aktuell':'Kein Cache', count: count(base+'opentable_cache.json'), lastRun: stat(base+'opentable_cache.json') },
      { name:'Hamburg Digital Ecosystem', icon:'🏢', description:'Startup & Digital Events aus hamburg-startups.net, hamburg-business.com', priority:2, status: stat(base+'hamburgwork_events_cache.json')?'ok':'error', statusText: stat(base+'hamburgwork_events_cache.json')?'Cache aktuell':'Kein Cache', count: count(base+'hamburgwork_events_cache.json'), lastRun: stat(base+'hamburgwork_events_cache.json') },
      { name:'Rural Events (Lentföhrden/Umkreis)', icon:'🏡', description:'Dorffeste, Osterfeuer, Stoppelfeeten, Wolters Gasthof Events', priority:2, status: stat(base+'rural_events_cache.json')?'ok':'pending', statusText: stat(base+'rural_events_cache.json')?'Cache aktuell':'Kein Cache', count: (ruralEventsCache.events||[]).length, lastRun: stat(base+'rural_events_cache.json') },
      { name:'Foursquare Places', icon:'📍', description:'Kategorisierung & Check-in Daten', priority:4, status:'pending', statusText:'Geplant', count:0, lastRun:null, error:'API-Key benötigt' },
    ];
    sendJSON(req, res, 200, { sources, lastCron: stat(base+'daily_scraper_cron.sh'), cronSchedule: 'Täglich 06:00 CET' }, 'public, max-age=300');
    return;
  }

  if (url.pathname === '/api/weather') {
    const active = getActiveMajorEvents();
    const current = weatherCache.current;
    let weatherText = '';
    let weatherEmoji = '🌡️';
    if (current) {
      const code = current.weathercode;
      const temp = current.temperature;
      if (code >= 95) { weatherEmoji = '⛈️'; weatherText = `Gewitter, ${temp}°C`; }
      else if (code >= 80) { weatherEmoji = '🌧️'; weatherText = `Schauer, ${temp}°C`; }
      else if (code >= 71) { weatherEmoji = '🌨️'; weatherText = `Schnee, ${temp}°C`; }
      else if (code >= 61) { weatherEmoji = '🌧️'; weatherText = `Regen, ${temp}°C`; }
      else if (code >= 51) { weatherEmoji = '🌦️'; weatherText = `Niesel, ${temp}°C`; }
      else if (code >= 45) { weatherEmoji = '🌫️'; weatherText = `Nebel, ${temp}°C`; }
      else if (code >= 3) { weatherEmoji = '☁️'; weatherText = `Bewölkt, ${temp}°C`; }
      else if (code >= 1) { weatherEmoji = '⛅'; weatherText = `Leicht bewölkt, ${temp}°C`; }
      else { weatherEmoji = '☀️'; weatherText = `Klar, ${temp}°C`; }

      // Bar tip
      if (code >= 51 && temp < 15) weatherText += ' — Ab in die Bar!';
      else if (code < 3 && temp >= 20) weatherText += ' — Perfekt für Biergarten!';
      else if (temp < 0) weatherText += ' — Brrr, ab ins Warme!';
    }
    sendJSON(req, res, 200, {
      weather: current, weatherText, weatherEmoji,
      majorEvents: active.map(e => ({ name: e.name, boost: e.boost })),
      fetchedAt: weatherCache.fetchedAt
    }, 'public, max-age=300');
    return;
  }

  // ═══ WEATHER DETAIL (hourly forecast) ═══
  if (url.pathname === '/api/weather/detail') {
    const current = weatherCache.current;
    const hourly = weatherCache.hourly;
    const codeToEmoji = c => {
      if (c >= 95) return '⛈️';
      if (c >= 80) return '🌧️';
      if (c >= 71) return '🌨️';
      if (c >= 61) return '🌧️';
      if (c >= 51) return '🌦️';
      if (c >= 45) return '🌫️';
      if (c >= 3) return '☁️';
      if (c >= 1) return '⛅';
      return '☀️';
    };
    const codeToText = c => {
      if (c >= 95) return 'Gewitter';
      if (c >= 80) return 'Schauer';
      if (c >= 71) return 'Schnee';
      if (c >= 61) return 'Regen';
      if (c >= 51) return 'Niesel';
      if (c >= 45) return 'Nebel';
      if (c >= 3) return 'Bewölkt';
      if (c >= 1) return 'Leicht bewölkt';
      return 'Klar';
    };
    let hours = [];
    if (hourly && hourly.time) {
      const now = new Date();
      const nowISO = now.toISOString().slice(0, 13);
      const startIdx = hourly.time.findIndex(t => t >= nowISO.replace('T', 'T'));
      const start = startIdx >= 0 ? startIdx : 0;
      for (let i = start; i < Math.min(start + 24, hourly.time.length); i++) {
        const t = hourly.time[i];
        const h = parseInt(t.split('T')[1].split(':')[0], 10);
        hours.push({
          hour: h,
          time: t,
          temp: Math.round(hourly.temperature_2m[i]),
          rain: hourly.precipitation_probability[i] || 0,
          code: hourly.weathercode[i],
          emoji: codeToEmoji(hourly.weathercode[i]),
          text: codeToText(hourly.weathercode[i])
        });
      }
    }
    // Find today's high/low from hourly
    const todayHours = hours.filter(h => {
      const d = new Date(h.time);
      return d.toDateString() === new Date().toDateString();
    });
    const high = todayHours.length ? Math.max(...todayHours.map(h => h.temp)) : null;
    const low = todayHours.length ? Math.min(...todayHours.map(h => h.temp)) : null;

    sendJSON(req, res, 200, {
      current: current ? { temp: Math.round(current.temperature), code: current.weathercode, emoji: codeToEmoji(current.weathercode), text: codeToText(current.weathercode), windspeed: current.windspeed } : null,
      high, low,
      location: 'Hamburg',
      hours,
      fetchedAt: weatherCache.fetchedAt
    }, 'public, max-age=300');
    return;
  }

  // ═══ VIBE FORECAST (7 days) ═══
  if (url.pathname === '/api/vibe-forecast') {
    try {
      const db = barfinderDB.getDB();
      const BAR_CATS = ['bar','pub','cocktailbar','wine','irish-pub','nightclub','biergarten','lounge','sports_bar'];
      const allPlacesRaw = db.prepare("SELECT * FROM places WHERE lat IS NOT NULL AND lon IS NOT NULL AND category IN (" + BAR_CATS.map(()=>'?').join(',') + ")").all(...BAR_CATS);
      const allPlaces = allPlacesRaw.map(p => {
        if (p.enriched && typeof p.enriched === 'string') try { p.enriched = JSON.parse(p.enriched); } catch(e) { p.enriched = null; }
        return p;
      });
      const dayMults = { 0: 0.4, 1: 0.35, 2: 0.4, 3: 0.55, 4: 0.7, 5: 1.0, 6: 0.95 };
      const dayNames = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
      const dayNamesFull = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
      const { hour: currentHour, dow: currentDow } = getHamburgTime();
      const weather = weatherCache.current;
      const hasEvent = getActiveMajorEvents().length > 0;
      const month = new Date().getMonth();
      const seasonFactor = ([10,11,0,1].includes(month)) ? 0.7 : ([2,3,8,9].includes(month)) ? 0.85 : 1.0;

      // Compute average base score across all places
      const baseScores = allPlaces.map(p => {
        const raw = p.vibeScore || (p.enriched ? p.enriched.vibeScore : null) || computeBaseVibe(p);
        return Math.min(raw, 70);
      });
      const avgBase = baseScores.length ? baseScores.reduce((s, v) => s + v, 0) / baseScores.length : 35;

      const days = [];
      for (let d = 0; d < 7; d++) {
        const date = new Date();
        date.setDate(date.getDate() + d);
        const dow = date.getDay();
        const dayMult = dayMults[dow] || 0.4;
        const isToday = d === 0;

        // Hourly forecast
        const hours = [];
        let peakSoll = 0, peakIst = 0, peakHour = 20;
        let sumSoll = 0, sumIst = 0, countActive = 0;

        // Scale factor: map raw scores to 0-100 where Fr 23h peak = ~85%
        // Raw peak = avgBase * 1.0 (Fr) * 1.0 (23h) * seasonFactor ≈ 35*0.7 = 24.5
        // We want that to be ~85 → scale = 85/rawPeak
        const rawPeak = avgBase * 1.0 * 1.0 * seasonFactor;
        const vibeScale = rawPeak > 0 ? 85 / rawPeak : 3;

        for (let h = 0; h < 24; h++) {
          const hourMult = getHourMultiplier(dow, h, "bar");
          const rawSoll = avgBase * dayMult * hourMult * seasonFactor;
          // Apply scale + floor of 5% during bar hours, 2% otherwise
          const floor = (h >= 10 && h <= 23) ? 5 : 2;
          const soll = Math.round(Math.min(100, Math.max(floor, rawSoll * vibeScale + (dow >= 3 && h >= 17 ? 8 : 0))));

          let ist;
          if (isToday && h <= currentHour && weather) {
            const wMod = weather.weathercode >= 61 ? -15 : weather.weathercode >= 51 ? -8 : (weather.weathercode < 3 && weather.temperature >= 20) ? 10 : 0;
            const wPct = wMod < 0 ? wMod / 100 : 0;
            ist = Math.round(Math.min(100, Math.max(floor, (rawSoll * vibeScale + Math.max(0, wMod) + (hasEvent ? 15 : 0)) * (1 + wPct))));
          } else {
            ist = soll;
          }

          hours.push({ hour: h, soll, ist });
          if (soll > peakSoll) { peakSoll = soll; peakHour = h; }
          if (ist > peakIst) peakIst = ist;
          if (h >= 17 && h <= 23) { sumSoll += soll; sumIst += ist; countActive++; }
        }

        const avgSoll = countActive ? Math.round(sumSoll / countActive) : 0;
        const avgIst = countActive ? Math.round(sumIst / countActive) : 0;

        days.push({
          date: date.toISOString().split('T')[0],
          dayName: dayNames[dow],
          dayNameFull: dayNamesFull[dow],
          dow,
          isToday,
          dayMultiplier: dayMult,
          peakSoll, peakIst, peakHour,
          avgSoll, avgIst,
          hours
        });
      }

      // Current city vibe: use same calculateDynamicVibe as /api/places for consistency
      const vibeContext = getCurrentVibeContext();
      const barCatsSet = new Set(BAR_CATS);
      const openPlaces = allPlaces.filter(p => {
        if (!barCatsSet.has(p.category)) return false;
        const oh = p.opening_hours || (p.enriched ? p.enriched.opening_hours : null);
        const status = isOpenSmart(oh, p.category);
        return status === true || status === 'likely';
      });
      const vibeScores = openPlaces.map(p => {
        const dv = calculateDynamicVibe(p, vibeContext);
        return dv.dynamicVibeScore || 0;
      }).filter(v => v > 0);
      const currentAvgVibe = vibeScores.length > 0 ? Math.round(vibeScores.reduce((s, v) => s + v, 0) / vibeScores.length) : 0;

      sendJSON(req, res, 200, {
        currentVibe: currentAvgVibe,
        currentHour,
        currentDow,
        location: 'Hamburg',
        days
      }, 'public, max-age=300');
    } catch (e) {
      console.error('Vibe forecast error:', e);
      sendJSON(req, res, 500, { error: 'Forecast error' });
    }
    return;
  }

  // ═══ NEW VIBE FACTORS ENDPOINT ═══
  if (url.pathname === '/api/vibe-factors') {
    try {
      const vibeContext = getCurrentVibeContext();
      const { hour, minute, dow, weather, isAfterworkDay, hasEventToday } = vibeContext;
      
      // Get current weather info
      let weatherInfo = null;
      if (weather) {
        const code = weather.weathercode;
        const temp = weather.temperature;
        if (code >= 61) {
          weatherInfo = { condition: 'heavy_rain', emoji: '🌧️', text: `Starker Regen, ${temp}°C`, impact: 'Outdoor -30, Indoor +10' };
        } else if (code >= 51) {
          weatherInfo = { condition: 'light_rain', emoji: '🌦️', text: `Niesel, ${temp}°C`, impact: 'Outdoor -15, Indoor +5' };
        } else if (code < 3 && temp >= 20) {
          weatherInfo = { condition: 'sunny_warm', emoji: '☀️', text: `Sonnig, ${temp}°C`, impact: 'Outdoor +20, Indoor -5' };
        } else if (temp < 0) {
          weatherInfo = { condition: 'freezing', emoji: '🥶', text: `Frost, ${temp}°C`, impact: 'Alle Locations -15' };
        } else if (temp < 10) {
          weatherInfo = { condition: 'cold', emoji: '🌡️', text: `Kalt, ${temp}°C`, impact: 'Outdoor -10, Indoor +5' };
        } else {
          weatherInfo = { condition: 'moderate', emoji: '⛅', text: `${temp}°C`, impact: 'Neutral' };
        }
      }

      // Get day info
      const dayNames = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
      const dayMultiplier = { 0: 0.5, 1: 0.6, 2: 0.65, 3: 0.8, 4: 0.95, 5: 1.0, 6: 0.9 }[dow] || 0.6;
      const dayInfo = {
        name: dayNames[dow],
        dayOfWeek: dow,
        multiplier: dayMultiplier,
        isWeekend: dow === 5 || dow === 6,
        impact: dow === 5 || dow === 6 ? 'Peak Weekend' : dow >= 3 ? 'Good' : 'Quiet'
      };

      // Get time info
      const timeInfo = {
        hour,
        minute,
        timeString: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
        period: hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : hour < 21 ? 'evening' : 'night',
        peakForBars: hour >= 19 && hour <= 23,
        peakForCafes: hour >= 9 && hour <= 14
      };

      // Get active events info
      const majorEvents = getActiveMajorEvents();
      const eventsInfo = {
        hasMajorEvents: hasEventToday,
        majorEvents: majorEvents.map(e => ({ name: e.name, boost: e.boost })),
        hasAfterwork: isAfterworkDay,
        afterworkLocations: isAfterworkDay ? afterworkSchedule.locations.filter(loc => loc.days.includes(dow)).length : 0
      };

      sendJSON(req, res, 200, {
        timestamp: new Date().toISOString(),
        context: vibeContext,
        day: dayInfo,
        time: timeInfo,
        weather: weatherInfo,
        events: eventsInfo,
        explanation: {
          howItWorks: "Der dynamische Vibe-Score kombiniert Wochentag, Uhrzeit, Wetter und Events für eine Echtzeit-Bewertung der Wahrscheinlichkeit, Leute zu treffen.",
          factors: {
            baseScore: "Statischer Basis-Score aus Location-Qualität (20-60)",
            dayMultiplier: "Wochentag-Faktor: Mo/Di=0.6, Mi=0.65, Do=0.8, Fr=0.95, Sa=1.0, So=0.9",
            timeBoost: "Kategorie-spezifische Peak-Zeiten: Cafés 9-14h, Bars 19-23h, Clubs 22-3h",
            weatherMod: "Wetter-Einfluss: Regen schadet Outdoor (-30), hilft Indoor (+10)",
            eventBoost: "Events heute: +15 Punkte",
            afterworkBoost: "Afterwork-Tag: +10 Punkte"
          }
        }
      }, 'public, max-age=60');
    } catch(e) {
      sendError(req, res, 500, e.message);
    }
    return;
  }

  // ═══ REFRESH SINGLE PLACE (community score lookup) ═══
  if (url.pathname === '/api/refresh-place') {
    const name = url.searchParams.get('name');
    if (!name) { res.writeHead(400, {'Content-Type':'application/json'}); res.end('{"error":"name required"}'); return; }
    const cs = getCommunityScore(name);
    sendJSON(req, res, 200, { ok: true, name, communityScore: cs }, 'no-store');
    return;
  }

  if (url.pathname === '/api/config') {
    sendJSON(req, res, 200, {
      SAVED_LOCS: config.SAVED_LOCS,
      DEFAULT_LAT: config.DEFAULT_LAT,
      DEFAULT_LON: config.DEFAULT_LON
    }, 'public, max-age=3600');
    return;
  }

  // ═══ SQLITE API ENDPOINTS ═══

  // POST /api/feedback — record user feedback
  if (url.pathname === '/api/feedback' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { placeId, type, comment, context } = JSON.parse(body);
        if (!type) throw new Error('feedback type required');
        barfinderDB.addFeedback(placeId, type, { comment, context });
        sendJSON(req, res, 200, { ok: true }, 'no-store');
      } catch (e) {
        sendError(req, res, 400, e.message);
      }
    });
    return;
  }

  // GET /api/place/:id/history — rating history + feedback
  if (url.pathname.match(/^\/api\/place\/(\d+)\/history$/) && req.method === 'GET') {
    const placeId = parseInt(url.pathname.match(/^\/api\/place\/(\d+)\/history$/)[1]);
    try {
      const ratings = barfinderDB.getRatingHistory(placeId);
      const feedback = barfinderDB.getDB().prepare('SELECT * FROM feedback WHERE place_id = ? ORDER BY created_at DESC').all(placeId);
      const vibeBonus = barfinderDB.computeLearnedVibeBonus(placeId);
      sendJSON(req, res, 200, { placeId, ratings, feedback, vibeBonus }, 'no-cache');
    } catch (e) {
      sendError(req, res, 500, e.message);
    }
    return;
  }

  // GET /api/stats — scrape run stats
  if (url.pathname === '/api/stats' && req.method === 'GET') {
    try {
      const stats = barfinderDB.getStats();
      sendJSON(req, res, 200, stats, 'no-cache');
    } catch (e) {
      sendError(req, res, 500, e.message);
    }
    return;
  }

  // /api/health is handled above (before other routes)

  // ═══ VERIFY HOURS (cached only, no scraping) ═══
  if (url.pathname === '/api/verify-hours') {
    const name = url.searchParams.get('name');
    if (!name) { return sendError(req, res, 400, 'name parameter required'); }
    const cached = getVerifiedHours(name);
    if (cached) {
      return sendJSON(req, res, 200, { ...cached, fromCache: true, hoursVerified: true, hoursSource: 'cached' }, 'public, max-age=3600');
    }
    return sendJSON(req, res, 200, { name, hoursVerified: false, hoursSource: null, message: 'No verified hours available' }, 'no-store');
  }

  // ═══ VERIFY HOURS BATCH (disabled, no scraping) ═══
  if (url.pathname === '/api/verify-hours/batch' && req.method === 'POST') {
    return sendJSON(req, res, 200, { started: false, message: 'Batch verification disabled' }, 'no-store');
  }

  // ═══ USER DATA (Server-side persistence) ═══
  if (url.pathname === '/api/user/data') {
    const userId = url.searchParams.get('uid') || 'default';
    const userFile = path.join(__dirname, 'user_data', userId + '.json');
    
    if (req.method === 'GET') {
      try {
        if (fs.existsSync(userFile)) {
          const data = JSON.parse(fs.readFileSync(userFile, 'utf8'));
          return sendJSON(req, res, 200, data, 'no-cache');
        }
        return sendJSON(req, res, 200, { favorites: [], checkins: [], ratings: [], theme: null }, 'no-cache');
      } catch (e) { return sendError(req, res, 500, e.message); }
    }
    
    if (req.method === 'POST' || req.method === 'PUT') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (!fs.existsSync(path.join(__dirname, 'user_data'))) {
            fs.mkdirSync(path.join(__dirname, 'user_data'), { recursive: true });
          }
          // Merge with existing
          let existing = {};
          if (fs.existsSync(userFile)) {
            existing = JSON.parse(fs.readFileSync(userFile, 'utf8'));
          }
          const merged = { ...existing, ...data, updatedAt: new Date().toISOString() };
          fs.writeFileSync(userFile, JSON.stringify(merged, null, 2));
          sendJSON(req, res, 200, { ok: true });
        } catch (e) { sendError(req, res, 400, e.message); }
      });
      return;
    }
  }

  // ═══ VERIFIED HOURS STATUS ═══
  if (url.pathname === '/api/verified-hours') {
    const entries = Object.entries(verifiedHoursCache);
    return sendJSON(req, res, 200, {
      total: entries.length,
      locations: entries.map(([key, val]) => ({
        name: val.name,
        opening_hours: val.opening_hours,
        currentlyOpen: val.currentlyOpen,
        scrapedAt: val.scrapedAt
      }))
    }, 'public, max-age=60');
  }

  // ═══ AFTERWORK TODAY ═══
  if (url.pathname === '/api/afterwork/today') {
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Berlin' }));
    const dayOfWeek = now.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
    const todayLocations = afterworkSchedule.locations.filter(loc => loc.days.includes(dayOfWeek));
    
    // Match with highlights.json places
    const results = todayLocations.map(loc => {
      const place = HIGHLIGHTS.find(p => p.name === loc.name);
      if (!place) return null;
      return {
        ...place,
        afterworkTime: loc.time,
        afterworkDescription: loc.description,
        afterworkDays: loc.days
      };
    }).filter(Boolean);

    const latParam = parseFloat(url.searchParams.get('lat') || '0');
    const lonParam = parseFloat(url.searchParams.get('lon') || '0');
    if (latParam && lonParam) {
      results.forEach(p => {
        const R = 6371e3;
        const dLat = (p.lat - latParam) * Math.PI / 180;
        const dLon = (p.lon - lonParam) * Math.PI / 180;
        const a = Math.sin(dLat/2)**2 + Math.cos(latParam*Math.PI/180)*Math.cos(p.lat*Math.PI/180)*Math.sin(dLon/2)**2;
        p.distance = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
      });
      results.sort((a, b) => a.distance - b.distance);
    }

    setSecurityHeaders(req, res); res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ day: dayOfWeek, dayName: ['Sonntag','Montag','Dienstag','Mittwoch','Donnerstag','Freitag','Samstag'][dayOfWeek], count: results.length, locations: results }));
    return;
  }

  // ═══ AFTERWORK FULL SCHEDULE ═══
  if (url.pathname === '/api/afterwork/schedule') {
    setSecurityHeaders(req, res); res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(afterworkSchedule));
    return;
  }

  // ═══ DISCOVERY / TIPP DES TAGES ═══
  if (url.pathname === '/api/discovery') {
    const favParam = url.searchParams.get('favorites') || '';
    const favSet = new Set(favParam.split(',').map(f => f.trim().toLowerCase()).filter(Boolean));

    // Zufälliger Seed bei jedem Request → jedes Mal neue Entdeckungen
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Berlin' }));
    const daySeed = Date.now() ^ (Math.random() * 0xFFFFFF | 0);

    // Einfacher Seeded PRNG (Mulberry32)
    function seededRandom(seed) {
      let t = seed + 0x6D2B79F5;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }

    // Kandidaten: alle Highlights, die NICHT Favoriten sind UND offen oder bald öffnend
    let candidates = HIGHLIGHTS.filter(h => {
      if (favSet.has((h.name || '').toLowerCase())) return false;
      const open = isOpenSmart(h.opening_hours, h.category);
      if (open === true) return true; // jetzt offen
      if (open === null) return true; // unbekannt → reinlassen
      // Prüfe ob in den nächsten 2h öffnet
      const oh = h.opening_hours || '';
      if (!oh) return false;
      const { hour, minute } = getHamburgTime();
      const nowMin = hour * 60 + minute;
      const days = ['Su','Mo','Tu','We','Th','Fr','Sa'];
      const { dow } = getHamburgTime();
      const day = days[dow];
      const parts = oh.split(';').map(s => s.trim());
      for (const part of parts) {
        const match = part.match(/^((?:Mo|Tu|We|Th|Fr|Sa|Su)(?:\s*-\s*(?:Mo|Tu|We|Th|Fr|Sa|Su))?(?:\s*,\s*(?:Mo|Tu|We|Th|Fr|Sa|Su)(?:\s*-\s*(?:Mo|Tu|We|Th|Fr|Sa|Su))?)*)\s+(\d{2}):(\d{2})\s*-\s*(\d{2}):(\d{2})/i);
        if (!match) continue;
        if (isDayInRange(day, match[1], days)) {
          const openMin = parseInt(match[2]) * 60 + parseInt(match[3]);
          if (openMin > nowMin && openMin <= nowMin + 120) return true; // öffnet in ≤2h
        }
      }
      return false;
    });

    // Gewichtung: Community Score bevorzugen
    candidates = candidates.map(h => {
      const cs = getCommunityScore(h.name) || 0;
      let weight = 1;
      if (cs >= 70) weight = 4;
      else if (cs >= 55) weight = 3;
      else if (cs >= 40) weight = 2;
      return { ...h, _weight: weight, _communityScore: cs };
    });

    // Gewichtetes Shuffle mit Tages-Seed
    candidates.forEach((c, i) => {
      c._sortKey = seededRandom(daySeed + i) * c._weight;
    });
    candidates.sort((a, b) => b._sortKey - a._sortKey);

    // Kategorie-Vielfalt: versuche unterschiedliche Kategorien
    const picked = [];
    const usedCats = new Set();
    // Erster Pass: verschiedene Kategorien
    for (const c of candidates) {
      if (picked.length >= 3) break;
      if (!usedCats.has(c.category)) {
        usedCats.add(c.category);
        picked.push(c);
      }
    }
    // Zweiter Pass: auffüllen falls nötig
    for (const c of candidates) {
      if (picked.length >= 3) break;
      if (!picked.includes(c)) picked.push(c);
    }

    // Enrichment mit aktuellen Scores
    const enriched = picked.map(h => {
      const vs = computeVibeScore(h, true);
      const rm = fuzzyMatchRating(h.name);
      const bn = estimateBusyness(h, getHamburgTime().dow, getHamburgTime().hour);
      return {
        ...h,
        isOpen: isOpenSmart(h.opening_hours, h.category),
        vibeScore: vs.vibe,
        vibeLabel: vs.vibeLabel,
        vibeEmoji: vs.vibeEmoji,
        communityScore: getCommunityScore(h.name) || null,
        estimatedBusyness: bn.busyness,
        busynessLabel: bn.busynessLabel,
        busynessColor: bn.busynessColor,
      };
    });

    sendJSON(req, res, 200, { date: `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`, discoveries: enriched }, 'no-cache');
    return;
  }

  // ═══════════════════════════════════════════════════════════════
  // 🔍 SEMANTIC SEARCH — GET /api/search?q=...&lat=...&lon=...
  // ═══════════════════════════════════════════════════════════════
  if (url.pathname === '/api/search') {
    const q = (url.searchParams.get('q') || '').trim();
    const lat = parseFloat(url.searchParams.get('lat')) || config.DEFAULT_LAT;
    const lon = parseFloat(url.searchParams.get('lon')) || config.DEFAULT_LON;

    if (!q || q.length < 2) {
      setSecurityHeaders(req, res); res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ results: [], query: q }));
      return;
    }

    try {
      const results = await semanticSearch(q, lat, lon);
      setSecurityHeaders(req, res); res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify({ results, query: q }));
    } catch (e) {
      console.log('❌ search error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message, results: [] }));
    }
    return;
  }

  // ═══ CORS PREFLIGHT ═══
  if (req.method === 'OPTIONS') {
    setSecurityHeaders(req, res);
    res.writeHead(204, {
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    });
    res.end();
    return;
  }

  // ═══════════════════════════════════════════════════════════════
  // 🔐 AUTH ENDPOINTS
  // ═══════════════════════════════════════════════════════════════

  // POST /api/auth/register
  if (url.pathname === '/api/auth/register' && req.method === 'POST') {
    if (!checkAuthRateLimit(req)) return sendError(req, res, 429, 'Zu viele Versuche. Bitte warte eine Minute.');
    try {
      const rawBody = sanitizeInput(await readBody(req));
      const { email, password, displayName } = rawBody;
      if (!email || !password) return sendError(req, res, 400, 'E-Mail und Passwort erforderlich');
      if (password.length < 8) return sendError(req, res, 400, 'Passwort muss mindestens 8 Zeichen lang sein');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return sendError(req, res, 400, 'Ungueltige E-Mail-Adresse');

      const db = barfinderDB.getDB();
      const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
      if (existing) return sendError(req, res, 409, 'Diese E-Mail ist bereits registriert');

      const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
      const verificationToken = crypto.randomBytes(32).toString('hex');

      const result = db.prepare(
        'INSERT INTO users (email, password_hash, display_name, verification_token) VALUES (?, ?, ?, ?)'
      ).run(email.toLowerCase(), passwordHash, displayName || null, verificationToken);

      console.log(`📧 Verification link for ${email}: /api/auth/verify/${verificationToken}`);

      const token = jwt.sign({ userId: result.lastInsertRowid, email: email.toLowerCase(), role: 'user' }, JWT_SECRET, { expiresIn: JWT_EXPIRY });

      res.setHeader('Set-Cookie', `bf_token=${token}; HttpOnly; Secure; Path=/; Max-Age=${7*24*3600}; SameSite=Lax`);
      return sendJSON(req, res, 201, {
        ok: true,
        token,
        user: { id: result.lastInsertRowid, email: email.toLowerCase(), displayName: displayName || null, role: 'user', emailVerified: false }
      });
    } catch(e) {
      console.error('Register error:', e);
      return sendError(req, res, 500, 'Registrierung fehlgeschlagen');
    }
  }

  // POST /api/auth/login
  if (url.pathname === '/api/auth/login' && req.method === 'POST') {
    if (!checkAuthRateLimit(req)) return sendError(req, res, 429, 'Zu viele Versuche. Bitte warte eine Minute.');
    try {
      const { email, password } = sanitizeInput(await readBody(req));
      if (!email || !password) return sendError(req, res, 400, 'E-Mail und Passwort erforderlich');

      const db = barfinderDB.getDB();
      const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
      if (!user) return sendError(req, res, 401, 'E-Mail oder Passwort falsch');

      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid) return sendError(req, res, 401, 'E-Mail oder Passwort falsch');

      db.prepare('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);

      const token = jwt.sign({ userId: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: JWT_EXPIRY });

      res.setHeader('Set-Cookie', `bf_token=${token}; HttpOnly; Secure; Path=/; Max-Age=${7*24*3600}; SameSite=Lax`);
      return sendJSON(req, res, 200, {
        ok: true,
        token,
        user: { id: user.id, email: user.email, displayName: user.display_name, role: user.role, emailVerified: !!user.email_verified }
      });
    } catch(e) {
      console.error('Login error:', e);
      return sendError(req, res, 500, 'Anmeldung fehlgeschlagen');
    }
  }

  // GET /api/auth/verify/:token
  if (url.pathname.startsWith('/api/auth/verify/') && req.method === 'GET') {
    const token = url.pathname.split('/').pop();
    const db = barfinderDB.getDB();
    const user = db.prepare('SELECT id FROM users WHERE verification_token = ?').get(token);
    if (!user) return sendError(req, res, 404, 'Ungueltiger Verifizierungstoken');
    db.prepare('UPDATE users SET email_verified = 1, verification_token = NULL WHERE id = ?').run(user.id);
    return sendJSON(req, res, 200, { ok: true, message: 'E-Mail erfolgreich verifiziert' });
  }

  // POST /api/auth/forgot-password
  if (url.pathname === '/api/auth/forgot-password' && req.method === 'POST') {
    if (!checkAuthRateLimit(req)) return sendError(req, res, 429, 'Zu viele Versuche.');
    try {
      const { email } = await readBody(req);
      const db = barfinderDB.getDB();
      const user = db.prepare('SELECT id FROM users WHERE email = ?').get((email || '').toLowerCase());
      // Always return success to prevent email enumeration
      if (user) {
        const resetToken = crypto.randomBytes(32).toString('hex');
        const expires = Date.now() + 3600000; // 1 hour
        db.prepare('UPDATE users SET reset_token = ?, reset_expires = ? WHERE id = ?').run(resetToken, expires, user.id);
        console.log(`🔑 Password reset for ${email}: /api/auth/reset-password with token ${resetToken}`);
      }
      return sendJSON(req, res, 200, { ok: true, message: 'Falls ein Account existiert, wurde ein Reset-Link gesendet.' });
    } catch(e) {
      return sendError(req, res, 500, 'Fehler beim Passwort-Reset');
    }
  }

  // POST /api/auth/reset-password
  if (url.pathname === '/api/auth/reset-password' && req.method === 'POST') {
    try {
      const { token, password } = await readBody(req);
      if (!token || !password) return sendError(req, res, 400, 'Token und Passwort erforderlich');
      if (password.length < 8) return sendError(req, res, 400, 'Passwort muss mindestens 8 Zeichen lang sein');

      const db = barfinderDB.getDB();
      const user = db.prepare('SELECT id FROM users WHERE reset_token = ? AND reset_expires > ?').get(token, Date.now());
      if (!user) return sendError(req, res, 400, 'Ungueltiger oder abgelaufener Reset-Token');

      const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
      db.prepare('UPDATE users SET password_hash = ?, reset_token = NULL, reset_expires = NULL WHERE id = ?').run(passwordHash, user.id);
      return sendJSON(req, res, 200, { ok: true, message: 'Passwort erfolgreich geaendert' });
    } catch(e) {
      return sendError(req, res, 500, 'Passwort-Reset fehlgeschlagen');
    }
  }

  // GET /api/auth/me
  if (url.pathname === '/api/auth/me' && req.method === 'GET') {
    const user = verifyUser(req);
    if (!user) return sendError(req, res, 401, 'Nicht angemeldet');
    const db = barfinderDB.getDB();
    const dbUser = db.prepare('SELECT id, email, display_name, role, email_verified, created_at, last_login FROM users WHERE id = ?').get(user.userId);
    if (!dbUser) return sendError(req, res, 404, 'Benutzer nicht gefunden');
    return sendJSON(req, res, 200, {
      user: { id: dbUser.id, email: dbUser.email, displayName: dbUser.display_name, role: dbUser.role, emailVerified: !!dbUser.email_verified, createdAt: dbUser.created_at, lastLogin: dbUser.last_login }
    });
  }

  // POST /api/auth/logout
  if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
    res.setHeader('Set-Cookie', 'bf_token=; HttpOnly; Secure; Path=/; Max-Age=0; SameSite=Lax');
    return sendJSON(req, res, 200, { ok: true });
  }

  // ═══ FAVORITES (auth required) ═══

  // GET /api/favorites
  if (url.pathname === '/api/favorites' && req.method === 'GET') {
    const user = verifyUser(req);
    if (!user) return sendError(req, res, 401, 'Nicht angemeldet');
    const db = barfinderDB.getDB();
    const favs = db.prepare('SELECT place_id, created_at FROM favorites WHERE user_id = ?').all(user.userId);
    return sendJSON(req, res, 200, { favorites: favs });
  }

  // POST /api/favorites/:placeId
  if (url.pathname.match(/^\/api\/favorites\/(\d+)$/) && req.method === 'POST') {
    const user = verifyUser(req);
    if (!user) return sendError(req, res, 401, 'Nicht angemeldet');
    const placeId = parseInt(url.pathname.split('/').pop());
    const db = barfinderDB.getDB();
    try {
      db.prepare('INSERT OR IGNORE INTO favorites (user_id, place_id) VALUES (?, ?)').run(user.userId, placeId);
      return sendJSON(req, res, 200, { ok: true });
    } catch(e) { return sendError(req, res, 500, e.message); }
  }

  // DELETE /api/favorites/:placeId
  if (url.pathname.match(/^\/api\/favorites\/(\d+)$/) && req.method === 'DELETE') {
    const user = verifyUser(req);
    if (!user) return sendError(req, res, 401, 'Nicht angemeldet');
    const placeId = parseInt(url.pathname.split('/').pop());
    const db = barfinderDB.getDB();
    db.prepare('DELETE FROM favorites WHERE user_id = ? AND place_id = ?').run(user.userId, placeId);
    return sendJSON(req, res, 200, { ok: true });
  }

  // ═══ USER RATINGS (auth required) ═══

  // POST /api/ratings/:placeId
  if (url.pathname.match(/^\/api\/ratings\/(\d+)$/) && req.method === 'POST') {
    const user = verifyUser(req);
    if (!user) return sendError(req, res, 401, 'Nicht angemeldet');
    const placeId = parseInt(url.pathname.split('/').pop());
    try {
      const { rating, comment } = await readBody(req);
      if (!rating || rating < 1 || rating > 5) return sendError(req, res, 400, 'Bewertung muss zwischen 1 und 5 liegen');
      const db = barfinderDB.getDB();
      db.prepare('INSERT OR REPLACE INTO user_ratings (user_id, place_id, rating, comment) VALUES (?, ?, ?, ?)').run(user.userId, placeId, rating, comment || null);
      return sendJSON(req, res, 200, { ok: true });
    } catch(e) { return sendError(req, res, 500, e.message); }
  }

  // GET /api/ratings/:placeId
  if (url.pathname.match(/^\/api\/ratings\/(\d+)$/) && req.method === 'GET') {
    const placeId = parseInt(url.pathname.split('/').pop());
    const db = barfinderDB.getDB();
    const ratings = db.prepare(`
      SELECT ur.rating, ur.comment, ur.created_at, u.display_name
      FROM user_ratings ur JOIN users u ON ur.user_id = u.id
      WHERE ur.place_id = ? ORDER BY ur.created_at DESC
    `).all(placeId);
    const avg = db.prepare('SELECT AVG(rating) as avg, COUNT(*) as count FROM user_ratings WHERE place_id = ?').get(placeId);
    return sendJSON(req, res, 200, { ratings, average: avg.avg ? Math.round(avg.avg * 10) / 10 : null, count: avg.count });
  }

  // ═══ ADMIN ENDPOINTS ═══

  // GET /api/admin/users
  if (url.pathname === '/api/admin/users' && req.method === 'GET') {
    const user = verifyUser(req);
    if (!user || user.role !== 'admin') return sendError(req, res, 403, 'Zugriff verweigert');
    const db = barfinderDB.getDB();
    const users = db.prepare('SELECT id, email, display_name, role, email_verified, created_at, last_login FROM users ORDER BY created_at DESC').all();
    return sendJSON(req, res, 200, { users });
  }

  // PUT /api/admin/users/:id/role
  if (url.pathname.match(/^\/api\/admin\/users\/(\d+)\/role$/) && req.method === 'PUT') {
    const user = verifyUser(req);
    if (!user || user.role !== 'admin') return sendError(req, res, 403, 'Zugriff verweigert');
    const targetId = parseInt(url.pathname.match(/\/(\d+)\//)[1]);
    try {
      const { role } = await readBody(req);
      if (!['admin', 'user'].includes(role)) return sendError(req, res, 400, 'Ungueltige Rolle');
      const db = barfinderDB.getDB();
      db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, targetId);
      return sendJSON(req, res, 200, { ok: true });
    } catch(e) { return sendError(req, res, 500, e.message); }
  }

  // DELETE /api/admin/users/:id
  if (url.pathname.match(/^\/api\/admin\/users\/(\d+)$/) && req.method === 'DELETE') {
    const user = verifyUser(req);
    if (!user || user.role !== 'admin') return sendError(req, res, 403, 'Zugriff verweigert');
    const targetId = parseInt(url.pathname.split('/').pop());
    if (targetId === user.userId) return sendError(req, res, 400, 'Eigenen Account kann man nicht loeschen');
    const db = barfinderDB.getDB();
    db.prepare('DELETE FROM users WHERE id = ?').run(targetId);
    return sendJSON(req, res, 200, { ok: true });
  }

  // GET /api/admin/stats
  if (url.pathname === '/api/admin/stats' && req.method === 'GET') {
    const user = verifyUser(req);
    if (!user || user.role !== 'admin') return sendError(req, res, 403, 'Zugriff verweigert');
    const db = barfinderDB.getDB();
    const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
    const ratingCount = db.prepare('SELECT COUNT(*) as count FROM user_ratings').get().count;
    const favCount = db.prepare('SELECT COUNT(*) as count FROM favorites').get().count;
    const recentUsers = db.prepare('SELECT id, email, display_name, role, created_at FROM users ORDER BY created_at DESC LIMIT 10').all();
    return sendJSON(req, res, 200, { userCount, ratingCount, favCount, recentUsers });
  }

  // ═══ SAVED LOCATIONS ═══
  if (url.pathname === '/api/user/locations' && req.method === 'GET') {
    const user = verifyUser(req);
    if (!user) return sendError(req, res, 401, 'Nicht angemeldet');
    const db = barfinderDB.getDB();
    const rows = db.prepare('SELECT * FROM saved_locations WHERE user_id = ? ORDER BY is_default DESC, created_at DESC').all(user.userId);
    return sendJSON(req, res, 200, rows);
  }
  if (url.pathname === '/api/user/locations' && req.method === 'POST') {
    const user = verifyUser(req);
    if (!user) return sendError(req, res, 401, 'Nicht angemeldet');
    try {
      const body = await readBody(req);
      const { name, lat, lng, address } = body;
      if (!name || lat == null || lng == null) return sendError(req, res, 400, 'Name, lat und lng erforderlich');
      const db = barfinderDB.getDB();
      const r = db.prepare('INSERT INTO saved_locations (user_id, name, lat, lng, address) VALUES (?,?,?,?,?)').run(user.userId, name, lat, lng, address || null);
      return sendJSON(req, res, 201, { id: r.lastInsertRowid, name, lat, lng, address });
    } catch(e) { return sendError(req, res, 400, e.message); }
  }
  if (/^\/api\/user\/locations\/(\d+)$/.test(url.pathname) && req.method === 'PUT') {
    const user = verifyUser(req);
    if (!user) return sendError(req, res, 401, 'Nicht angemeldet');
    const id = url.pathname.match(/(\d+)$/)[1];
    try {
      const body = await readBody(req);
      const db = barfinderDB.getDB();
      db.prepare('UPDATE saved_locations SET name=COALESCE(?,name), lat=COALESCE(?,lat), lng=COALESCE(?,lng), address=COALESCE(?,address) WHERE id=? AND user_id=?')
        .run(body.name||null, body.lat||null, body.lng||null, body.address||null, id, user.userId);
      return sendJSON(req, res, 200, { ok: true });
    } catch(e) { return sendError(req, res, 400, e.message); }
  }
  if (/^\/api\/user\/locations\/(\d+)$/.test(url.pathname) && req.method === 'DELETE') {
    const user = verifyUser(req);
    if (!user) return sendError(req, res, 401, 'Nicht angemeldet');
    const id = url.pathname.match(/(\d+)$/)[1];
    const db = barfinderDB.getDB();
    db.prepare('DELETE FROM saved_locations WHERE id=? AND user_id=?').run(id, user.userId);
    return sendJSON(req, res, 200, { ok: true });
  }
  if (/^\/api\/user\/locations\/(\d+)\/default$/.test(url.pathname) && req.method === 'PUT') {
    const user = verifyUser(req);
    if (!user) return sendError(req, res, 401, 'Nicht angemeldet');
    const id = url.pathname.match(/(\d+)/)[1];
    const db = barfinderDB.getDB();
    db.prepare('UPDATE saved_locations SET is_default=0 WHERE user_id=?').run(user.userId);
    db.prepare('UPDATE saved_locations SET is_default=1 WHERE id=? AND user_id=?').run(id, user.userId);
    return sendJSON(req, res, 200, { ok: true });
  }

  // ═══ USER PREFERENCES ═══
  if (url.pathname === '/api/user/preferences' && req.method === 'GET') {
    const user = verifyUser(req);
    if (!user) return sendError(req, res, 401, 'Nicht angemeldet');
    const db = barfinderDB.getDB();
    let prefs = db.prepare('SELECT * FROM user_preferences WHERE user_id=?').get(user.userId);
    if (!prefs) {
      db.prepare('INSERT INTO user_preferences (user_id) VALUES (?)').run(user.userId);
      prefs = db.prepare('SELECT * FROM user_preferences WHERE user_id=?').get(user.userId);
    }
    prefs.preferred_categories = JSON.parse(prefs.preferred_categories || '[]');
    prefs.preferred_districts = JSON.parse(prefs.preferred_districts || '[]');
    return sendJSON(req, res, 200, prefs);
  }
  if (url.pathname === '/api/user/preferences' && req.method === 'PUT') {
    const user = verifyUser(req);
    if (!user) return sendError(req, res, 401, 'Nicht angemeldet');
    try {
      const body = await readBody(req);
      const db = barfinderDB.getDB();
      db.prepare(`INSERT INTO user_preferences (user_id, preferred_categories, preferred_districts, vibe_preference, radius_km, updated_at)
        VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(user_id) DO UPDATE SET
          preferred_categories=COALESCE(?, preferred_categories),
          preferred_districts=COALESCE(?, preferred_districts),
          vibe_preference=COALESCE(?, vibe_preference),
          radius_km=COALESCE(?, radius_km),
          updated_at=CURRENT_TIMESTAMP`).run(
        user.userId,
        body.preferred_categories ? JSON.stringify(body.preferred_categories) : '[]',
        body.preferred_districts ? JSON.stringify(body.preferred_districts) : '[]',
        body.vibe_preference || 'any',
        body.radius_km || 3,
        body.preferred_categories ? JSON.stringify(body.preferred_categories) : null,
        body.preferred_districts ? JSON.stringify(body.preferred_districts) : null,
        body.vibe_preference || null,
        body.radius_km || null
      );
      return sendJSON(req, res, 200, { ok: true });
    } catch(e) { return sendError(req, res, 400, e.message); }
  }

  // ═══ SEARCH HISTORY ═══
  if (url.pathname === '/api/user/history' && req.method === 'GET') {
    const user = verifyUser(req);
    if (!user) return sendError(req, res, 401, 'Nicht angemeldet');
    const db = barfinderDB.getDB();
    const rows = db.prepare('SELECT * FROM search_history WHERE user_id=? ORDER BY created_at DESC LIMIT 20').all(user.userId);
    rows.forEach(r => { try { r.filters = JSON.parse(r.filters || '{}'); } catch(e) { r.filters = {}; } });
    return sendJSON(req, res, 200, rows);
  }
  if (url.pathname === '/api/user/history' && req.method === 'POST') {
    const user = verifyUser(req);
    if (!user) return sendError(req, res, 401, 'Nicht angemeldet');
    try {
      const body = await readBody(req);
      const db = barfinderDB.getDB();
      db.prepare('INSERT INTO search_history (user_id, query, lat, lng, filters) VALUES (?,?,?,?,?)')
        .run(user.userId, body.query || null, body.lat || null, body.lng || null, body.filters ? JSON.stringify(body.filters) : null);
      return sendJSON(req, res, 201, { ok: true });
    } catch(e) { return sendError(req, res, 400, e.message); }
  }
  if (url.pathname === '/api/user/history' && req.method === 'DELETE') {
    const user = verifyUser(req);
    if (!user) return sendError(req, res, 401, 'Nicht angemeldet');
    const db = barfinderDB.getDB();
    db.prepare('DELETE FROM search_history WHERE user_id=?').run(user.userId);
    return sendJSON(req, res, 200, { ok: true });
  }

  // ═══ RECENTLY VIEWED ═══
  if (url.pathname === '/api/user/recent' && req.method === 'GET') {
    const user = verifyUser(req);
    if (!user) return sendError(req, res, 401, 'Nicht angemeldet');
    const db = barfinderDB.getDB();
    const rows = db.prepare('SELECT rv.place_id, rv.viewed_at, p.name, p.category, p.lat, p.lon, p.address FROM recently_viewed rv LEFT JOIN places p ON rv.place_id = p.id WHERE rv.user_id=? ORDER BY rv.viewed_at DESC LIMIT 20').all(user.userId);
    return sendJSON(req, res, 200, rows);
  }
  if (/^\/api\/user\/recent\/(\d+)$/.test(url.pathname) && req.method === 'POST') {
    const user = verifyUser(req);
    if (!user) return sendError(req, res, 401, 'Nicht angemeldet');
    const placeId = url.pathname.match(/(\d+)$/)[1];
    const db = barfinderDB.getDB();
    db.prepare('INSERT INTO recently_viewed (user_id, place_id, viewed_at) VALUES (?,?, CURRENT_TIMESTAMP) ON CONFLICT(user_id, place_id) DO UPDATE SET viewed_at=CURRENT_TIMESTAMP')
      .run(user.userId, placeId);
    return sendJSON(req, res, 200, { ok: true });
  }

  // ═══ VIBE FEEDBACK ═══
  if (url.pathname === '/api/feedback/vibe' && req.method === 'POST') {
    const user = verifyUser(req);
    if (!user) return sendError(req, res, 401, 'Nicht angemeldet');
    try {
      const body = await readBody(req);
      if (!body.placeId || !body.actual_vibe) return sendError(req, res, 400, 'placeId und actual_vibe erforderlich');
      const db = barfinderDB.getDB();
      db.prepare('INSERT INTO vibe_feedback (user_id, place_id, predicted_vibe, actual_vibe, comment) VALUES (?,?,?,?,?)')
        .run(user.userId, body.placeId, body.predicted_vibe || null, body.actual_vibe, body.comment || null);
      // Update user stats
      db.prepare(`INSERT INTO user_stats (user_id, feedbacks_given, bars_visited, member_since)
        VALUES (?, 1, 1, CURRENT_TIMESTAMP)
        ON CONFLICT(user_id) DO UPDATE SET feedbacks_given=feedbacks_given+1, bars_visited=bars_visited+1`).run(user.userId);
      // Recalculate badge
      const stats = db.prepare('SELECT feedbacks_given FROM user_stats WHERE user_id=?').get(user.userId);
      const fg = stats ? stats.feedbacks_given : 0;
      const badge = fg > 50 ? 'insider' : fg > 20 ? 'expert' : fg > 5 ? 'regular' : 'newcomer';
      db.prepare('UPDATE user_stats SET badge_level=? WHERE user_id=?').run(badge, user.userId);
      return sendJSON(req, res, 201, { ok: true, badge_level: badge });
    } catch(e) { return sendError(req, res, 400, e.message); }
  }
  if (/^\/api\/feedback\/vibe\/(\d+)$/.test(url.pathname) && req.method === 'GET') {
    const placeId = url.pathname.match(/(\d+)$/)[1];
    const db = barfinderDB.getDB();
    const rows = db.prepare('SELECT vf.*, u.display_name FROM vibe_feedback vf LEFT JOIN users u ON vf.user_id=u.id WHERE vf.place_id=? ORDER BY vf.visited_at DESC LIMIT 20').all(placeId);
    const summary = db.prepare(`SELECT actual_vibe, COUNT(*) as cnt FROM vibe_feedback WHERE place_id=? GROUP BY actual_vibe`).all(placeId);
    return sendJSON(req, res, 200, { feedback: rows, summary });
  }
  if (url.pathname === '/api/feedback/stats' && req.method === 'GET') {
    const user = verifyUser(req);
    if (!user) return sendError(req, res, 401, 'Nicht angemeldet');
    const db = barfinderDB.getDB();
    const total = db.prepare('SELECT COUNT(*) as cnt FROM vibe_feedback WHERE user_id=?').get(user.userId).cnt;
    const byVibe = db.prepare('SELECT actual_vibe, COUNT(*) as cnt FROM vibe_feedback WHERE user_id=? GROUP BY actual_vibe').all(user.userId);
    const recent = db.prepare('SELECT vf.*, p.name as place_name FROM vibe_feedback vf LEFT JOIN places p ON vf.place_id=p.id WHERE vf.user_id=? ORDER BY vf.visited_at DESC LIMIT 5').all(user.userId);
    return sendJSON(req, res, 200, { total, byVibe, recent });
  }

  // ═══ USER STATS / GAMIFICATION ═══
  if (url.pathname === '/api/user/stats' && req.method === 'GET') {
    const user = verifyUser(req);
    if (!user) return sendError(req, res, 401, 'Nicht angemeldet');
    const db = barfinderDB.getDB();
    let stats = db.prepare('SELECT * FROM user_stats WHERE user_id=?').get(user.userId);
    if (!stats) {
      db.prepare('INSERT INTO user_stats (user_id) VALUES (?)').run(user.userId);
      stats = db.prepare('SELECT * FROM user_stats WHERE user_id=?').get(user.userId);
    }
    // Sync favorites count
    const favCount = db.prepare('SELECT COUNT(*) as cnt FROM favorites WHERE user_id=?').get(user.userId).cnt;
    if (favCount !== stats.favorites_count) {
      db.prepare('UPDATE user_stats SET favorites_count=? WHERE user_id=?').run(favCount, user.userId);
      stats.favorites_count = favCount;
    }
    return sendJSON(req, res, 200, stats);
  }

  // ═══ PERSONALISIERTE EMPFEHLUNGEN ═══
  if (url.pathname === '/api/user/recommendations' && req.method === 'GET') {
    const user = verifyUser(req);
    if (!user) return sendError(req, res, 401, 'Nicht angemeldet');
    const db = barfinderDB.getDB();
    let prefs = db.prepare('SELECT * FROM user_preferences WHERE user_id=?').get(user.userId);
    const cats = prefs ? JSON.parse(prefs.preferred_categories || '[]') : [];
    const districts = prefs ? JSON.parse(prefs.preferred_districts || '[]') : [];
    const vibeP = prefs ? prefs.vibe_preference : 'any';
    const radiusKm = prefs ? prefs.radius_km : 3;
    const lat = parseFloat(url.searchParams.get('lat')) || 53.55;
    const lon = parseFloat(url.searchParams.get('lon')) || 9.99;

    // Get favorites to exclude
    const favIds = db.prepare('SELECT place_id FROM favorites WHERE user_id=?').all(user.userId).map(f => f.place_id);
    const viewedIds = db.prepare('SELECT place_id FROM recently_viewed WHERE user_id=?').all(user.userId).map(r => r.place_id);

    // Query places within radius
    const dlat = radiusKm / 111.0;
    const dlon = radiusKm / (111.0 * Math.cos(lat * Math.PI / 180));
    let places = db.prepare(`SELECT * FROM places WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ? LIMIT 200`)
      .all(lat - dlat, lat + dlat, lon - dlon, lon + dlon);

    // Filter by preferred categories
    if (cats.length > 0) {
      places = places.filter(p => cats.includes(p.category));
    }

    // Score and sort
    places = places.map(p => {
      let score = p.community_score || 40;
      if (favIds.includes(p.id)) score -= 20; // Already favorited, lower priority
      if (viewedIds.includes(p.id)) score -= 5;
      if (p.highlight) score += 10;
      return { ...p, recoScore: score };
    });
    places.sort((a, b) => b.recoScore - a.recoScore);

    return sendJSON(req, res, 200, places.slice(0, 20));
  }

  // ═══ SEO: robots.txt ═══
  if (url.pathname === '/robots.txt') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=86400' });
    res.end(`User-agent: *
Allow: /
Disallow: /api/
Disallow: /admin
Disallow: /admin.html

Sitemap: https://oliver-roessling.claw.clawy.io/barfinder/sitemap.xml

# Barfinder Hamburg | Bars, Kneipen & Nightlife in Echtzeit
# Ein Produkt der CAPS & COLLARS GmbH
`);
    return;
  }

  // ═══ SEO: sitemap.xml ═══
  if (url.pathname === '/sitemap.xml') {
    const db = barfinderDB.getDB();
    const places = db.prepare('SELECT slug, updated_at FROM places WHERE slug IS NOT NULL ORDER BY community_score DESC NULLS LAST LIMIT 500').all();
    const baseUrl = 'https://oliver-roessling.claw.clawy.io/barfinder';
    let xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${baseUrl}/</loc>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
`;
    for (const p of places) {
      xml += `  <url>
    <loc>${baseUrl}/#bar/${p.slug}</loc>
    <lastmod>${(p.updated_at || '2025-01-01').split(' ')[0]}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.7</priority>
  </url>
`;
    }
    xml += '</urlset>';
    res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
    res.end(xml);
    return;
  }

  // ═══ SEO: llms.txt ═══
  if (url.pathname === '/llms.txt') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=86400' });
    res.end(`# Barfinder Hamburg
> Echtzeit Vibe Scores fuer Bars, Kneipen & Nightlife in Hamburg

Barfinder ist eine Web App, die Bars, Kneipen, Cocktailbars, Biergaerten und Clubs in Hamburg mit einem Echtzeit VibeScore (0-100) bewertet. Der Score basiert auf Tageszeit, Wochentag, Wetter, Events, Community Bewertungen und Kategorie.

## Features
- VibeScore: Wahrscheinlichkeit auf gute Stimmung und Leute zu treffen
- Echtzeit Wetter Integration (Open-Meteo)
- Event Kalender (Eventbrite, Meetup, Luma, lokale Quellen)
- Community Bewertungen und Favoriten
- Kartenansicht mit Filtern
- Personalisierte Empfehlungen
- Gamification mit Badge System

## Daten
- 4.787+ Locations in Hamburg
- 188+ Community bewertete Bars
- 624+ Events aus mehreren Quellen
- Oeffnungszeiten, Raucherbereiche, Outdoor Seating

## Betreiber
CAPS & COLLARS GmbH
https://capsncollars.com

## API
- GET /api/places?lat=53.55&lon=9.99&radius=3000
- GET /api/highlights
- GET /api/events
- GET /api/weather
- GET /api/network-events
`);
    return;
  }

  // ═══ ADMIN.HTML (JWT-protected) ═══
  if (url.pathname === '/admin.html' || url.pathname === '/admin') {
    // Require valid JWT with admin role
    const token = parseJWT(req);
    if (!token) {
      res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><body><h2>Zugang verweigert</h2><p>Bitte zuerst einloggen.</p><script>setTimeout(()=>location.href="/",2000)</script></body></html>');
      return;
    }
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      if (decoded.role !== 'admin') {
        res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><body><h2>Keine Berechtigung</h2><p>Admin-Zugang erforderlich.</p></body></html>');
        return;
      }
    } catch(e) {
      res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><body><h2>Session abgelaufen</h2><p>Bitte erneut einloggen.</p><script>setTimeout(()=>location.href="/",2000)</script></body></html>');
      return;
    }
    const adminFile = path.join(__dirname, 'admin.html');
    if (fs.existsSync(adminFile)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, no-store' });
      fs.createReadStream(adminFile).pipe(res);
      return;
    }
  }

  // ═══ INTERNAL API (server-to-server, localhost only) ═══
  if (url.pathname.startsWith('/internal/')) {
    const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY;
    if (!INTERNAL_API_KEY) {
      return sendError(req, res, 503, 'Internal API not configured');
    }

    // Verify: localhost only + API key
    const clientIp = getRateLimitKey(req);
    const isLocal = clientIp === '127.0.0.1' || clientIp === '::1' || clientIp === '::ffff:127.0.0.1' || clientIp === 'localhost';
    const providedKey = req.headers['x-internal-key'] || url.searchParams.get('key');

    if (!isLocal) {
      return sendError(req, res, 403, 'Internal API: localhost only');
    }
    if (!providedKey || providedKey.length !== INTERNAL_API_KEY.length || !crypto.timingSafeEqual(Buffer.from(providedKey), Buffer.from(INTERNAL_API_KEY))) {
      return sendError(req, res, 401, 'Invalid API key');
    }

    // ── /internal/bars — All bars with vibe scores
    if (url.pathname === '/internal/bars') {
      try {
        const bars = barfinderDB.getPlaces({});
        const result = bars.map(b => {
          const os = getOpenStatus(b);
          return {
            id: b.id, name: b.name, lat: b.lat, lon: b.lon,
            category: b.category, address: b.address,
            opening_hours: b.opening_hours,
            openStatus: os.status, openLabel: os.label,
            community_score: b.community_score,
            tags: b.tags ? b.tags.split(',').map(t => t.trim()) : [],
            highlight: !!b.highlight,
          };
        });
        return sendJSON(req, res, 200, { count: result.length, bars: result });
      } catch(e) {
        return sendError(req, res, 500, 'Database error');
      }
    }

    // ── /internal/bar/:id — Single bar detail
    if (url.pathname.match(/^\/internal\/bar\/\d+$/)) {
      const id = parseInt(url.pathname.split('/').pop());
      try {
        const bar = barfinderDB.getDB().prepare('SELECT * FROM places WHERE id = ?').get(id);
        if (!bar) return sendError(req, res, 404, 'Bar not found');
        const os = getOpenStatus(bar);
        return sendJSON(req, res, 200, { ...bar, openStatus: os.status, openLabel: os.label });
      } catch(e) {
        return sendError(req, res, 500, 'Database error');
      }
    }

    // ── /internal/stats — Overview statistics
    if (url.pathname === '/internal/stats') {
      try {
        const health = barfinderDB.getHealth();
        return sendJSON(req, res, 200, {
          ...health,
          uptime: Math.floor((Date.now() - SERVER_START_TIME) / 1000),
          memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
        });
      } catch(e) {
        return sendError(req, res, 500, 'Stats error');
      }
    }

    // ── /internal/events — Upcoming events
    if (url.pathname === '/internal/events') {
      try {
        const events = barfinderDB.getEvents({});
        return sendJSON(req, res, 200, { count: events.length, events });
      } catch(e) {
        return sendError(req, res, 500, 'Events error');
      }
    }

    // ── /internal/weather — Current weather data
    if (url.pathname === '/internal/weather') {
      return sendJSON(req, res, 200, weatherCache);
    }

    // ── /internal/recommendations — Top picks per category with variation
    if (url.pathname === '/internal/recommendations') {
      try {
        const lat = parseFloat(url.searchParams.get('lat')) || 53.5511;
        const lon = parseFloat(url.searchParams.get('lon')) || 9.9937;
        const radius = parseInt(url.searchParams.get('radius')) || 5000;
        const count = Math.min(parseInt(url.searchParams.get('count')) || 3, 10);

        const allBars = barfinderDB.getPlaces({ limit: 5000 });
        const { hour, dow } = getHamburgTime();

        // Filter by distance
        const withinRadius = allBars.filter(b => {
          if (!b.lat || !b.lon) return false;
          const d = Math.sqrt((b.lat - lat) ** 2 + (b.lon - lon) ** 2) * 111000;
          b._dist = d;
          return d <= radius;
        });

        // Compute vibe scores
        withinRadius.forEach(b => {
          const vs = computeVibeScore(b);
          b._vibeScore = vs.vibe || 0;
          b._vibeEmoji = vs.vibeEmoji || '';
          b._vibeLabel = vs.vibeLabel || '';
          b._openStatus = getOpenStatus(b);
        });

        // Category groups
        const groups = {
          'top_vibe': { filter: () => true, label: 'Top Vibe' },
          'bars': { filter: b => ['bar','pub','cocktailbar','irish-pub'].includes(b.category), label: 'Beste Bars' },
          'dinner': { filter: b => b.category === 'restaurant', label: 'Dinner' },
          'lunch': { filter: b => ['restaurant','mittagstisch'].includes(b.category), label: 'Mittagstisch' },
          'cafes': { filter: b => b.category === 'cafe', label: 'Cafés' },
          'nightlife': { filter: b => ['nightclub','cocktailbar'].includes(b.category), label: 'Nightlife' },
          'biergarten': { filter: b => b.category === 'biergarten', label: 'Biergärten' },
          'wine': { filter: b => b.category === 'wine', label: 'Weinbars' },
        };

        const seed = Date.now() % 86400000; // Changes daily
        const result = {};

        for (const [key, group] of Object.entries(groups)) {
          let candidates = withinRadius.filter(group.filter);
          // Sort by vibe score
          candidates.sort((a, b) => b._vibeScore - a._vibeScore);
          // Take top N*3 and shuffle with daily seed for variation
          const pool = candidates.slice(0, count * 3);
          // Seeded shuffle: rotate pool based on seed
          const offset = seed % Math.max(pool.length, 1);
          const shuffled = [...pool.slice(offset), ...pool.slice(0, offset)];
          // Pick top count, preferring open places
          const open = shuffled.filter(b => b._openStatus.status === 'open' || b._openStatus.status === 'likely_open');
          const picks = open.length >= count ? open.slice(0, count) : [...open, ...shuffled.filter(b => !open.includes(b))].slice(0, count);

          result[key] = {
            label: group.label,
            places: picks.map(b => ({
              name: b.name, lat: b.lat, lon: b.lon,
              category: b.category, address: b.address,
              vibeScore: b._vibeScore, vibeEmoji: b._vibeEmoji,
              openStatus: b._openStatus.status, openLabel: b._openStatus.label,
              community_score: b.community_score,
              distance_m: Math.round(b._dist),
              tags: b.tags ? b.tags.split(',').map(t => t.trim()) : [],
            })),
          };
        }

        return sendJSON(req, res, 200, result);
      } catch(e) {
        return sendError(req, res, 500, 'Recommendations error: ' + e.message);
      }
    }

    return sendError(req, res, 404, 'Unknown internal endpoint');
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => console.log(`Barfinder running on port ${PORT}`));

// ═══ GRACEFUL SHUTDOWN ═══
function gracefulShutdown(signal) {
  console.log(`\n${signal} received. Shutting down gracefully...`);
  server.close(() => {
    console.log('All connections closed. Exiting.');
    process.exit(0);
  });
  // Force exit after 5s if connections don't close
  setTimeout(() => { console.log('Forcing exit.'); process.exit(1); }, 5000);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ═══ UNIFIED OPEN STATUS — Single source of truth ═══
function getOpenStatus(place) {
  const oh = place.opening_hours || '';
  const cat = place.category || '';
  const isOpen = isOpenSmart(oh, cat);
  const { hour } = getHamburgTime();
  const hasHours = !!oh;
  
  if (isOpen === true) {
    // Check if closing soon
    const closeMin = getClosingSoonMinutes(oh);
    if (closeMin && closeMin <= 60) {
      return { status: 'closing_soon', closeMin, label: 'Schließt in ' + closeMin + 'min', emoji: '⚠️' };
    }
    return { status: 'open', label: 'Offen', emoji: '🟢' };
  }
  
  if (isOpen === false) {
    // Definitely closed — but might open later today?
    if (hour < 22 && hasHours && couldOpenLaterToday(oh)) {
      return { status: 'opens_later', label: 'Öffnet später', emoji: '📅' };
    }
    return { status: 'closed', label: 'Heute geschlossen', emoji: '🔴' };
  }
  
  // Heuristic-based results
  if (isOpen === 'likely') {
    return { status: 'likely_open', label: 'Vermutlich offen', emoji: '🟡' };
  }
  
  if (isOpen === 'likely_closed') {
    return { status: 'closed', label: 'Heute geschlossen', emoji: '🔴' };
  }
  
  // null = truly unknown (no opening_hours, no heuristic)
  return { status: 'unknown', label: 'Status unklar', emoji: '🟡' };
}

function getClosingSoonMinutes(oh) {
  if (!oh) return null;
  const { hour, minute, dow } = getHamburgTime();
  const nowMin = hour * 60 + minute;
  const days = ['Su','Mo','Tu','We','Th','Fr','Sa'];
  const today = days[dow];
  
  const parts = oh.split(';').map(s => s.trim());
  for (const part of parts) {
    // Check if this rule applies today
    if (part.includes('-') && /[A-Z][a-z]/.test(part)) {
      if (!part.includes(today)) {
        // Check ranges
        const rangeMatch = part.match(/([A-Z][a-z])-([A-Z][a-z])/);
        if (rangeMatch) {
          const dayOrder = {'Su':0,'Mo':1,'Tu':2,'We':3,'Th':4,'Fr':5,'Sa':6};
          const from = dayOrder[rangeMatch[1]], to = dayOrder[rangeMatch[2]], cur = dayOrder[today];
          if (from !== undefined && to !== undefined && cur !== undefined) {
            const inRange = from <= to ? (cur >= from && cur <= to) : (cur >= from || cur <= to);
            if (!inRange) continue;
          }
        } else continue;
      }
    }
    
    const timeMatch = part.match(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/);
    if (timeMatch) {
      let closeMin = parseInt(timeMatch[3]) * 60 + parseInt(timeMatch[4]);
      if (closeMin < parseInt(timeMatch[1]) * 60) closeMin += 1440; // after midnight
      let nowAdj = nowMin;
      if (nowMin < parseInt(timeMatch[1]) * 60 && closeMin > 1440) nowAdj += 1440;
      
      const diff = closeMin - nowAdj;
      if (diff > 0 && diff <= 60) return diff;
    }
  }
  return null;
}

function couldOpenLaterToday(oh) {
  if (!oh) return false;
  const { hour, dow } = getHamburgTime();
  const days = ['Su','Mo','Tu','We','Th','Fr','Sa'];
  const today = days[dow];
  
  const parts = oh.split(';').map(s => s.trim());
  for (const part of parts) {
    const timeMatch = part.match(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/);
    if (!timeMatch) continue;
    const openHour = parseInt(timeMatch[1]);
    if (openHour > hour) {
      // Check if this rule applies today
      if (/[A-Z][a-z]/.test(part) && !part.includes(today)) {
        const rangeMatch = part.match(/([A-Z][a-z])-([A-Z][a-z])/);
        if (!rangeMatch) continue;
        const dayOrder = {'Su':0,'Mo':1,'Tu':2,'We':3,'Th':4,'Fr':5,'Sa':6};
        const from = dayOrder[rangeMatch[1]], to = dayOrder[rangeMatch[2]], cur = dayOrder[today];
        const inRange = from <= to ? (cur >= from && cur <= to) : (cur >= from || cur <= to);
        if (!inRange) continue;
      }
      return true;
    }
  }
  return false;
}
