#!/usr/bin/env python3
"""
Monthly Barfinder Verification Script
Checks a sample of bar/pub/cocktailbar/wine/irish-pub locations via Nominatim.
Rate limit: 1 request per second (Nominatim policy).
"""
import json, time, urllib.request, urllib.parse, sys, os
from datetime import datetime, timezone

HIGHLIGHTS = os.path.join(os.path.dirname(__file__), "highlights.json")
REPORT_OUT = os.path.join(os.path.dirname(__file__), "verification_report.json")

# Categories to verify (core bar locations)
VERIFY_CATS = {"bar", "pub", "cocktailbar", "wine", "irish-pub", "biergarten", "nightclub"}

# Max locations to check (Nominatim rate limit = 1/sec)
MAX_CHECKS = 120  # ~2 min runtime

def nominatim_search(name, lat, lon, address):
    """Search Nominatim for a location by name near coordinates."""
    params = {
        "q": f"{name}, Hamburg",
        "format": "json",
        "limit": 3,
        "viewbox": f"{lon-0.02},{lat+0.02},{lon+0.02},{lat-0.02}",
        "bounded": 0,
    }
    url = "https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": "BarfinderVerifier/1.0 (openclaw)"})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())
            return data
    except Exception as e:
        return {"error": str(e)}

def reverse_check(lat, lon):
    """Reverse geocode to see what's at the location now."""
    params = {"lat": lat, "lon": lon, "format": "json", "zoom": 18}
    url = "https://nominatim.openstreetmap.org/reverse?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": "BarfinderVerifier/1.0 (openclaw)"})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read())
    except Exception as e:
        return {"error": str(e)}

def main():
    with open(HIGHLIGHTS, "r") as f:
        locations = json.load(f)
    
    # Filter to core categories
    to_verify = [loc for loc in locations if loc.get("category") in VERIFY_CATS]
    
    # Prioritize: older last_verified first, then enriched ones (more valuable)
    to_verify.sort(key=lambda x: (x.get("last_verified", ""), "enriched" not in x))
    
    # Limit checks
    to_verify = to_verify[:MAX_CHECKS]
    
    now = datetime.now(timezone.utc).isoformat()
    report = {
        "run_date": now,
        "total_locations": len(locations),
        "checked": 0,
        "verified_ok": 0,
        "not_found": 0,
        "errors": 0,
        "closed": [],
        "successors": [],
        "details": []
    }
    
    for i, loc in enumerate(to_verify):
        name = loc.get("name", "")
        lat = loc.get("lat", 0)
        lon = loc.get("lon", 0)
        address = loc.get("address", "")
        
        if i > 0:
            time.sleep(1.1)  # Nominatim rate limit
        
        result = nominatim_search(name, lat, lon, address)
        report["checked"] += 1
        
        status = "unknown"
        if isinstance(result, dict) and "error" in result:
            status = "error"
            report["errors"] += 1
            report["details"].append({"name": name, "status": "error", "error": result["error"]})
        elif isinstance(result, list) and len(result) > 0:
            # Found something - check if it's close enough
            found = result[0]
            found_lat = float(found.get("lat", 0))
            found_lon = float(found.get("lon", 0))
            dist = ((found_lat - lat)**2 + (found_lon - lon)**2)**0.5
            
            if dist < 0.01:  # ~1km - close enough
                status = "verified"
                report["verified_ok"] += 1
            else:
                status = "location_mismatch"
                report["verified_ok"] += 1  # Still exists, just coordinates differ
            
            report["details"].append({
                "name": name, 
                "status": status, 
                "distance_deg": round(dist, 5),
                "found_name": found.get("display_name", "")[:100]
            })
        else:
            # Not found in Nominatim - could be closed or not in OSM
            status = "not_found_nominatim"
            report["not_found"] += 1
            report["details"].append({"name": name, "status": status, "address": address})
        
        if (i+1) % 20 == 0:
            print(f"  Checked {i+1}/{len(to_verify)}...", file=sys.stderr)
    
    # Update last_verified for checked locations
    checked_names = {d["name"] for d in report["details"]}
    for loc in locations:
        if loc.get("name") in checked_names:
            loc["last_verified"] = now
    
    # Write report
    with open(REPORT_OUT, "w") as f:
        json.dump(report, f, indent=2, ensure_ascii=False)
    
    # Write updated highlights
    with open(HIGHLIGHTS, "w") as f:
        json.dump(locations, f, indent=2, ensure_ascii=False)
    
    # Summary
    print(json.dumps({
        "checked": report["checked"],
        "verified_ok": report["verified_ok"],
        "not_found": report["not_found"],
        "errors": report["errors"],
        "closed_count": len(report["closed"])
    }))

if __name__ == "__main__":
    main()
