#!/usr/bin/env python3
"""
Check for duplicates in the bar database
"""

import json

def find_duplicates():
    """Find potential duplicates based on similar names and addresses"""
    
    with open('/home/openclaw/.openclaw/workspace/barfinder/highlights.json', 'r', encoding='utf-8') as f:
        bars = json.load(f)
    
    duplicates = []
    
    # Simple duplicate detection
    for i, bar1 in enumerate(bars):
        for j, bar2 in enumerate(bars[i+1:], i+1):
            name1 = bar1['name'].lower().strip()
            name2 = bar2['name'].lower().strip()
            addr1 = bar1.get('address', '').lower().strip()
            addr2 = bar2.get('address', '').lower().strip()
            
            # Check for similar names
            name_similar = (
                name1 == name2 or 
                name1 in name2 or 
                name2 in name1 or
                levenshtein_distance(name1, name2) <= 2
            )
            
            # Check for same address
            addr_same = addr1 and addr2 and addr1 == addr2
            
            if name_similar or addr_same:
                duplicates.append({
                    'bar1': bar1,
                    'bar2': bar2,
                    'similarity_reason': 'name' if name_similar else 'address'
                })
    
    print(f"=== POTENTIAL DUPLICATES FOUND: {len(duplicates)} ===")
    for i, dup in enumerate(duplicates, 1):
        print(f"\n{i}. {dup['similarity_reason'].upper()} SIMILARITY:")
        print(f"   Bar 1: {dup['bar1']['name']} - {dup['bar1'].get('address', 'No address')}")
        print(f"   Bar 2: {dup['bar2']['name']} - {dup['bar2'].get('address', 'No address')}")
        
        # Check coordinates to see if they're the same location
        lat1, lon1 = dup['bar1'].get('lat'), dup['bar1'].get('lon')
        lat2, lon2 = dup['bar2'].get('lat'), dup['bar2'].get('lon')
        
        if lat1 and lon1 and lat2 and lon2:
            distance = calculate_distance(lat1, lon1, lat2, lon2)
            print(f"   Distance: {distance:.0f}m apart")
    
    return duplicates

def levenshtein_distance(s1, s2):
    """Calculate Levenshtein distance between two strings"""
    if len(s1) < len(s2):
        return levenshtein_distance(s2, s1)
    
    if len(s2) == 0:
        return len(s1)
    
    previous_row = list(range(len(s2) + 1))
    for i, c1 in enumerate(s1):
        current_row = [i + 1]
        for j, c2 in enumerate(s2):
            insertions = previous_row[j + 1] + 1
            deletions = current_row[j] + 1
            substitutions = previous_row[j] + (c1 != c2)
            current_row.append(min(insertions, deletions, substitutions))
        previous_row = current_row
    
    return previous_row[-1]

def calculate_distance(lat1, lon1, lat2, lon2):
    """Calculate distance between two coordinates in meters"""
    import math
    
    # Convert to radians
    lat1, lon1, lat2, lon2 = map(math.radians, [lat1, lon1, lat2, lon2])
    
    # Haversine formula
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    a = math.sin(dlat/2)**2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon/2)**2
    c = 2 * math.asin(math.sqrt(a))
    r = 6371000  # Earth's radius in meters
    
    return r * c

if __name__ == "__main__":
    duplicates = find_duplicates()