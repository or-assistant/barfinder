#!/usr/bin/env node

const fs = require('fs');
const https = require('https');
const { URL } = require('url');

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
 * Schläft für angegebene Millisekunden (für Rate-Limiting)
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Nominatim-Abfrage mit Rate-Limiting
 */
async function queryNominatim(address) {
    const query = `${address}+Hamburg`;
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`;
    
    console.log(`🔍 Querying: ${address}`);
    
    return new Promise((resolve, reject) => {
        const req = https.get(url, {
            headers: {
                'User-Agent': 'BarfinderCoordCheck/1.0'
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    resolve(json);
                } catch (e) {
                    reject(e);
                }
            });
        });
        
        req.on('error', reject);
        req.setTimeout(10000, () => {
            req.destroy();
            reject(new Error('Request timeout'));
        });
    });
}

/**
 * Versucht verschiedene Varianten einer Adresse
 */
async function tryAddressVariants(address) {
    let result = null;
    
    // Erste Variante: Vollständige Adresse
    try {
        result = await queryNominatim(address);
        if (result && result.length > 0) {
            return result;
        }
    } catch (e) {
        console.log(`  ⚠️  Fehler bei vollständiger Adresse: ${e.message}`);
    }
    
    // Zweite Variante: Nur Straßenname ohne Hausnummer
    const streetMatch = address.match(/^([^0-9]+)/);
    if (streetMatch) {
        const streetName = streetMatch[1].trim().replace(/,$/, '');
        console.log(`  🔄 Versuche nur Straße: ${streetName}`);
        
        await sleep(1100); // Rate limiting
        
        try {
            result = await queryNominatim(streetName);
            if (result && result.length > 0) {
                return result;
            }
        } catch (e) {
            console.log(`  ⚠️  Fehler bei Straßenname: ${e.message}`);
        }
    }
    
    return [];
}

/**
 * Hauptfunktion zur Koordinaten-Validierung
 */
async function validateCoordinates() {
    console.log('🚀 Starte Koordinaten-Validierung für Barfinder...\n');
    
    // Lade highlights.json
    const highlights = JSON.parse(fs.readFileSync('./highlights.json', 'utf8'));
    console.log(`📋 ${highlights.length} Bars geladen\n`);
    
    const report = {
        timestamp: new Date().toISOString(),
        total_bars: highlights.length,
        bars_with_address: 0,
        bars_checked: 0,
        errors: [],
        fixes_made: [],
        skipped: []
    };
    
    let fixCount = 0;
    
    for (let i = 0; i < highlights.length; i++) {
        const bar = highlights[i];
        const progress = `[${i + 1}/${highlights.length}]`;
        
        // Skip bars ohne Adresse
        if (!bar.address) {
            console.log(`${progress} ⏭️  ${bar.name} - Keine Adresse`);
            report.skipped.push({
                name: bar.name,
                reason: 'no_address'
            });
            continue;
        }
        
        // Skip bars ohne Koordinaten
        if (!bar.lat || !bar.lon) {
            console.log(`${progress} ⏭️  ${bar.name} - Keine Koordinaten`);
            report.skipped.push({
                name: bar.name,
                address: bar.address,
                reason: 'no_coordinates'
            });
            continue;
        }
        
        report.bars_with_address++;
        console.log(`${progress} 📍 ${bar.name} - ${bar.address}`);
        console.log(`  📋 Gespeichert: ${bar.lat}, ${bar.lon}`);
        
        try {
            const results = await tryAddressVariants(bar.address);
            
            if (results.length === 0) {
                console.log(`  ❌ Keine Nominatim-Ergebnisse gefunden`);
                report.errors.push({
                    name: bar.name,
                    address: bar.address,
                    stored_lat: bar.lat,
                    stored_lon: bar.lon,
                    error: 'no_nominatim_results'
                });
            } else {
                const nominatimLat = parseFloat(results[0].lat);
                const nominatimLon = parseFloat(results[0].lon);
                const distance = calculateDistance(bar.lat, bar.lon, nominatimLat, nominatimLon);
                
                console.log(`  🌍 Nominatim: ${nominatimLat}, ${nominatimLon}`);
                console.log(`  📏 Abweichung: ${Math.round(distance)}m`);
                
                if (distance > 300) {
                    console.log(`  ⚠️  FEHLER: Abweichung > 300m!`);
                    
                    const errorInfo = {
                        name: bar.name,
                        address: bar.address,
                        stored_lat: bar.lat,
                        stored_lon: bar.lon,
                        nominatim_lat: nominatimLat,
                        nominatim_lon: nominatimLon,
                        distance_meters: Math.round(distance),
                        nominatim_display_name: results[0].display_name
                    };
                    
                    report.errors.push(errorInfo);
                    
                    // Automatische Korrektur
                    const oldLat = bar.lat;
                    const oldLon = bar.lon;
                    bar.lat = nominatimLat;
                    bar.lon = nominatimLon;
                    
                    const fixInfo = {
                        name: bar.name,
                        address: bar.address,
                        old_coordinates: [oldLat, oldLon],
                        new_coordinates: [nominatimLat, nominatimLon],
                        distance_corrected: Math.round(distance)
                    };
                    
                    report.fixes_made.push(fixInfo);
                    fixCount++;
                    
                    console.log(`  ✅ Korrigiert: ${oldLat}, ${oldLon} → ${nominatimLat}, ${nominatimLon}`);
                } else {
                    console.log(`  ✅ OK (${Math.round(distance)}m)`);
                }
                
                report.bars_checked++;
            }
            
        } catch (error) {
            console.log(`  ❌ Fehler bei Nominatim-Abfrage: ${error.message}`);
            report.errors.push({
                name: bar.name,
                address: bar.address,
                stored_lat: bar.lat,
                stored_lon: bar.lon,
                error: `nominatim_error: ${error.message}`
            });
        }
        
        // Rate-Limiting: 1 Sekunde zwischen Anfragen
        if (i < highlights.length - 1) {
            await sleep(1100);
        }
        
        console.log(''); // Leerzeile für bessere Lesbarkeit
    }
    
    // Speichere korrigierte highlights.json
    if (fixCount > 0) {
        console.log(`💾 Speichere korrigierte highlights.json mit ${fixCount} Fixes...`);
        fs.writeFileSync('./highlights.json', JSON.stringify(highlights, null, 2));
    }
    
    // Speichere Report
    console.log('📄 Erstelle Coordinate Report...');
    fs.writeFileSync('./coordinates_report.json', JSON.stringify(report, null, 2));
    
    // Zusammenfassung
    console.log('\n' + '='.repeat(50));
    console.log('📊 VALIDIERUNGS-ZUSAMMENFASSUNG');
    console.log('='.repeat(50));
    console.log(`Total Bars: ${report.total_bars}`);
    console.log(`Mit Adresse: ${report.bars_with_address}`);
    console.log(`Erfolgreich geprüft: ${report.bars_checked}`);
    console.log(`Fehler gefunden: ${report.errors.length}`);
    console.log(`Automatisch korrigiert: ${report.fixes_made.length}`);
    console.log(`Übersprungen: ${report.skipped.length}`);
    
    if (report.fixes_made.length > 0) {
        console.log('\n🔧 VORGENOMMENE KORREKTUREN:');
        report.fixes_made.forEach(fix => {
            console.log(`  • ${fix.name}: ${fix.distance_corrected}m korrigiert`);
        });
    }
    
    if (report.errors.filter(e => e.error !== 'no_nominatim_results').length > 0) {
        console.log('\n⚠️  VERBLEIBENDE PROBLEME:');
        report.errors.filter(e => e.error !== 'no_nominatim_results').forEach(error => {
            console.log(`  • ${error.name}: ${error.error}`);
        });
    }
    
    console.log(`\n✅ Report gespeichert: coordinates_report.json`);
    console.log(`✅ Highlights aktualisiert: highlights.json`);
}

// Script ausführen
if (require.main === module) {
    validateCoordinates().catch(console.error);
}

module.exports = { validateCoordinates, calculateDistance };