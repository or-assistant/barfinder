const http = require('http');
const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');

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

// ═══ GZIP RESPONSE HELPER ═══
function sendJSON(req, res, statusCode, data, cacheHeader) {
  const json = JSON.stringify(data);
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
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

// ═══ LIVE GOOGLE RATING SCRAPER ═══
const SCRAPE_UAS = config.USER_AGENTS;

function scrapeGoogleRating(name, address) {
  const query = encodeURIComponent(`${name} ${address || ''} Hamburg`);
  const pb = '!4m12!1m3!1d4005.9771522653964!2d9.9!3d53.55!2m3!1f0!2f0!3f0!3m2!1i1125!2i976!4f13.1!7i20!10b1!12m6!2m3!5m1!6e2!20e3!10b1!16b1!19m3!2m2!1i392!2i106!20m61!2m2!1i203!2i100!3m2!2i4!5b1!6m6!1m2!1i86!2i86!1m2!1i408!2i200!7m46!1m3!1e1!2b0!3e3!1m3!1e2!2b1!3e2!1m3!1e2!2b0!3e3!1m3!1e3!2b0!3e3!1m3!1e4!2b0!3e3!1m3!1e8!2b0!3e3!1m3!1e3!2b1!3e2!1m3!1e9!2b1!3e2!1m3!1e10!2b0!3e3!1m3!1e10!2b1!3e2!1m3!1e10!2b0!3e4!2b1!4b1!9b0!22m6!1sa9fVWea_MsX8adX8j8AE%3A1!2zMWk6Mix0OjExODg3LGU6MSxwOmE5ZlZXZWFfTXNYOGFkWDhqOEFFOjE!7e81!12e3!17sa9fVWea_MsX8adX8j8AE%3A564!18e15!24m15!2b1!5m4!2b1!3b1!5b1!6b1!10m1!8e3!17b1!24b1!25b1!26b1!30m1!2b1!36b1!26m3!2m2!1i80!2i92!30m28!1m6!1m2!1i0!2i0!2m2!1i458!2i976!1m6!1m2!1i1075!2i0!2m2!1i1125!2i976!1m6!1m2!1i0!2i0!2m2!1i1125!2i20!1m6!1m2!1i0!2i956!2m2!1i1125!2i976!37m1!1e81!42b1!47m0!49m1!3b1';
  const url = `https://www.google.de/search?tbm=map&tch=1&hl=de&q=${query}&pb=${pb}`;
  const ua = SCRAPE_UAS[Math.floor(Math.random() * SCRAPE_UAS.length)];

  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': ua } }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          let d = data.split('/*""*/')[0];
          const jend = d.lastIndexOf('}');
          if (jend < 0) { resolve(null); return; }
          d = d.substring(0, jend + 1);
          const parsed = JSON.parse(d);
          const jdata = JSON.parse(parsed.d.substring(4));
          let info = jdata[0]?.[1]?.[0]?.[14] || jdata[0]?.[1]?.[1]?.[14];
          if (!info) { resolve(null); return; }
          const rating = info[4]?.[7];
          const rating_n = info[4]?.[8];
          resolve({ name, rating, rating_n: rating_n || null });
        } catch(e) { resolve(null); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ═══════════════════════════════════════════════════════════════
// 🌤️ WEATHER CACHE (Open-Meteo, refreshed every 30min)
// ═══════════════════════════════════════════════════════════════
let weatherCache = { current: null, hourly: null, fetchedAt: 0 };

function fetchWeather() {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${config.WEATHER_LAT}&longitude=${config.WEATHER_LON}&current_weather=true&hourly=precipitation_probability,temperature_2m,weathercode&timezone=Europe/Berlin&forecast_days=2`;
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          weatherCache = {
            current: data.current_weather || null,
            hourly: data.hourly || null,
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
// 🌟 GOOGLE RATINGS & YELP CACHE LOADING
// ═══════════════════════════════════════════════════════════════
let googleRatingsCache = {};
let yelpCache = {};
let yelpReviewsCache = [];
let hamburgEventsCache = {};

try {
  // Load from batch ratings scraper (primary) or populartimes cache (fallback)
  const ratingsFile = fs.existsSync('./google_ratings_cache.json') ? './google_ratings_cache.json' : 
                      fs.existsSync('./populartimes_cache.json') ? './populartimes_cache.json' :
                      fs.existsSync('./google_popular_times_cache.json') ? './google_popular_times_cache.json' : null;
  if (ratingsFile) {
    const gData = JSON.parse(fs.readFileSync(ratingsFile, 'utf8'));
    // Support both array format [{name,rating}] and object format {bars:{}}
    if (Array.isArray(gData)) {
      gData.forEach(b => { if(b.name && b.rating) googleRatingsCache[b.name.toLowerCase()] = b; });
    } else {
      googleRatingsCache = gData.bars || gData;
    }
    console.log(`✅ Google ratings loaded: ${Object.keys(googleRatingsCache).length} bars from ${ratingsFile}`);
  }
} catch(e) { console.log('⚠️ Google ratings cache not available:', e.message); }

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

// Fuzzy name matching for Google/Yelp/OpenTable data
function fuzzyMatchRating(placeName) {
  if (!placeName) return null;
  const norm = s => (s||'').toLowerCase().replace(/[^a-zäöüß0-9]/g, '');
  const pNorm = norm(placeName);
  
  // Try Google cache
  for (const [key, val] of Object.entries(googleRatingsCache)) {
    const kNorm = norm(val.name || key);
    if (pNorm === kNorm || pNorm.includes(kNorm) || kNorm.includes(pNorm)) {
      return { source: 'google', rating: val.rating, reviewCount: val.reviewCount };
    }
  }
  
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

function ratingVibeBonus(match) {
  if (!match) return 0;
  let bonus = 0;
  const r = match.rating || 0;
  const rc = match.reviewCount || 0;
  if (r >= 4.5) bonus += 10;
  else if (r >= 4.0) bonus += 5;
  else if (r >= 3.5) bonus += 2;
  if (rc > 500) bonus += 5;
  else if (rc > 200) bonus += 3;
  else if (rc > 50) bonus += 1;
  return bonus;
}

const HIGHLIGHTS = JSON.parse(fs.readFileSync(path.join(__dirname, "highlights.json"), "utf8"));

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
      return hour >= 8 && hour < 19;
    }

    // Bars/Pubs/Cocktailbars: Mo-Do 18-01, Fr-Sa 18-03, So 18-00
    if (['bar','cocktailbar','pub','irish-pub','wine','weinbar'].includes(category)) {
      if (isWeekend) {
        return hour >= 18 || hour < 3;
      } else if (isSunday) {
        return hour >= 18; // So bis Mitternacht
      } else {
        return hour >= 18 || hour < 1; // Mo-Do 18-01
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
// 🎉 VIBE SCORE — "Wie wahrscheinlich triffst du Leute?"
// ═══════════════════════════════════════════════════════════════

function computeVibeScore(place, isHighlight = false) {
  const { hour, minute, dow } = getHamburgTime();
  // Use time BLOCKS for stability — score only changes a few times per day
  // Morning (6-12), Afternoon (12-17), Early Evening (17-20), Prime Time (20-24), Late Night (0-6)
  const timeBlock = hour < 6 ? 'latenight' : hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : hour < 20 ? 'earlyevening' : 'primetime';
  const timeDecimal = hour + minute / 60;
  const cat = (place.category || '').toLowerCase();
  const desc = ((place.description || '') + ' ' + (place.name || '')).toLowerCase();
  const isWeekend = (dow === 5 || dow === 6); // Fr/Sa
  const open = isOpenNow(place.opening_hours);
  if (open === false) return { vibe: 0, vibeLabel: 'Geschlossen', vibeEmoji: '😴' };

  // Restaurants, Frühstück, Mittagstisch ohne Bar-Charakter: kein VibeScore
  const noVibeCats = ['restaurant', 'fruehstueck', 'mittagstisch', 'dinner'];
  if (noVibeCats.includes(cat) && !/bar|lounge|cocktail/i.test(desc)) {
    return { vibe: 0, vibeLabel: '', vibeEmoji: '🍽️' };
  }

  let vibe = 0;

  // ═══ ABSOLUTE VIBE SCORE ═══
  // This is NOT relative ("best option right now") but ABSOLUTE:
  // "What is the real probability of meeting people here?"
  // 80-100 = Packed bar on Friday night, everyone talking
  // 50-70  = Good evening crowd, easy to chat
  // 30-50  = Some people, possible but not guaranteed
  // 10-30  = Quiet, mostly couples/solo, unlikely to meet anyone
  // 0-10   = Dead or closed

  // ── 1. SOCIAL CATEGORY BASE ──
  // Absolute social potential of this type of place at its BEST
  const socialBase = {
    'pub': 18, 'irish-pub': 20, 'cocktailbar': 16, 'bar': 16,
    'wine': 18, 'lounge': 14, 'biergarten': 20,
    'nightclub': 15, 'sports_bar': 16, 'karaoke': 14,
    'jazz_club': 12, 'brewery': 16, 'taproom': 16, 'dance_club': 12,
    'cafe': 5, 'restaurant': 4
  };
  vibe += (socialBase[cat] || 10);

  // ── 2. TIME × DAY MATRIX — The core of absolute scoring ──
  // Peak = Friday/Saturday 20-23h → up to +45
  // Worst = Sunday/Monday daytime → +2
  // Time blocks → stable score (doesn't change every minute)
  const timeBaseMap = { primetime: 45, earlyevening: 30, latenight: 35, afternoon: 8, morning: 2 };
  let timeBase = timeBaseMap[timeBlock] || 5;
  
  vibe += timeBase; // Day dampening handled globally in step 10
  
  // Cafés and restaurants get even less from time (they're not evening social spots)
  if (cat === 'cafe' || cat === 'restaurant') {
    vibe -= Math.round(timeBase * 0.5); // Halve the time bonus
  }

  // ── 4. EVENT BOOST — Events = guaranteed people ──
  const placeKey = (place.name || '').toLowerCase().replace(/[^a-z0-9]/g, '_');
  const todayEvents = getTodaysEvents(placeKey, dow, hour);
  if (todayEvents.length > 0) {
    vibe += Math.min(10, 5 + todayEvents.length * 2); // Cap at +10 for events today
  }
  if (place.has_events || place.event_count > 0) vibe += 3;

  // ── 5. DESCRIPTION KEYWORDS — Social signals ──
  // Keywords add small absolute bonuses (max ~15 total from keywords)
  const socialKeywords = [
    [/stimmung|atmosphäre|vibe|gesellig/i, 3],
    [/live.?musik|open.?mic|jam.?session/i, 4],
    [/tresen|theke|bar.?hocker|standing/i, 3],
    [/kiez|kultig|kult|institution/i, 3],
    [/after.?work|happy.?hour|feierabend/i, 5],
    [/wein|wine|tasting|verkostung|weinbar/i, 4],
    [/stammkneipe|stammtisch|regulars/i, 4],
    [/draußen|terrasse|biergarten|outdoor/i, 3],
    [/fußball|bundesliga|champions|sport/i, 3],
    [/small.?talk|kennenlernen|flirt|dating/i, 4],
    [/community|szene|treffpunkt/i, 3],
  ];
  let keywordBonus = 0;
  for (const [rx, pts] of socialKeywords) {
    if (rx.test(desc)) keywordBonus += pts;
  }
  vibe += Math.min(keywordBonus, 12); // Cap keyword bonus at 12

  // Anti-social signals
  if (/ruhig|leise|chill|gemütlich.*lesen|arbeit|laptop|coworking/i.test(desc)) vibe -= 5;

  // ── 6. HIGHLIGHT BONUS ──
  if (isHighlight) vibe += 3;

  // ── 7. SMOKER BARS — often very social (regulars, chats) ──
  if (place.smoker) vibe += 6;

  // ── 8. GOOGLE/YELP RATING + POPULARITY ──
  const ratingMatch = fuzzyMatchRating(place.name);
  if (ratingMatch) {
    vibe += ratingVibeBonus(ratingMatch);
    // Review count as popularity proxy: more reviews = more visitors = more social
    const reviews = ratingMatch.reviewCount || 0;
    if (reviews > 500) vibe += 6;
    else if (reviews > 200) vibe += 4;
    else if (reviews > 50) vibe += 2;
  }

  // ── 9. BUSYNESS BOOST — busy places = more people to meet ──
  const bn = estimateBusyness(place, dow, hour);
  if (bn.busyness > 60) vibe += 4;
  else if (bn.busyness > 40) vibe += 2;

  // ── 9b. WEATHER FACTOR — real data from Open-Meteo ──
  const wf = getWeatherFactor(place);
  if (wf.multiplier !== 1.0) {
    // Weather shifts the score: rain → indoor bars boost, cold → everyone stays home
    vibe = Math.round(vibe * wf.multiplier);
  }

  // ── 9c. LEARNED VIBE BONUS — from user feedback in DB ──
  try {
    const db = require('./db');
    const learnedBonus = db.computeLearnedVibeBonus(place._dbId || null);
    if (learnedBonus) vibe += Math.round(learnedBonus);
  } catch(e) { /* db not available */ }

  // ── 10. GLOBAL DAY/TIME DAMPENING ──
  // Stable block-based dampening — score only changes at block boundaries
  const dampenMatrix = {
    // dow: { timeBlock: multiplier }
    5: { primetime: 1.0, earlyevening: 0.85, latenight: 0.7, afternoon: 0.4, morning: 0.3 }, // Friday
    6: { primetime: 1.0, earlyevening: 0.85, latenight: 0.7, afternoon: 0.4, morning: 0.3 }, // Saturday
    4: { primetime: 0.85, earlyevening: 0.75, latenight: 0.5, afternoon: 0.4, morning: 0.3 }, // Thursday
    3: { primetime: 0.75, earlyevening: 0.65, latenight: 0.45, afternoon: 0.4, morning: 0.3 }, // Wednesday
    2: { primetime: 0.55, earlyevening: 0.45, latenight: 0.35, afternoon: 0.3, morning: 0.25 }, // Tuesday
    1: { primetime: 0.45, earlyevening: 0.38, latenight: 0.3, afternoon: 0.25, morning: 0.2 },  // Monday
    0: { primetime: 0.45, earlyevening: 0.38, latenight: 0.3, afternoon: 0.3, morning: 0.25 },  // Sunday
  };
    let dayTimeMultiplier = (dampenMatrix[dow] || dampenMatrix[2])[timeBlock] || 0.4;
  
  vibe = vibe * dayTimeMultiplier;
  // Clamp + slight randomization
  const nameHash = (place.name || '').split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  vibe += (nameHash % 7) - 3;
  vibe = Math.max(0, Math.min(100, Math.round(vibe)));

  // Labels
  let vibeLabel, vibeEmoji;
  if (vibe >= 75) { vibeLabel = 'Hier ist Action!'; vibeEmoji = '🔥🎉'; }
  else if (vibe >= 55) { vibeLabel = 'Gute Chancen'; vibeEmoji = '😎'; }
  else if (vibe >= 40) { vibeLabel = 'Etwas los'; vibeEmoji = '👀'; }
  else if (vibe >= 25) { vibeLabel = 'Ruhig bis mäßig'; vibeEmoji = '🤷'; }
  else if (vibe >= 10) { vibeLabel = 'Eher leer'; vibeEmoji = '😐'; }
  else { vibeLabel = 'Tote Hose'; vibeEmoji = '😴'; }

  return { vibe, vibeLabel, vibeEmoji };
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
        results.push({ ...h, _dist: dist, hotScore: hs.score, hotLabel: hs.label, hotColor: hs.color, has_events: hs.has_events, event_count: hs.event_count, vibeScore: vs.vibe, vibeLabel: vs.vibeLabel, vibeEmoji: vs.vibeEmoji, googleRating: rm?.rating || null, googleReviews: rm?.reviewCount || null, ratingSource: rm?.source || null, estimatedBusyness: bn.busyness, busynessLabel: bn.busynessLabel, busynessColor: bn.busynessColor, peakInfo: getPeakInfo(h) });
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
          results.push({ ...p, _dist: dist, hotScore: hs.score, hotLabel: hs.label, hotColor: hs.color, has_events: hs.has_events, event_count: hs.event_count, vibeScore: vs.vibe, vibeLabel: vs.vibeLabel, vibeEmoji: vs.vibeEmoji, googleRating: rm?.rating || null, googleReviews: rm?.reviewCount || null, ratingSource: rm?.source || null, estimatedBusyness: bn.busyness, busynessLabel: bn.busynessLabel, busynessColor: bn.busynessColor, peakInfo: getPeakInfo(p) });
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

  // ── 3. Google Rating boost ──
  const ratingMatch = fuzzyMatchRating(place.name);
  if (ratingMatch) {
    const r = ratingMatch.rating || 0;
    if (r >= 4.5) score *= 1.10;
    else if (r >= 4.0) score *= 1.05;
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
    // Check multi-word (e.g. "st. pauli")
    if (qLow.includes(name)) {
      stadtteilFilter = bounds;
      // Entferne Stadtteil-Wörter aus Query
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

  // ── 3. Alle bekannten Places sammeln (Highlights + Cache) ──
  let allPlaces = [...HIGHLIGHTS];
  // Overpass-Cache hinzufügen
  for (const [, cached] of Object.entries(cache)) {
    if (cached && cached.data) {
      for (const p of cached.data) {
        if (p.name && !allPlaces.find(x => x.name?.toLowerCase() === p.name.toLowerCase())) {
          allPlaces.push(p);
        }
      }
    }
  }

  // ── 4. Scoring ──
  const scored = allPlaces.map(p => {
    let score = 0;
    const pName = (p.name || '').toLowerCase();
    const pCat = (p.category || '').toLowerCase();
    const pAddr = (p.address || '').toLowerCase();
    const pDesc = (p.description || '').toLowerCase();
    const pTags = ((p.tags || []).join(' ') + ' ' + (p.keywords || []).join(' ')).toLowerCase();
    const searchText = `${pName} ${pCat} ${pAddr} ${pDesc} ${pTags}`;

    // a) Name fuzzy match (höchste Priorität)
    const nameScore = fuzzyScore(cleanQuery || qLow, pName);
    score += nameScore * 2;

    // b) Adresse/Beschreibung fuzzy match
    if (cleanQuery) {
      score += fuzzyScore(cleanQuery, pAddr) * 0.5;
      score += fuzzyScore(cleanQuery, pDesc) * 0.3;
      score += fuzzyScore(cleanQuery, pTags) * 0.4;
    }

    // c) Semantische Kategorie-Treffer
    if (matchCategories.length > 0) {
      if (matchCategories.includes(pCat)) score += 60;
      // Auch Cuisine/Tags checken
      const pCuisine = (p.cuisine || '').toLowerCase();
      if (matchCategories.some(c => pCuisine.includes(c) || pTags.includes(c))) score += 40;
    }

    // d) Property-Match (outdoor_seating, smoker)
    if (matchProp === 'outdoor_seating' && p.outdoor_seating) score += 50;
    if (matchProp === 'smoker' && p.smoker) score += 50;

    // e) Tag-Match
    if (matchTag && (pTags.includes(matchTag) || pDesc.includes(matchTag) || (p.liveMusic && matchTag === 'live-musik'))) score += 40;

    // f) Mood-Match
    if (matchMood === 'quiet' && /ruhig|gemütlich|chill|cozy|entspannt/i.test(pDesc)) score += 30;
    if (matchMood === 'loud' && /laut|wild|party|stimmung|action|voll/i.test(pDesc)) score += 30;

    // g) Stadtteil-Filter (muss in Bounding-Box sein)
    if (stadtteilFilter) {
      if (p.lat && p.lon &&
          p.lat >= stadtteilFilter.latMin && p.lat <= stadtteilFilter.latMax &&
          p.lon >= stadtteilFilter.lonMin && p.lon <= stadtteilFilter.lonMax) {
        score += 40; // Stadtteil-Bonus
      } else {
        score -= 100; // Außerhalb → stark abwerten
      }
    }

    // h) Einzelwort-Suche im gesamten Text
    for (const w of remainingWords) {
      if (w.length >= 2 && searchText.includes(w)) score += 15;
    }

    return { ...p, _searchScore: score };
  });

  // Nur Treffer mit positivem Score
  let results = scored.filter(p => p._searchScore > 10);

  // ── 5. Enrichment (isOpen, vibe, distance, ratings) ──
  results = results.map(p => {
    const isHighlight = HIGHLIGHTS.some(h => h.name?.toLowerCase() === p.name?.toLowerCase());
    const vs = computeVibeScore(p, isHighlight);
    const dist = haversine(lat, lon, p.lat, p.lon);
    const rm = fuzzyMatchRating(p.name);
    const bn = estimateBusyness(p, getHamburgTime().dow, getHamburgTime().hour);
    return {
      ...p,
      _dist: dist,
      isOpen: isOpenSmart(p.opening_hours, p.category),
      vibeScore: vs.vibe,
      vibeLabel: vs.vibeLabel,
      vibeEmoji: vs.vibeEmoji,
      hotScore: computeHotScore(p, isHighlight).score,
      googleRating: rm?.rating || null,
      googleReviews: rm?.reviewCount || null,
      estimatedBusyness: bn.busyness,
      busynessLabel: bn.busynessLabel,
      busynessColor: bn.busynessColor,
      peakInfo: getPeakInfo(p),
      newlyAdded: false,
    };
  });

  // ── 6. Sortierung: Relevanz, dann isOpen, dann Entfernung ──
  results.sort((a, b) => {
    // Primär: Suchscore
    const scoreDiff = b._searchScore - a._searchScore;
    if (Math.abs(scoreDiff) > 20) return scoreDiff;
    // Sekundär: Offene Bars bevorzugen
    const aOpen = a.isOpen === true ? 1 : 0;
    const bOpen = b.isOpen === true ? 1 : 0;
    if (aOpen !== bOpen) return bOpen - aOpen;
    // Tertiär: Entfernung
    return (a._dist || 99999) - (b._dist || 99999);
  });

  // ── 7. Auto-Nachladen disabled (eigene DB ist Primärquelle) ──
  if (false) {
    try {
      const newPlaces = [];
      if (newPlaces.length > 0) {
        for (const np of newPlaces) {
          if (results.find(r => r.name?.toLowerCase() === np.name?.toLowerCase())) continue;
          if (allPlaces.find(r => r.name?.toLowerCase() === np.name?.toLowerCase())) continue;
          const isHighlight = false;
          const vs = computeVibeScore(np, isHighlight);
          const dist = haversine(lat, lon, np.lat, np.lon);
          const rm = fuzzyMatchRating(np.name);
          const bn = estimateBusyness(np, getHamburgTime().dow, getHamburgTime().hour);
          results.push({
            ...np,
            _dist: dist,
            _searchScore: 50,
            isOpen: isOpenSmart(np.opening_hours, np.category),
            vibeScore: vs.vibe,
            vibeLabel: vs.vibeLabel,
            vibeEmoji: vs.vibeEmoji,
            hotScore: computeHotScore(np, isHighlight).score,
            googleRating: rm?.rating || null,
            googleReviews: rm?.reviewCount || null,
            estimatedBusyness: bn.busyness,
            busynessLabel: bn.busynessLabel,
            busynessColor: bn.busynessColor,
            peakInfo: getPeakInfo(np),
            newlyAdded: true,
          });
        }
        console.log(`🔍 Auto-Nachladen: ${newPlaces.length} neue Treffer für "${query}"`);
      }
    } catch (e) {
      console.log('⚠️ Overpass auto-reload failed:', e.message);
    }
  }

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

  // ═══ STATIC FILES ═══
  if (url.pathname === '/' || url.pathname === '/index.html' || url.pathname.startsWith('/v')) {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache', 'Expires': '0'
    });
    fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);
    return;
  }

  // ═══ ENHANCED HEALTH ENDPOINT ═══
  if (url.pathname === '/api/health' && req.method === 'GET') {
    try {
      const uptimeMs = Date.now() - SERVER_START_TIME;
      const uptimeSec = Math.floor(uptimeMs / 1000);
      const cacheFiles = [
        'google_ratings_cache.json', 'yelp_cache.json', 'yelp_reviews_cache.json',
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
        googleRatings: Object.keys(googleRatingsCache).length,
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

  if (url.pathname === '/api/places') {
    const lat = parseFloat(url.searchParams.get('lat')) || config.DEFAULT_LAT;
    const lon = parseFloat(url.searchParams.get('lon')) || config.DEFAULT_LON;
    const radius = parseInt(url.searchParams.get('radius')) || 5000;
    const category = url.searchParams.get('category') || 'all';
    try {
      // Own DB only — no Overpass dependency
      let places = [];
      HIGHLIGHTS.forEach(h => {
        if (!h.lat || !h.lon) return;
        const dist = haversine(lat, lon, h.lat, h.lon);
        if (dist > radius) return;
        if (category !== 'all' && h.category !== category) return;
        const hs = computeHotScore(h, true);
        const vs = computeVibeScore(h, true);
        const rm = fuzzyMatchRating(h.name);
        const bn = estimateBusyness(h, getHamburgTime().dow, getHamburgTime().hour);
        places.push({ ...h, _dist: dist, isOpen: isOpenSmart(h.opening_hours, h.category), openStatus: getOpenStatus(h), hotScore: hs.score, vibeScore: vs.vibe, vibeLabel: vs.vibeLabel, vibeEmoji: vs.vibeEmoji, has_events: hs.has_events, googleRating: rm?.rating || null, googleReviews: rm?.reviewCount || null, ratingSource: rm?.source || null, estimatedBusyness: bn.busyness, busynessLabel: bn.busynessLabel, busynessColor: bn.busynessColor, peakInfo: getPeakInfo(h) });
      });
      places.sort((a, b) => (b.vibeScore || 0) - (a.vibeScore || 0));
      const total = places.length;
      sendJSON(req, res, 200, { count: places.length, total, places }, 'public, max-age=30');
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
      const events = getEventsToday();
      sendJSON(req, res, 200, { today: events, all: STATIC_EVENTS }, 'public, max-age=120');
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
      { name:'Google Popular Times', icon:'📊', description:'Auslastungsdaten & Stoßzeiten von Google Maps', priority:3, status: stat(base+'google_popular_times_cache.json')?'ok':'pending', statusText: stat(base+'google_popular_times_cache.json')?'Cache vorhanden':'In Entwicklung', count: count(base+'google_popular_times_cache.json'), lastRun: stat(base+'google_popular_times_cache.json'), error: stat(base+'google_popular_times_cache.json')?null:'Scraper wird gebaut' },
      { name:'Event Pipeline (RSS+Tourism)', icon:'📡', description:'Google News, Abendblatt, Hamburg Tourism, Meetup — RSS & HTML Scraper', priority:2, status: stat(base+'events_pipeline_cache.json')?'ok':'error', statusText: stat(base+'events_pipeline_cache.json')?'Cache aktuell':'Kein Cache', count: count(base+'events_pipeline_cache.json'), lastRun: stat(base+'events_pipeline_cache.json') },
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

  // ═══ REFRESH SINGLE PLACE (live Google Rating scrape) ═══
  if (url.pathname === '/api/refresh-place') {
    const name = url.searchParams.get('name');
    if (!name) { res.writeHead(400, {'Content-Type':'application/json'}); res.end('{"error":"name required"}'); return; }
    
    try {
      const rating = await scrapeGoogleRating(name);
      
      // Update in-memory cache
      if (rating && rating.rating) {
        googleRatingsCache[name.toLowerCase()] = rating;
        
        // Persist to disk
        try {
          const cacheFile = './google_ratings_cache.json';
          let existing = [];
          if (fs.existsSync(cacheFile)) {
            existing = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
            if (!Array.isArray(existing)) existing = [];
          }
          const idx = existing.findIndex(e => e.name && e.name.toLowerCase() === name.toLowerCase());
          const entry = { name: rating.name || name, rating: rating.rating, rating_n: rating.rating_n || null, updated: new Date().toISOString() };
          if (idx >= 0) existing[idx] = entry; else existing.push(entry);
          fs.writeFileSync(cacheFile, JSON.stringify(existing, null, 2));
        } catch(e) { console.log('⚠️ Could not persist rating:', e.message); }
      }
      
      sendJSON(req, res, 200, { ok: true, name, rating: rating || null }, 'no-store');
    } catch(e) {
      console.log('❌ refresh-place error:', e.message);
      sendError(req, res, 500, e.message);
    }
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

  // ═══ AFTERWORK TODAY ═══
  if (url.pathname === '/api/afterwork/today') {
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Berlin' }));
    const dayOfWeek = now.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
    const todayLocations = afterworkSchedule.locations.filter(loc => loc.days.includes(dayOfWeek));
    
    // Match with highlights.json places
    const results = todayLocations.map(loc => {
      const place = highlights.find(p => p.name === loc.name);
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

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ day: dayOfWeek, dayName: ['Sonntag','Montag','Dienstag','Mittwoch','Donnerstag','Freitag','Samstag'][dayOfWeek], count: results.length, locations: results }));
    return;
  }

  // ═══ AFTERWORK FULL SCHEDULE ═══
  if (url.pathname === '/api/afterwork/schedule') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
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

    // Gewichtung: Google-Rating bevorzugen
    candidates = candidates.map(h => {
      const rm = fuzzyMatchRating(h.name);
      const rating = rm?.rating || 0;
      let weight = 1;
      if (rating >= 4.5) weight = 4;
      else if (rating >= 4.0) weight = 3;
      else if (rating >= 3.5) weight = 2;
      return { ...h, _weight: weight, _rating: rating };
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
        googleRating: rm?.rating || null,
        googleReviews: rm?.reviewCount || null,
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
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ results: [], query: q }));
      return;
    }

    try {
      const results = await semanticSearch(q, lat, lon);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify({ results, query: q }));
    } catch (e) {
      console.log('❌ search error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message, results: [] }));
    }
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => console.log(`Barfinder running on port ${PORT}`));

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
  
  // null = unknown
  if (hour >= 22 || hour < 6) {
    return { status: 'closed', label: 'Heute geschlossen', emoji: '🔴' };
  }
  return { status: 'unknown', label: 'Status unbekannt', emoji: '❓' };
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
