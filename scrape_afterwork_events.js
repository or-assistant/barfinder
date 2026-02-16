#!/usr/bin/env node
/**
 * Afterwork Events Scraper for Hamburg
 * Searches known Hamburg afterwork sources and event pages
 */
const https = require('https');
const fs = require('fs');

const CACHE_FILE = 'afterwork_events_cache.json';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

function fetchUrl(url, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : require('http');
    const req = proto.get(url, { headers: { 'User-Agent': USER_AGENT }, timeout }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location, timeout).then(resolve).catch(reject);
      }
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function smryFetch(url) {
  return fetchUrl('https://smry.ai/proxy?url=' + encodeURIComponent(url), 20000);
}

async function scrapeKnownAfterworkEvents() {
  const events = [];
  
  // Known recurring Afterwork events in Hamburg
  const knownRecurring = [
    {
      title: "Büroschluss Afterwork @ Ruby Lotti",
      description: "Afterwork-Party auf der Rooftop-Terrasse — DJs, Cocktails, Feierabend-Vibes",
      location: "Ruby Lotti, Rödingsmarkt 9, Altstadt",
      recurrence: "Jeden Donnerstag",
      url: "https://www.ruby-hotels.com/hamburg-lotti",
      price: "Eintritt frei",
      category: "afterwork",
      source: "manual-research"
    },
    {
      title: "FEIERABEND — Hamburgs Afterwork-Party",
      description: "Hamburgs größte Afterwork-Party — wechselnde Locations, DJs, Drinks",
      location: "Wechselnde Locations, Hamburg",
      recurrence: "Monatlich",
      url: "https://www.eventbrite.de/o/feierabend-hamburg",
      category: "afterwork",
      source: "eventbrite"
    },
    {
      title: "Afterwork Sky Bar Airport Plaza",
      description: "Afterwork donnerstags in der Airport Plaza — Sky Bar mit Flughafen-Panorama",
      location: "Airport Plaza, Flughafenstraße 1-3",
      recurrence: "Jeden Donnerstag",
      url: "",
      price: "Eintritt frei",
      category: "afterwork",
      source: "manual-research"
    },
    {
      title: "TRU Afterwork Hamburg",
      description: "Recruiting & HR Afterwork — Networking für Professionals",
      location: "Hamburg (wechselnd)",
      recurrence: "Monatlich",
      url: "https://lu.ma/tru-afterwork-hamburg",
      category: "afterwork",
      source: "luma"
    },
    {
      title: "Clouds Afterwork",
      description: "Afterwork mit Skyline-Blick in den Tanzenden Türmen — Cocktails & DJ",
      location: "Clouds, Reeperbahn 1 (23. OG)",
      recurrence: "Donnerstag & Freitag",
      price: "Eintritt frei",
      url: "https://www.clouds-hamburg.de",
      category: "afterwork",
      source: "manual-research"
    },
    {
      title: "20up Afterwork",
      description: "Afterwork im 20. Stock — Panoramablick auf Hafen & Elbe, Cocktails",
      location: "20up Bar, Empire Riverside Hotel, Bernhard-Nocht-Str. 97",
      recurrence: "Donnerstag & Freitag",
      url: "https://www.empire-riverside.de/20up-bar",
      category: "afterwork",
      source: "manual-research"
    },
    {
      title: "Tower Bar Afterwork",
      description: "Afterwork mit Blick auf Hafen, Landungsbrücken & Michel",
      location: "Tower Bar, Hotel Hafen Hamburg, Seewartenstr. 9",
      recurrence: "Mittwoch–Freitag",
      url: "https://www.hotel-hafen-hamburg.de/tower-bar",
      category: "afterwork",
      source: "manual-research"
    },
    {
      title: "East Hotel Afterwork",
      description: "Stylische Afterwork-Party im Designhotel — DJs, Drinks, Networking",
      location: "east Hotel, Simon-von-Utrecht-Str. 31, St. Pauli",
      recurrence: "Donnerstags",
      url: "https://www.east-hamburg.de",
      category: "afterwork",
      source: "manual-research"
    },
    {
      title: "Plantenblom Afterwork",
      description: "Afterwork-Drinks am Rödingsmarkt — beliebter Treffpunkt für Feierabend",
      location: "Plantenblom, Rödingsmarkt 14",
      recurrence: "Mo-Fr ab 17 Uhr",
      price: "Eintritt frei",
      url: "https://plantenblom.de",
      category: "afterwork",
      source: "manual-research"
    },
    {
      title: "Störtebeker Elbphilharmonie Afterwork",
      description: "Afterwork mit Elbblick — Craft Beer & norddeutsche Küche",
      location: "Störtebeker, Elbphilharmonie, Platz der Deutschen Einheit 4",
      recurrence: "Mo-Fr ab 17 Uhr",
      price: "Eintritt frei",
      url: "https://www.stoertebeker-elbphilharmonie.de",
      category: "afterwork",
      source: "manual-research"
    }
  ];

  events.push(...knownRecurring);

  // Try to scrape live events from known sources
  console.log('Checking live sources...');
  
  try {
    // Check lu.ma for afterwork
    const lumaData = await fetchUrl('https://api.lu.ma/discover/get-paginated-events?search_query=afterwork&geo_latitude=53.55&geo_longitude=9.99&geo_place_id=hamburg&pagination_limit=20');
    try {
      const j = JSON.parse(lumaData);
      const entries = j.entries || [];
      entries.forEach(e => {
        const ev = e.event || e;
        if (ev.name && /hamburg/i.test(JSON.stringify(e))) {
          events.push({
            title: ev.name,
            description: ev.description?.substring(0, 200) || '',
            location: ev.geo_address_json?.full_address || 'Hamburg',
            date: ev.start_at,
            url: `https://lu.ma/${ev.url || ev.slug || ''}`,
            category: 'afterwork',
            source: 'luma-live'
          });
        }
      });
      console.log(`Luma: ${entries.length} results`);
    } catch (e) { console.log('Luma parse error'); }
  } catch (e) { console.log('Luma fetch error:', e.message); }

  // Deduplicate by title
  const seen = new Set();
  const unique = events.filter(e => {
    const key = e.title.toLowerCase().replace(/\s+/g, '');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`\nTotal: ${unique.length} afterwork events`);
  
  fs.writeFileSync(CACHE_FILE, JSON.stringify({
    events: unique,
    lastUpdated: new Date().toISOString(),
    source: 'afterwork-scraper'
  }, null, 2));
  
  console.log(`Saved to ${CACHE_FILE}`);
  return unique;
}

scrapeAfterworkEvents = scrapeKnownAfterworkEvents;
scrapeKnownAfterworkEvents().catch(console.error);
