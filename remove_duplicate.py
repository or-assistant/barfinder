#!/usr/bin/env python3
"""
Remove the confirmed duplicate entry
"""

import json
import shutil
from datetime import datetime

def remove_duplicate():
    """Remove the confirmed duplicate: VIA DEI MILLE & Poletto Winebar at same address"""
    
    # Create timestamped backup
    timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
    backup_path = f'/home/openclaw/.openclaw/workspace/barfinder/highlights_pre_duplicate_removal_{timestamp}.json'
    shutil.copy('/home/openclaw/.openclaw/workspace/barfinder/highlights.json', backup_path)
    print(f"Created backup: {backup_path}")
    
    # Load bars
    with open('/home/openclaw/.openclaw/workspace/barfinder/highlights.json', 'r', encoding='utf-8') as f:
        bars = json.load(f)
    
    print(f"Original count: {len(bars)} bars")
    
    # Find the duplicate entries
    via_dei_mille = None
    poletto_winebar = None
    
    for i, bar in enumerate(bars):
        if bar['name'] == 'VIA DEI MILLE':
            via_dei_mille = (i, bar)
        elif bar['name'] == 'Poletto Winebar':
            poletto_winebar = (i, bar)
    
    if via_dei_mille and poletto_winebar:
        print(f"\nFound duplicate entries:")
        print(f"VIA DEI MILLE: {via_dei_mille[1]['address']}")
        print(f"Poletto Winebar: {poletto_winebar[1]['address']}")
        
        # Check if they have the same address
        if via_dei_mille[1]['address'] == poletto_winebar[1]['address']:
            print(f"\nCONFIRMED: Same address - {via_dei_mille[1]['address']}")
            
            # Remove the second one (Poletto Winebar)
            removed_bar = bars.pop(poletto_winebar[0])
            print(f"REMOVED: {removed_bar['name']}")
            
            # Save updated file
            with open('/home/openclaw/.openclaw/workspace/barfinder/highlights.json', 'w', encoding='utf-8') as f:
                json.dump(bars, f, indent=2, ensure_ascii=False)
            
            print(f"Updated count: {len(bars)} bars")
            print(f"Removed 1 duplicate entry")
            
            return True
        else:
            print("ERROR: Addresses don't match - not removing")
            return False
    else:
        print("ERROR: Could not find both entries")
        return False

if __name__ == "__main__":
    success = remove_duplicate()