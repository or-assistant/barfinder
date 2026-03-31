#!/usr/bin/env python3
"""Nominatim geocoding audit for Barfinder Hamburg database."""

import sqlite3
import json
import time
import math
import urllib.request
import urllib.parse
import random

DB_PATH = "/home/openclaw/.openclaw/workspace/barfinder/barfinder.db"
OUTPUT_PATH = "/home/openclaw/.openclaw/workspace/barfinder/nominatim_check_20260328.json"
NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
USER_AGENT = "barfinder-audit/1.0"
SAMPLE_SIZE = 30
DISTANCE_THRESHOLD_M = 500


def haversine(lat1, lon1, lat2, lon2):
    """Calculate distance in meters between two lat/lon points."""
    R = 6371000  # Earth radius in meters
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlam / 2) ** 2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def geocode(address):
    """Query Nominatim for an address. Returns (lat, lon) or None."""
    params = urllib.parse.urlencode({"q": address, "format": "json", "limit": "1"})
    url = f"{NOMINATIM_URL}?{params}"
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode())
            if data:
                return float(data[0]["lat"]), float(data[0]["lon"]), data[0].get("display_name", "")
    except Exception as e:
        return None, None, str(e)
    return None, None, "no results"


def main():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cur.execute("SELECT id, name, lat, lon, address FROM places WHERE address IS NOT NULL AND address != '' ORDER BY RANDOM() LIMIT ?", (SAMPLE_SIZE,))
    rows = cur.fetchall()
    conn.close()

    results = []
    for i, row in enumerate(rows):
        db_id = row["id"]
        name = row["name"]
        db_lat = row["lat"]
        db_lon = row["lon"]
        address = row["address"]

        print(f"[{i+1}/{SAMPLE_SIZE}] {name} — {address}")

        nom_lat, nom_lon, nom_display = geocode(address)

        if nom_lat is not None:
            dist = haversine(db_lat, db_lon, nom_lat, nom_lon)
            mismatch = dist > DISTANCE_THRESHOLD_M
            status = "MISMATCH" if mismatch else "OK"
        else:
            dist = None
            mismatch = None
            status = "GEOCODE_FAILED"

        entry = {
            "id": db_id,
            "name": name,
            "address": address,
            "db_lat": db_lat,
            "db_lon": db_lon,
            "nominatim_lat": nom_lat,
            "nominatim_lon": nom_lon,
            "nominatim_display": nom_display,
            "distance_m": round(dist, 1) if dist is not None else None,
            "mismatch": mismatch,
            "status": status,
        }
        results.append(entry)
        print(f"  -> {status}  dist={round(dist, 1) if dist is not None else 'N/A'}m")

        if i < len(rows) - 1:
            time.sleep(1.1)

    mismatches = [r for r in results if r["status"] == "MISMATCH"]
    ok = [r for r in results if r["status"] == "OK"]
    failed = [r for r in results if r["status"] == "GEOCODE_FAILED"]

    report = {
        "audit_date": "2026-03-28",
        "total_checked": len(results),
        "ok_count": len(ok),
        "mismatch_count": len(mismatches),
        "geocode_failed_count": len(failed),
        "threshold_m": DISTANCE_THRESHOLD_M,
        "results": results,
    }

    with open(OUTPUT_PATH, "w") as f:
        json.dump(report, f, indent=2, ensure_ascii=False)

    print(f"\nDone. {len(ok)} OK, {len(mismatches)} mismatches, {len(failed)} failed.")
    print(f"Results saved to {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
