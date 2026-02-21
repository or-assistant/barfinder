# Barfinder Expansion Report
## 2026-02-17

### Summary
- **Before:** 2,306 locations
- **After:** 5,231 locations
- **New:** 2,925 locations (after cleaning 43 bad categories)

### Source Breakdown
- overpass: 5,135
- manual: 96

### New Locations by Category
- restaurant: 1,749
- cafe: 747
- pub: 238
- bar: 156
- nightclub: 19
- biergarten: 12
- cocktailbar: 4

### Coverage Areas Queried
1. Hamburg Center (53.55, 10.0) r=15km - 4,041 elements
2. Hamburg Nord (53.65, 10.0) r=12km - 3,441 elements
3. Hamburg West/Altona (53.55, 9.85) r=12km - 3,094 elements
4. Hamburg Ost/Wandsbek (53.55, 10.15) r=12km - 2,373 elements
5. Hamburg Sud/Harburg (53.45, 10.0) r=12km - 1,638 elements
6. Norderstedt/Langenhorn (53.70, 10.0) r=10km - 434 elements
7. Pinneberg/Schenefeld (53.66, 9.80) r=10km - 269 elements
8. Ahrensburg/Volksdorf (53.67, 10.22) r=10km - 310 elements
9. Quickborn/Hasloh (53.72, 9.88) r=8km - 115 elements
10. Rahlstedt/Stapelfeld (53.60, 10.30) r=8km - 70 elements

### Method
- Phase 1: Overpass API bulk scrape across 10 center points covering Hamburg + Speckgurtel
- Deduplication by name + coordinate proximity (<500m)
- Categories mapped from OSM amenity/cuisine tags
- All coordinates verified via Overpass API
- Cleaned out non-venue categories (public_bookcase, public_bath, internet_cafe)

### Quality
- All coordinates from Overpass (verified OSM data)
- No guessed coordinates
- No em-dashes used
- Deduplicated against all existing entries
