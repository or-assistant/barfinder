#!/usr/bin/env python3
"""
Analysis of bar verification results
"""

import json

def analyze_verification_report():
    """Analyze the verification report and provide detailed insights"""
    
    with open('/home/openclaw/.openclaw/workspace/barfinder/verification_report.json', 'r', encoding='utf-8') as f:
        report = json.load(f)
    
    print("=== HAMBURG BARFINDER VERIFICATION RESULTS ===")
    print(f"Total bars verified: {len(report)}")
    
    # Status analysis
    status_counts = {}
    source_counts = {}
    suspicious_bars = []
    not_found_bars = []
    
    for entry in report:
        status = entry.get('status', 'unknown')
        source = entry.get('source', 'unknown')
        
        status_counts[status] = status_counts.get(status, 0) + 1
        source_counts[source] = source_counts.get(source, 0) + 1
        
        if status == 'suspicious':
            suspicious_bars.append(entry)
        elif status == 'not_found':
            not_found_bars.append(entry)
    
    print("\nStatus Breakdown:")
    for status, count in status_counts.items():
        percentage = (count / len(report)) * 100
        print(f"  {status}: {count} ({percentage:.1f}%)")
    
    print("\nSource Breakdown:")
    for source, count in source_counts.items():
        percentage = (count / len(report)) * 100
        print(f"  {source}: {count} ({percentage:.1f}%)")
    
    # Look for bars that had difficulty being verified (required Google fallback)
    google_fallbacks = [entry for entry in report if entry.get('source') == 'google']
    print(f"\nBars verified via Google Maps (not in OSM): {len(google_fallbacks)}")
    
    if len(google_fallbacks) > 0:
        print("These bars might need coordinates updated in OSM:")
        for bar in google_fallbacks[:10]:  # Show first 10
            print(f"  - {bar['name']} ({bar.get('address', 'No address')})")
        if len(google_fallbacks) > 10:
            print(f"  ... and {len(google_fallbacks)-10} more")
    
    # Website verification
    website_verified = [entry for entry in report if entry.get('source') == 'website']
    print(f"\nBars verified via website: {len(website_verified)}")
    
    if suspicious_bars:
        print(f"\nSUSPICIOUS BARS ({len(suspicious_bars)}):")
        for bar in suspicious_bars:
            print(f"  - {bar['name']}: {bar.get('notes', 'No notes')}")
    
    if not_found_bars:
        print(f"\nNOT FOUND BARS ({len(not_found_bars)}):")
        for bar in not_found_bars:
            print(f"  - {bar['name']}: {bar.get('notes', 'No notes')}")
    
    return {
        'total': len(report),
        'verified': status_counts.get('verified', 0),
        'suspicious': suspicious_bars,
        'not_found': not_found_bars,
        'google_fallbacks': google_fallbacks,
        'website_verified': website_verified
    }

if __name__ == "__main__":
    results = analyze_verification_report()