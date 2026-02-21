#!/usr/bin/env python3
"""
Overpass/OSM Ground Truth Sync for Barfinder
Matches highlights.json against OpenStreetMap and corrects high-confidence errors.
"""

import json, math, time, sys, os
from datetime import datetime, timezone
from difflib import SequenceMatcher
from urllib.request import urlopen, Request
from urllib.parse import urlencode

HIGHLIGHTS_PATH = os.path.join(os.path.dirname(__file__), 'highlights.json')
CORRECTIONS_LOG = os.path.join(os.path.dirname(__file__), 'osm_corrections_log.json')
CATEGORY_MISMATCHES = os.path.join(os.path.dirname(__file__), 'osm_category_mismatches.json')

OVERPASS_URL = 'https://overpass-api.de/api/interpreter'
OVERPASS_QUERY = """
[out:json][timeout:90];
area["name"="Hamburg"]["admin_level"="4"]->.hh;
(
  node["amenity"~"bar|pub|cafe|restaurant|nightclub|biergarten"](area.hh);
  way["amenity"~"bar|pub|cafe|restaurant|nightclub|biergarten"](area.hh);
);
out center;
"""

AMENITY_MAP = {
    'bar': 'bar', 'pub': 'pub', 'cafe': 'cafe',
    'restaurant': 'restaurant', 'nightclub': 'nightclub', 'biergarten': 'biergarten'
}

def haversine(lat1, lon1, lat2, lon2):
    R = 6371000
    p = math.pi / 180
    a = math.sin((lat2-lat1)*p/2)**2 + math.cos(lat1*p)*math.cos(lat2*p)*math.sin((lon2-lon1)*p/2)**2
    return 2 * R * math.asin(math.sqrt(a))

OSM_CACHE = os.path.join(os.path.dirname(__file__), 'osm_cache.json')
OSM_CACHE_MAX_AGE = 86400  # 24h

def fetch_osm():
    # Use cache if fresh enough
    if os.path.exists(OSM_CACHE):
        age = time.time() - os.path.getmtime(OSM_CACHE)
        if age < OSM_CACHE_MAX_AGE:
            print(f"📦 Using cached OSM data ({int(age/60)}min old)")
            with open(OSM_CACHE, 'r') as f:
                elements = json.load(f)
            return _parse_elements(elements)
    
    print("📡 Fetching OSM data from Overpass API...")
    data = urlencode({'data': OVERPASS_QUERY}).encode()
    for attempt in range(3):
        try:
            req = Request(OVERPASS_URL, data=data, headers={'User-Agent': 'Barfinder-Sync/1.0'})
            resp = urlopen(req, timeout=120)
            result = json.loads(resp.read().decode())
            elements = result.get('elements', [])
            with open(OSM_CACHE, 'w') as f:
                json.dump(elements, f)
            break
        except Exception as e:
            print(f"   Attempt {attempt+1} failed: {e}")
            if attempt < 2:
                time.sleep(15 * (attempt + 1))
            else:
                raise
    
    return _parse_elements(elements)

def _parse_elements(elements):
    pois = []
    for el in elements:
        tags = el.get('tags', {})
        name = tags.get('name')
        if not name:
            continue
        lat = el.get('lat') or el.get('center', {}).get('lat')
        lon = el.get('lon') or el.get('center', {}).get('lon')
        if not lat or not lon:
            continue
        pois.append({'name': name, 'lat': lat, 'lon': lon, 'tags': tags, 'osm_id': el.get('id'), 'osm_type': el.get('type')})
    
    print(f"✅ {len(pois)} named POIs loaded from OSM")
    return pois

def normalize(s):
    return s.lower().strip().replace('ä','ae').replace('ö','oe').replace('ü','ue').replace('ß','ss')

def get_lon(loc):
    return loc.get('lon') or loc.get('lng', 0)

def find_match(loc, osm_pois):
    best, best_score = None, 0
    loc_name = normalize(loc['name'])
    for poi in osm_pois:
        dist = haversine(loc['lat'], get_lon(loc), poi['lat'], poi['lon'])
        if dist > 200:
            continue
        ratio = SequenceMatcher(None, loc_name, normalize(poi['name'])).ratio()
        if ratio > best_score and ratio > 0.7:
            best, best_score = poi, ratio
    return best, best_score

def build_osm_address(tags):
    street = tags.get('addr:street', '')
    number = tags.get('addr:housenumber', '')
    city = tags.get('addr:city', '')
    suburb = tags.get('addr:suburb', '')
    if not street:
        return None
    addr = f"{street} {number}".strip()
    if suburb:
        addr += f", {suburb}"
    elif city:
        addr += f", {city}"
    return addr

def sync():
    with open(HIGHLIGHTS_PATH, 'r') as f:
        highlights = json.load(f)
    
    osm_pois = fetch_osm()
    
    corrections_log = []
    category_mismatches = []
    stats = {'matched': 0, 'address': 0, 'coords': 0, 'hours': 0, 'website': 0, 'category_mismatch': 0}
    now = datetime.now(timezone.utc).isoformat()
    
    print(f"\n🔍 Matching {len(highlights)} locations against {len(osm_pois)} OSM POIs...")
    
    for loc in highlights:
        match, score = find_match(loc, osm_pois)
        if not match:
            continue
        
        stats['matched'] += 1
        tags = match['tags']
        loc_corrections = []
        
        # 1. Address
        osm_addr = build_osm_address(tags)
        if osm_addr and osm_addr != loc.get('address'):
            loc_corrections.append({
                'field': 'address', 'old': loc.get('address'), 'new': osm_addr,
                'confidence': 'high', 'auto_applied': True
            })
            loc['address'] = osm_addr
            stats['address'] += 1
        
        # 2. Coordinates
        loc_lon = get_lon(loc)
        dist = haversine(loc['lat'], loc_lon, match['lat'], match['lon'])
        if dist > 50:
            lon_key = 'lon' if 'lon' in loc else 'lng'
            loc_corrections.append({
                'field': 'coordinates', 'old': [loc['lat'], loc_lon],
                'new': [match['lat'], match['lon']], 'distance_m': round(dist, 1),
                'confidence': 'high', 'auto_applied': True
            })
            loc['lat'] = match['lat']
            loc[lon_key] = match['lon']
            stats['coords'] += 1
        
        # 3. Category
        osm_amenity = tags.get('amenity', '')
        mapped = AMENITY_MAP.get(osm_amenity)
        if mapped and mapped != loc.get('category'):
            entry = {
                'name': loc['name'], 'osm_name': match['name'],
                'our_category': loc.get('category'), 'osm_amenity': osm_amenity,
                'suggested': mapped, 'confidence': 'medium', 'match_score': round(score, 3)
            }
            category_mismatches.append(entry)
            loc_corrections.append({
                'field': 'category', 'old': loc.get('category'), 'new': mapped,
                'confidence': 'medium', 'auto_applied': False
            })
            stats['category_mismatch'] += 1
        
        # 4. Opening hours
        osm_hours = tags.get('opening_hours')
        if osm_hours and not loc.get('opening_hours'):
            loc_corrections.append({
                'field': 'opening_hours', 'old': None, 'new': osm_hours,
                'confidence': 'high', 'auto_applied': True
            })
            loc['opening_hours'] = osm_hours
            stats['hours'] += 1
        
        # 5. Website
        osm_web = tags.get('website') or tags.get('contact:website')
        if osm_web and not loc.get('website'):
            loc_corrections.append({
                'field': 'website', 'old': None, 'new': osm_web,
                'confidence': 'high', 'auto_applied': True
            })
            loc['website'] = osm_web
            stats['website'] += 1
        
        if loc_corrections:
            loc['last_verified'] = now
            corrections_log.append({
                'name': loc['name'], 'osm_name': match['name'],
                'osm_id': match['osm_id'], 'osm_type': match['osm_type'],
                'match_score': round(score, 3), 'corrections': loc_corrections,
                'timestamp': now
            })
    
    # Write outputs
    with open(HIGHLIGHTS_PATH, 'w') as f:
        json.dump(highlights, f, indent=2, ensure_ascii=False)
    
    with open(CORRECTIONS_LOG, 'w') as f:
        json.dump(corrections_log, f, indent=2, ensure_ascii=False)
    
    with open(CATEGORY_MISMATCHES, 'w') as f:
        json.dump(category_mismatches, f, indent=2, ensure_ascii=False)
    
    print(f"\n📊 Sync Results:")
    print(f"   Matched: {stats['matched']}/{len(highlights)}")
    print(f"   Addresses corrected: {stats['address']}")
    print(f"   Coordinates corrected: {stats['coords']}")
    print(f"   Opening hours added: {stats['hours']}")
    print(f"   Websites added: {stats['website']}")
    print(f"   Category mismatches (manual review): {stats['category_mismatch']}")
    print(f"\n📁 Written: highlights.json, osm_corrections_log.json, osm_category_mismatches.json")

if __name__ == '__main__':
    sync()
