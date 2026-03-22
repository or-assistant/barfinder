#!/usr/bin/env node

const fs = require('fs');

/**
 * Berechnet die Entfernung zwischen zwei Koordinaten in Metern (Haversine-Formel)
 */
function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3; // Earth radius in meters
    const φ1 = lat1 * Math.PI/180;
    const φ2 = lat2 * Math.PI/180;
    const Δφ = (lat2-lat1) * Math.PI/180;
    const Δλ = (lon2-lon1) * Math.PI/180;

    const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
              Math.cos(φ1) * Math.cos(φ2) *
              Math.sin(Δλ/2) * Math.sin(Δλ/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));

    return R * c;
}

/**
 * Stadtteilgrenzen für Hamburg (vereinfachte Bounding Boxes)
 */
const NEIGHBORHOOD_BOUNDS = {
    'St. Pauli': { minLat: 53.545, maxLat: 53.560, minLon: 9.955, maxLon: 9.975 },
    'Altona': { minLat: 53.535, maxLat: 53.560, minLon: 9.935, maxLon: 9.960 },
    'Eppendorf': { minLat: 53.585, maxLat: 53.605, minLon: 9.970, maxLon: 9.995 },
    'Eimsbüttel': { minLat: 53.565, maxLat: 53.580, minLon: 9.950, maxLon: 9.970 },
    'Winterhude': { minLat: 53.580, maxLat: 53.595, minLon: 9.985, maxLon: 10.005 },
    'St. Georg': { minLat: 53.550, maxLat: 53.565, minLon: 10.000, maxLon: 10.020 },
    'Sternschanze': { minLat: 53.560, maxLat: 53.570, minLon: 9.960, maxLon: 9.975 },
    'Harvestehude': { minLat: 53.570, maxLat: 53.585, minLon: 9.990, maxLon: 10.010 },
    'Neustadt': { minLat: 53.545, maxLat: 53.560, minLon: 9.975, maxLon: 9.995 },
    'Altstadt': { minLat: 53.545, maxLat: 53.555, minLon: 9.990, maxLon: 10.005 },
    'Speicherstadt': { minLat: 53.540, maxLat: 53.548, minLon: 9.990, maxLon: 10.010 },
    'HafenCity': { minLat: 53.540, maxLat: 53.548, minLon: 9.998, maxLon: 10.020 },
    'Innenstadt': { minLat: 53.545, maxLat: 53.565, minLon: 9.985, maxLon: 10.005 },
    'Rotherbaum': { minLat: 53.560, maxLat: 53.575, minLon: 9.975, maxLon: 9.995 },
    'Uhlenhorst': { minLat: 53.565, maxLat: 53.575, minLon: 10.005, maxLon: 10.025 },
    'Hoheluft': { minLat: 53.570, maxLat: 53.585, minLon: 9.965, maxLon: 9.980 },
    'Karolinenviertel': { minLat: 53.555, maxLat: 53.565, minLon: 9.965, maxLon: 9.975 },
    'Ottensen': { minLat: 53.545, maxLat: 53.560, minLon: 9.930, maxLon: 9.950 }
};

/**
 * Extrahiert Stadtteil aus Adresse
 */
function extractNeighborhood(address) {
    if (!address) return null;
    
    const parts = address.split(',').map(p => p.trim());
    // Letzter Teil ist meist der Stadtteil
    const lastPart = parts[parts.length - 1];
    
    // Bekannte Stadtteile suchen
    for (const neighborhood of Object.keys(NEIGHBORHOOD_BOUNDS)) {
        if (lastPart.includes(neighborhood)) {
            return neighborhood;
        }
    }
    
    return lastPart;
}

/**
 * Prüft ob Koordinaten im Stadtteil liegen
 */
function isInNeighborhood(lat, lon, neighborhood) {
    const bounds = NEIGHBORHOOD_BOUNDS[neighborhood];
    if (!bounds) return true; // Unbekannte Stadtteile als OK markieren
    
    return lat >= bounds.minLat && lat <= bounds.maxLat && 
           lon >= bounds.minLon && lon <= bounds.maxLon;
}

/**
 * Führt alle Koordinaten-Tests durch
 */
function runCoordinateTests() {
    console.log('🧪 Starte Koordinaten-Tests für Barfinder...\n');
    
    // Lade highlights.json
    let highlights;
    try {
        highlights = JSON.parse(fs.readFileSync('./highlights.json', 'utf8'));
    } catch (e) {
        console.error('❌ Fehler beim Laden von highlights.json:', e.message);
        process.exit(1);
    }
    
    console.log(`📋 ${highlights.length} Bars geladen\n`);
    
    const testResults = {
        timestamp: new Date().toISOString(),
        total_bars: highlights.length,
        tests: {
            has_coordinates: { passed: 0, failed: 0, failures: [] },
            hamburg_latitude: { passed: 0, failed: 0, failures: [] },
            hamburg_longitude: { passed: 0, failed: 0, failures: [] },
            no_duplicate_coords: { passed: 0, failed: 0, failures: [] },
            neighborhood_plausible: { passed: 0, failed: 0, failures: [] }
        },
        summary: { all_passed: 0, some_failed: 0 }
    };
    
    // Test 1: Alle Highlights haben lat/lon
    console.log('🧪 Test 1: Alle Highlights haben Koordinaten');
    highlights.forEach((bar, index) => {
        if (bar.lat && bar.lon && !isNaN(parseFloat(bar.lat)) && !isNaN(parseFloat(bar.lon))) {
            testResults.tests.has_coordinates.passed++;
        } else {
            testResults.tests.has_coordinates.failed++;
            testResults.tests.has_coordinates.failures.push({
                name: bar.name,
                address: bar.address,
                lat: bar.lat,
                lon: bar.lon
            });
        }
    });
    console.log(`   ✅ ${testResults.tests.has_coordinates.passed} OK, ❌ ${testResults.tests.has_coordinates.failed} Fehlerhaft\n`);
    
    // Test 2: Latitude im Hamburg/Schleswig-Holstein Bereich (53.4-54.0)
    console.log('🧪 Test 2: Latitude im Hamburg-Bereich (53.4-54.0)');
    highlights.forEach(bar => {
        if (bar.lat && bar.lat >= 53.4 && bar.lat <= 54.0) {
            testResults.tests.hamburg_latitude.passed++;
        } else {
            testResults.tests.hamburg_latitude.failed++;
            testResults.tests.hamburg_latitude.failures.push({
                name: bar.name,
                address: bar.address,
                lat: bar.lat,
                lon: bar.lon
            });
        }
    });
    console.log(`   ✅ ${testResults.tests.hamburg_latitude.passed} OK, ❌ ${testResults.tests.hamburg_latitude.failed} Außerhalb\n`);
    
    // Test 3: Longitude im Hamburg Bereich (9.5-10.3)
    console.log('🧪 Test 3: Longitude im Hamburg-Bereich (9.5-10.3)');
    highlights.forEach(bar => {
        if (bar.lon && bar.lon >= 9.5 && bar.lon <= 10.3) {
            testResults.tests.hamburg_longitude.passed++;
        } else {
            testResults.tests.hamburg_longitude.failed++;
            testResults.tests.hamburg_longitude.failures.push({
                name: bar.name,
                address: bar.address,
                lat: bar.lat,
                lon: bar.lon
            });
        }
    });
    console.log(`   ✅ ${testResults.tests.hamburg_longitude.passed} OK, ❌ ${testResults.tests.hamburg_longitude.failed} Außerhalb\n`);
    
    // Test 4: Keine zwei Bars mit exakt gleichen Koordinaten
    console.log('🧪 Test 4: Keine Duplikate bei Koordinaten');
    const coordMap = new Map();
    let duplicates = [];
    
    highlights.forEach(bar => {
        if (!bar.lat || !bar.lon) return;
        
        const coordKey = `${bar.lat},${bar.lon}`;
        if (coordMap.has(coordKey)) {
            const existing = coordMap.get(coordKey);
            duplicates.push({
                coordinates: coordKey,
                bars: [existing.name, bar.name],
                addresses: [existing.address, bar.address]
            });
            testResults.tests.no_duplicate_coords.failed++;
        } else {
            coordMap.set(coordKey, { name: bar.name, address: bar.address });
            testResults.tests.no_duplicate_coords.passed++;
        }
    });
    
    testResults.tests.no_duplicate_coords.failures = duplicates;
    console.log(`   ✅ ${testResults.tests.no_duplicate_coords.passed} Unique, ❌ ${testResults.tests.no_duplicate_coords.failed} Duplikate\n`);
    
    // Test 5: Bars mit Adresse liegen plausibel im angegebenen Stadtteil
    console.log('🧪 Test 5: Plausibilität Koordinaten vs. Stadtteil');
    highlights.forEach(bar => {
        if (!bar.address || !bar.lat || !bar.lon) {
            testResults.tests.neighborhood_plausible.passed++; // Skip bars ohne Adresse
            return;
        }
        
        const neighborhood = extractNeighborhood(bar.address);
        const isPlausible = isInNeighborhood(bar.lat, bar.lon, neighborhood);
        
        if (isPlausible) {
            testResults.tests.neighborhood_plausible.passed++;
        } else {
            testResults.tests.neighborhood_plausible.failed++;
            testResults.tests.neighborhood_plausible.failures.push({
                name: bar.name,
                address: bar.address,
                neighborhood: neighborhood,
                lat: bar.lat,
                lon: bar.lon
            });
        }
    });
    console.log(`   ✅ ${testResults.tests.neighborhood_plausible.passed} Plausibel, ❌ ${testResults.tests.neighborhood_plausible.failed} Verdächtig\n`);
    
    // Gesamtstatistik
    const totalPassed = Object.values(testResults.tests).reduce((sum, test) => sum + test.passed, 0);
    const totalFailed = Object.values(testResults.tests).reduce((sum, test) => sum + test.failed, 0);
    
    testResults.summary.all_passed = highlights.filter(bar => {
        const hasCoords = bar.lat && bar.lon && !isNaN(parseFloat(bar.lat)) && !isNaN(parseFloat(bar.lon));
        const validLat = bar.lat && bar.lat >= 53.4 && bar.lat <= 54.0;
        const validLon = bar.lon && bar.lon >= 9.5 && bar.lon <= 10.3;
        const neighborhood = extractNeighborhood(bar.address);
        const plausible = !bar.address || isInNeighborhood(bar.lat, bar.lon, neighborhood);
        
        return hasCoords && validLat && validLon && plausible;
    }).length;
    
    testResults.summary.some_failed = highlights.length - testResults.summary.all_passed;
    
    // Speichere Testergebnisse
    fs.writeFileSync('./test_results.json', JSON.stringify(testResults, null, 2));
    
    // Zusammenfassung ausgeben
    console.log('='.repeat(50));
    console.log('📊 TEST-ZUSAMMENFASSUNG');
    console.log('='.repeat(50));
    console.log(`Total Tests: ${totalPassed + totalFailed}`);
    console.log(`✅ Bestanden: ${totalPassed}`);
    console.log(`❌ Fehlgeschlagen: ${totalFailed}`);
    console.log(`📊 Erfolgsrate: ${Math.round(totalPassed/(totalPassed + totalFailed)*100)}%`);
    
    console.log('\n📋 DETAILERGEBNISSE:');
    Object.entries(testResults.tests).forEach(([testName, result]) => {
        const status = result.failed === 0 ? '✅' : '⚠️';
        console.log(`${status} ${testName}: ${result.passed} OK, ${result.failed} Fehler`);
    });
    
    if (totalFailed > 0) {
        console.log('\n⚠️  FEHLERHAFTE BARS:');
        Object.entries(testResults.tests).forEach(([testName, result]) => {
            if (result.failed > 0 && result.failures.length > 0) {
                console.log(`\n${testName}:`);
                result.failures.slice(0, 5).forEach(failure => {
                    if (failure.bars) {
                        console.log(`  • ${failure.coordinates}: ${failure.bars.join(' & ')}`);
                    } else {
                        console.log(`  • ${failure.name} (${failure.lat}, ${failure.lon})`);
                    }
                });
                if (result.failures.length > 5) {
                    console.log(`  ... und ${result.failures.length - 5} weitere`);
                }
            }
        });
    }
    
    console.log(`\n✅ Testergebnisse gespeichert: test_results.json`);
    
    // Exit mit Error Code wenn Tests fehlschlagen
    if (totalFailed > 0) {
        process.exit(1);
    } else {
        console.log('\n🎉 Alle Tests bestanden!');
        process.exit(0);
    }
}

// Script ausführen
if (require.main === module) {
    runCoordinateTests();
}

module.exports = { runCoordinateTests, calculateDistance, extractNeighborhood, isInNeighborhood };