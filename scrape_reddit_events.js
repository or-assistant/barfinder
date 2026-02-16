#!/usr/bin/env node
/**
 * scrape_reddit_events.js - Reddit & Community Event Scraper for Barfinder Hamburg
 * 
 * Searches r/hamburg and related subreddits for event posts about:
 * After-Work, Networking, Bar Events, Wine Tastings, Startup/Founder Events
 * 
 * Uses Reddit's public JSON API (append .json to URLs)
 * NOTE: Reddit blocks most server/cloud IPs. This works best from residential IPs.
 * 
 * Usage: node scrape_reddit_events.js
 */

const fs = require('fs');
const path = require('path');

const CACHE_FILE = path.join(__dirname, 'reddit_events_cache.json');

// Subreddits to search
const SUBREDDITS = [
  'hamburg',
  'germany',
  'de',
  'hamburgfood',
];

// Search queries (OR combined per request)
const SEARCH_QUERIES = [
  'after-work OR afterwork OR after work',
  'networking OR meetup OR founders OR startup',
  'wine tasting OR weinprobe OR wein',
  'bar event OR bar opening OR cocktail',
  'social event OR stammtisch',
];

// Keywords to filter results (at least one must match)
const POSITIVE_KEYWORDS = [
  'after-work', 'afterwork', 'after work',
  'networking', 'meetup', 'meet-up', 'treffen',
  'startup', 'founder', 'gründer', 'entrepreneur',
  'wine', 'wein', 'tasting', 'weinprobe',
  'bar', 'cocktail', 'drinks', 'aperitif', 'aperol',
  'social', 'stammtisch', 'feierabend',
  'event', 'veranstaltung',
  'business', 'professional',
];

// Keywords to EXCLUDE
const NEGATIVE_KEYWORDS = [
  'konzert', 'concert', 'dj set', 'festival',
  'brettspiel', 'board game', 'pub quiz', 'quiz night',
  'theater', 'theatre', 'musical', 'oper', 'opera',
  'fußball', 'football', 'soccer', 'bundesliga',
];

const USER_AGENT = 'barfinder-hamburg/1.0 (event-research; nodejs)';
const DELAY_MS = 2000; // Be respectful

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchRedditSearch(subreddit, query, sort = 'new', limit = 25) {
  const params = new URLSearchParams({
    q: query,
    restrict_sr: '1',
    sort,
    limit: String(limit),
    t: 'year', // last year
  });
  
  const url = `https://www.reddit.com/r/${subreddit}/search.json?${params}`;
  
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(10000),
    });
    
    if (!resp.ok) {
      console.error(`  ❌ ${resp.status} for r/${subreddit} q="${query}"`);
      return [];
    }
    
    const data = await resp.json();
    const posts = data?.data?.children || [];
    return posts.map(p => p.data).filter(Boolean);
  } catch (err) {
    console.error(`  ❌ Error fetching r/${subreddit}: ${err.message}`);
    return [];
  }
}

// Alternative: fetch subreddit listing (hot/new) and filter locally
async function fetchSubredditListing(subreddit, sort = 'new', limit = 100) {
  const url = `https://www.reddit.com/r/${subreddit}/${sort}.json?limit=${limit}`;
  
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(10000),
    });
    
    if (!resp.ok) {
      console.error(`  ❌ ${resp.status} for r/${subreddit}/${sort}`);
      return [];
    }
    
    const data = await resp.json();
    return (data?.data?.children || []).map(p => p.data).filter(Boolean);
  } catch (err) {
    console.error(`  ❌ Error: ${err.message}`);
    return [];
  }
}

function isRelevant(post) {
  const text = `${post.title} ${post.selftext || ''}`.toLowerCase();
  
  // Check negative keywords first
  if (NEGATIVE_KEYWORDS.some(kw => text.includes(kw))) return false;
  
  // Must match at least one positive keyword
  return POSITIVE_KEYWORDS.some(kw => text.includes(kw));
}

function formatPost(post) {
  return {
    title: post.title,
    url: `https://www.reddit.com${post.permalink}`,
    source: 'reddit',
    date: new Date(post.created_utc * 1000).toISOString(),
    subreddit: post.subreddit,
    score: post.score,
    num_comments: post.num_comments,
    flair: post.link_flair_text || null,
    selftext_preview: (post.selftext || '').slice(0, 200),
  };
}

async function scrapeReddit() {
  console.log('🔍 Reddit Event Scraper for Barfinder Hamburg');
  console.log('='.repeat(50));
  
  const allPosts = new Map(); // dedupe by permalink
  
  // Strategy 1: Search each subreddit with each query
  for (const sub of SUBREDDITS) {
    for (const query of SEARCH_QUERIES) {
      console.log(`  Searching r/${sub}: "${query}"`);
      const posts = await fetchRedditSearch(sub, query);
      
      for (const post of posts) {
        if (isRelevant(post) && !allPosts.has(post.permalink)) {
          allPosts.set(post.permalink, formatPost(post));
        }
      }
      
      await sleep(DELAY_MS);
    }
  }
  
  // Strategy 2: Browse r/hamburg listings and filter
  console.log('\n  Browsing r/hamburg listings...');
  for (const sort of ['new', 'hot']) {
    const posts = await fetchSubredditListing('hamburg', sort);
    for (const post of posts) {
      if (isRelevant(post) && !allPosts.has(post.permalink)) {
        allPosts.set(post.permalink, formatPost(post));
      }
    }
    await sleep(DELAY_MS);
  }
  
  const results = [...allPosts.values()].sort((a, b) => 
    new Date(b.date) - new Date(a.date)
  );
  
  console.log(`\n✅ Found ${results.length} relevant event posts`);
  return results;
}

async function main() {
  const results = await scrapeReddit();
  
  // Load existing cache and merge
  let existing = [];
  try {
    existing = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch {}
  
  // Merge by URL
  const urlSet = new Set(results.map(r => r.url));
  const merged = [
    ...results,
    ...existing.filter(e => !urlSet.has(e.url)),
  ];
  
  fs.writeFileSync(CACHE_FILE, JSON.stringify(merged, null, 2));
  console.log(`💾 Saved ${merged.length} events to ${CACHE_FILE}`);
  
  // Print summary
  if (results.length > 0) {
    console.log('\n📋 Latest finds:');
    results.slice(0, 10).forEach(r => {
      console.log(`  [${r.score}⬆ ${r.num_comments}💬] ${r.title}`);
      console.log(`    ${r.url}`);
    });
  } else {
    console.log('\n⚠️  No results found. Reddit may be blocking this IP.');
    console.log('    Reddit blocks most cloud/server IPs since 2023.');
    console.log('    Try running from a local machine or use a residential proxy.');
  }
}

main().catch(console.error);
