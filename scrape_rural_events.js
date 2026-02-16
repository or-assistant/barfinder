#!/usr/bin/env node
// Rural Events Scraper — Lentföhrden, Weddelbrook, Bad Bramstedt area
// Sources: lentfoehrden.de, woltersgasthof.eatbu.com, kaltenkirchen.de
const fs = require('fs');
const cheerio = require('cheerio');

const CACHE_FILE = './rural_events_cache.json';

async function scrapeLentfoehrden() {
  console.log('📍 Scraping lentfoehrden.de...');
  try {
    const res = await fetch('https://www.lentfoehrden.de');
    const html = await res.text();
    const $ = cheerio.load(html);
    const events = [];
    
    // Parse the event table
    $('tr').each((i, row) => {
      const cells = $(row).find('td');
      if (cells.length >= 5) {
        const dateText = $(cells[1]).text().trim();
        const time = $(cells[2]).text().trim();
        const location = $(cells[3]).text().trim();
        const title = $(cells[4]).text().trim();
        const organizer = cells.length > 5 ? $(cells[5]).text().trim() : '';
        
        if (title && dateText) {
          // Parse date DD.MM.YYYY
          const dateMatch = dateText.match(/(\d{2})\.(\d{2})\.(\d{4})/);
          let isoDate = '';
          if (dateMatch) {
            isoDate = `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}`;
          }
          
          events.push({
            title,
            date: isoDate,
            time: time.replace(/\s*Uhr\s*/g, '').split('-')[0].trim(),
            venue: location || 'Lentföhrden',
            description: organizer ? `Veranstalter: ${organizer}` : '',
            source: 'lentfoehrden.de',
            type: categorizeRuralEvent(title),
            url: 'https://www.lentfoehrden.de'
          });
        }
      }
    });
    
    console.log(`  → ${events.length} Events gefunden`);
    return events;
  } catch (e) {
    console.log(`  ⚠️ Fehler: ${e.message}`);
    return [];
  }
}

async function scrapeWolters() {
  console.log('🍺 Scraping woltersgasthof.eatbu.com...');
  try {
    const res = await fetch('https://woltersgasthof.eatbu.com/?lang=de');
    const html = await res.text();
    const events = [];
    
    // Extract event sections — look for dates in format DD.MM.YYYY or DD.MM.
    const datePattern = /(\d{1,2})\.(\d{1,2})\.?(\d{4})?\s*[-–]?\s*(.*?)(?:\n|$)/g;
    const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    
    // Look for event-like patterns
    const eventPatterns = [
      /(\d{1,2}\.\d{1,2}\.(?:\d{4})?)\s*(?:[-–])?\s*(Ü\d+|Party|Disco|Theater|Live|Konzert|Fest|Feuer|Tanz)/gi,
      /(Ü\d+|Party|Disco|Theater|Live|Fest|Stoppel|Osterfeuer|Maifeuer|Tanz)\s*.*?(\d{1,2}\.\d{1,2}\.(?:\d{4})?)/gi
    ];
    
    for (const pattern of eventPatterns) {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const fullMatch = match[0].trim();
        let dateStr, eventName;
        
        if (/^\d/.test(fullMatch)) {
          dateStr = match[1];
          eventName = match[2];
        } else {
          eventName = match[1];
          dateStr = match[2];
        }
        
        // Parse date
        const dateParts = dateStr.match(/(\d{1,2})\.(\d{1,2})\.?(\d{4})?/);
        if (dateParts) {
          const year = dateParts[3] || new Date().getFullYear();
          const isoDate = `${year}-${dateParts[2].padStart(2,'0')}-${dateParts[1].padStart(2,'0')}`;
          
          events.push({
            title: `${eventName} @ Wolters Gasthof`,
            date: isoDate,
            time: '20:00',
            venue: 'Wolters Gasthof, Weddelbrook',
            description: fullMatch,
            source: 'wolters-gasthof',
            type: categorizeRuralEvent(eventName),
            url: 'https://woltersgasthof.eatbu.com'
          });
        }
      }
    }
    
    // Also look for "Plattdeutsches Theater" dates
    const theaterMatch = text.match(/Plattdeutsches Theater[\s\S]*?(\d{1,2}\.\d{1,2}\.[\s\S]*?)(?:Über uns|Online|Reservierung)/i);
    if (theaterMatch) {
      const theaterDates = theaterMatch[1].matchAll(/(\d{1,2})\.(\d{1,2})\.\s*[-–]?\s*(\d{1,2})\s*Uhr/g);
      for (const td of theaterDates) {
        const year = new Date().getFullYear();
        const isoDate = `${year}-${td[2].padStart(2,'0')}-${td[1].padStart(2,'0')}`;
        events.push({
          title: 'Plattdeutsches Theater @ Wolters Gasthof',
          date: isoDate,
          time: `${td[3]}:00`,
          venue: 'Wolters Gasthof, Weddelbrook',
          description: 'Plattdeutsches Theater — Tradition seit Generationen',
          source: 'wolters-gasthof',
          type: 'culture',
          url: 'https://woltersgasthof.eatbu.com'
        });
      }
    }
    
    // Dedup by date+title
    const seen = new Set();
    const unique = events.filter(e => {
      const key = `${e.date}_${e.title}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    
    console.log(`  → ${unique.length} Events gefunden`);
    return unique;
  } catch (e) {
    console.log(`  ⚠️ Fehler: ${e.message}`);
    return [];
  }
}

// Add recurring annual events for the region
function getRecurringRuralEvents() {
  const year = new Date().getFullYear();
  const events = [
    // Osterfeuer — Karsamstag (varies, approximate for 2026: April 4)
    { title: 'Osterfeuer Lentföhrden', date: `${year}-04-04`, time: '18:00', venue: 'Lentföhrden', description: 'Traditionelles Osterfeuer — jährlich am Karsamstag, Treffpunkt der Dorfgemeinschaft', source: 'recurring', type: 'dorffest', url: '' },
    { title: 'Osterfeuer Weddelbrook', date: `${year}-04-04`, time: '18:00', venue: 'Weddelbrook', description: 'Osterfeuer am Karsamstag', source: 'recurring', type: 'dorffest', url: '' },
    { title: 'Osterfeuer Bad Bramstedt', date: `${year}-04-04`, time: '18:00', venue: 'Bad Bramstedt', description: 'Osterfeuer am Karsamstag', source: 'recurring', type: 'dorffest', url: '' },
    { title: 'Osterfeuer Kaltenkirchen', date: `${year}-04-04`, time: '18:00', venue: 'Kaltenkirchen', description: 'Osterfeuer am Karsamstag', source: 'recurring', type: 'dorffest', url: '' },
    
    // Tanz in den Mai — 30. April
    { title: 'Tanz in den Mai / Maifeuer Lentföhrden', date: `${year}-04-30`, time: '19:00', venue: 'Lentföhrden', description: 'Maifeuer & Tanz in den Mai — Tradition in der Region', source: 'recurring', type: 'dorffest', url: '' },
    { title: 'Tanz in den Mai Wolters Gasthof', date: `${year}-04-30`, time: '20:00', venue: 'Wolters Gasthof, Weddelbrook', description: 'Tanz in den Mai — Party & Disco im Wolters', source: 'recurring', type: 'party', url: 'https://woltersgasthof.eatbu.com' },
    
    // Stoppelfeeten — typischerweise August/September nach der Ernte
    { title: 'Stoppelfeeten Lentföhrden', date: `${year}-08-16`, time: '15:00', venue: 'Lentföhrden', description: 'Traditionelles Stoppelfest nach der Ernte — Live-Musik, Tanz, Essen & Trinken', source: 'recurring', type: 'dorffest', url: '' },
    
    // Schützenfest
    { title: 'Schützenfest Lentföhrden', date: `${year}-07-12`, time: '14:00', venue: 'Lentföhrden', description: 'Schützenfest mit Umzug, Schießen, Festzelt & Party', source: 'recurring', type: 'dorffest', url: '' },
    { title: 'Schützenfest Bad Bramstedt', date: `${year}-06-21`, time: '14:00', venue: 'Bad Bramstedt', description: 'Traditionsreiches Schützenfest', source: 'recurring', type: 'dorffest', url: '' },
    
    // Laternenumzug / Martinsumzug — November
    { title: 'Laternenumzug Lentföhrden', date: `${year}-11-11`, time: '17:00', venue: 'Lentföhrden', description: 'St. Martin Laternenumzug', source: 'recurring', type: 'dorffest', url: '' },
    
    // Weihnachtsmarkt
    { title: 'Weihnachtsmarkt Bad Bramstedt', date: `${year}-12-06`, time: '15:00', venue: 'Bad Bramstedt Innenstadt', description: 'Adventsmarkt mit Glühwein, Kunsthandwerk & Weihnachtsstimmung', source: 'recurring', type: 'weihnachtsmarkt', url: '' },
    { title: 'Adventsmarkt Kaltenkirchen', date: `${year}-12-07`, time: '14:00', venue: 'Kaltenkirchen Innenstadt', description: 'Weihnachtsmarkt in Kaltenkirchen', source: 'recurring', type: 'weihnachtsmarkt', url: '' },
  ];
  
  console.log(`📅 ${events.length} wiederkehrende Dorffeste/Saisonevents hinzugefügt`);
  return events;
}

function categorizeRuralEvent(title) {
  const t = (title || '').toLowerCase();
  if (/ü\d+|disco|party|tanz/.test(t)) return 'party';
  if (/theater|plattdeutsch/.test(t)) return 'culture';
  if (/feuer|oster|mai|stoppel|schützen|dorffest|laterne/.test(t)) return 'dorffest';
  if (/weihnacht|advent/.test(t)) return 'weihnachtsmarkt';
  if (/live|musik|konzert/.test(t)) return 'livemusik';
  return 'social';
}

async function main() {
  console.log('🏡 Rural Events Scraper — Lentföhrden & Umkreis\n');
  
  const [lentEvents, woltersEvents] = await Promise.all([
    scrapeLentfoehrden(),
    scrapeWolters()
  ]);
  
  const recurringEvents = getRecurringRuralEvents();
  
  const allEvents = [...lentEvents, ...woltersEvents, ...recurringEvents];
  
  // Dedup
  const seen = new Set();
  const unique = allEvents.filter(e => {
    const key = `${e.date}_${e.title}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  
  const cache = {
    scraped_at: new Date().toISOString(),
    count: unique.length,
    events: unique
  };
  
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  console.log(`\n✅ ${unique.length} Events gespeichert → ${CACHE_FILE}`);
}

main().catch(console.error);
