#!/usr/bin/env python3
"""Verify barfinder locations via Nominatim."""
import json, time, urllib.request, urllib.parse, sys

with open('highlights.json') as f:
    data = json.load(f)

# Prioritize by suspiciousness
def score(loc):
    s = 0
    if not loc.get('address'): s += 3
    if not loc.get('description') or len(loc.get('description','')) < 20: s += 2
    if not loc.get('website'): s += 1
    desc = loc.get('description','').lower()
    if any(g in desc for g in ['bar in hamburg', 'restaurant in', 'kneipe in hamburg', 'café in hamburg', 'weinbar in', 'pub in hamburg', 'lounge in', 'weinhandlung in', 'wine bar in']): s += 3
    return s

scored = [(score(loc), loc) for loc in data]
scored.sort(key=lambda x: -x[0])

def nominatim_search(query):
    url = f"https://nominatim.openstreetmap.org/search?q={urllib.parse.quote(query)}&format=json&limit=3&addressdetails=1&extratags=1"
    req = urllib.request.Request(url, headers={'User-Agent': 'BarfinderVerify/1.0'})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read())
    except Exception as e:
        return []

results = []
checked = 0
target = 60

for s, loc in scored:
    if checked >= target:
        break
    
    name = loc['name']
    address = loc.get('address', '')
    
    print(f"[{checked+1}/{target}] Checking: {name} (score={s})", flush=True)
    
    # Step 1: Search by name
    time.sleep(1.1)
    hits = nominatim_search(f"{name} Hamburg")
    
    found = False
    is_gastro = False
    
    for h in hits:
        # Check if it's roughly in Hamburg area (lat ~53.4-53.7, lon ~9.7-10.2)
        lat, lon = float(h.get('lat',0)), float(h.get('lon',0))
        if 53.3 < lat < 53.8 and 9.6 < lon < 10.3:
            found = True
            # Check category
            htype = h.get('type','')
            hclass = h.get('class','')
            if hclass in ('amenity','tourism','leisure') or htype in ('bar','pub','restaurant','cafe','nightclub','biergarten','fast_food'):
                is_gastro = True
            break
    
    if found:
        print(f"  ✓ Found by name", flush=True)
        checked += 1
        continue
    
    # Step 2: Search by address if available
    if address:
        time.sleep(1.1)
        addr_hits = nominatim_search(f"{address} Hamburg")
        
        addr_found = False
        replacement = None
        
        for h in addr_hits:
            lat, lon = float(h.get('lat',0)), float(h.get('lon',0))
            if 53.3 < lat < 53.8 and 9.6 < lon < 10.3:
                addr_found = True
                hname = h.get('display_name','')
                htype = h.get('type','')
                extratags = h.get('extratags', {})
                osm_name = extratags.get('name', h.get('name',''))
                if osm_name and osm_name.lower() != name.lower() and htype in ('bar','pub','restaurant','cafe','nightclub'):
                    replacement = {'name': osm_name, 'type': htype}
                break
        
        if replacement:
            print(f"  ⚠ REPLACED by: {replacement['name']}", flush=True)
            results.append({
                'name': name,
                'status': 'replaced',
                'replacement_name': replacement['name'],
                'replacement_category': replacement['type'],
                'notes': f"Address {address} now shows: {replacement['name']}"
            })
        elif not addr_found:
            print(f"  ✗ NOT FOUND (name + address)", flush=True)
            results.append({
                'name': name,
                'status': 'not_found',
                'notes': f"Neither name nor address ({address}) found on Nominatim"
            })
        else:
            print(f"  ~ Address found but no gastro match", flush=True)
            # Address exists but no replacement identified - could still be there
    else:
        # No address, not found by name
        print(f"  ✗ NOT FOUND (no address to verify)", flush=True)
        results.append({
            'name': name,
            'status': 'not_found',
            'notes': 'Not found by name on Nominatim, no address available to cross-check'
        })
    
    checked += 1

# Save results
with open('verification_report.json', 'w') as f:
    json.dump(results, f, indent=2, ensure_ascii=False)

print(f"\n=== Done: {checked} checked, {len(results)} issues found ===")
for r in results:
    print(f"  {r['status']}: {r['name']} — {r.get('notes','')}")
