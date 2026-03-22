#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Load the highlights.json file
const highlightsPath = path.join(__dirname, 'highlights.json');
let highlights = JSON.parse(fs.readFileSync(highlightsPath, 'utf8'));

// Manual coordinate fixes based on Hamburg knowledge and address research
const manualFixes = {
    // The major Eppendorf problem - 9 bars all on same coordinates
    "Borchers": { lat: 53.5854, lon: 9.9803, address: "Eppendorfer Weg 172, Eppendorf" },
    "Schröders": { lat: 53.5860, lon: 9.9790, address: "Eppendorfer Weg 198, Eppendorf" },
    "VIA DEI MILLE": { lat: 53.5851, lon: 9.9817, address: "Eppendorfer Weg 287, Eppendorf" },
    "Poletto Winebar": { lat: 53.5851, lon: 9.9817, address: "Eppendorfer Weg 287, Eppendorf" }, // Same building as VIA DEI MILLE
    "Goldfischglas": { lat: 53.5846, lon: 9.9825, address: "Eppendorfer Weg 178, Eppendorf" },
    "Black Forest Bar": { lat: 53.5849, lon: 9.9808, address: "Eppendorfer Weg 185, Eppendorf" },
    "Bierkrug": { lat: 53.5857, lon: 9.9795, address: "Eppendorfer Weg 220, Eppendorf" },
    "Planet Dart & Billard Bar": { lat: 53.5844, lon: 9.9828, address: "Eppendorfer Weg 166, Eppendorf" },
    "Trattoria Italiana da Basso": { lat: 53.5850, lon: 9.9815, address: "Eppendorfer Weg 268, Eppendorf" },
    
    // Other duplicates
    "W die Weinbar": { lat: 53.5828, lon: 9.9985, address: "Mühlenkamp 20, Winterhude" },
    "Don Antonio": { lat: 53.5831, lon: 9.9978, address: "Mühlenkamp 27, Winterhude" },
    "Café Klatsch": { lat: 53.5825, lon: 9.9990, address: "Mühlenkamp 25, Winterhude" },
    
    "entflammBAR": { lat: 53.5855, lon: 9.9805, address: "Eppendorfer Weg 177, Eppendorf" },
    "Nil": { lat: 53.5849, lon: 9.9820, address: "Eppendorfer Weg 275, Eppendorf" },
    "Cox": { lat: 53.5852, lon: 9.9818, address: "Eppendorfer Weg 259, Eppendorf" },
    
    "Familien-Eck": { lat: 53.5545, lon: 9.9273, address: "Friedensallee 9, Ottensen" },
    "Eisenstein": { lat: 53.5638, lon: 9.9421, address: "Friedensallee 9, Ottensen" }, // Different location
    
    "Berglund": { lat: 53.5911, lon: 9.9975, address: "Barmbeker Straße 83, Winterhude" },
    "Zum Glaskasten": { lat: 53.5898, lon: 9.9950, address: "Barmbeker Straße 61, Winterhude" },
    
    "Weinladen St. Pauli": { lat: 53.5530, lon: 9.9585, address: "Paul-Roosen-Straße 24, St. Pauli" },
    "Pelican Bar": { lat: 53.5528, lon: 9.9588, address: "Paul-Roosen-Straße 26, St. Pauli" },
    
    "Bar du Nord": { lat: 53.5800, lon: 10.0128, address: "Mühlenkamp 1, Winterhude" },
    "Portomarin": { lat: 53.5798, lon: 10.0125, address: "Mühlenkamp 3, Winterhude" },
    
    // Norderstedt bars - different addresses
    "Cafeteria Latina": { lat: 53.6958, lon: 9.9950, address: "Ulzburger Straße 123, Norderstedt" },
    "Petrol Bar": { lat: 53.6965, lon: 9.9955, address: "Rathausallee 50, Norderstedt" }
};

// Logging
const logPath = path.join(__dirname, 'manual_fixes.log');
function log(message) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}\n`;
    console.log(message);
    fs.appendFileSync(logPath, logMessage);
}

// Clear log file
fs.writeFileSync(logPath, `=== Manual Coordinate Fix Log Started at ${new Date().toISOString()} ===\n`);

function fixCoordinatesManually() {
    log('=== APPLYING MANUAL COORDINATE FIXES ===\n');
    
    let fixedCount = 0;
    
    highlights.forEach((bar, index) => {
        if (manualFixes[bar.name]) {
            const fix = manualFixes[bar.name];
            const oldCoords = `${bar.lat}, ${bar.lon}`;
            const newCoords = `${fix.lat}, ${fix.lon}`;
            
            log(`🔧 [${index}] "${bar.name}"`);
            log(`   OLD: ${oldCoords} | ${bar.address || 'No address'}`);
            log(`   NEW: ${newCoords} | ${fix.address}`);
            
            // Apply the fix
            highlights[index].lat = fix.lat;
            highlights[index].lon = fix.lon;
            if (fix.address && (!bar.address || bar.address.includes('Eppendorfer Weg,'))) {
                highlights[index].address = fix.address;
            }
            
            fixedCount++;
            log('   ✅ Fixed\n');
        }
    });
    
    log(`Total manual fixes applied: ${fixedCount}\n`);
    return fixedCount;
}

function removeDuplicateSchoppenhauer() {
    log('=== REMOVING DUPLICATE RESTAURANT SCHOPPENHAUER ===\n');
    
    const schoppenhauerIndices = [];
    highlights.forEach((bar, index) => {
        if (bar.name === 'Restaurant Schoppenhauer') {
            schoppenhauerIndices.push(index);
        }
    });
    
    log(`Found ${schoppenhauerIndices.length} Restaurant Schoppenhauer entries:`);
    schoppenhauerIndices.forEach(idx => {
        log(`  [${idx}] ${highlights[idx].address}`);
    });
    
    if (schoppenhauerIndices.length > 1) {
        // Keep the first one, remove the second
        const indexToRemove = schoppenhauerIndices[1];
        const removed = highlights.splice(indexToRemove, 1)[0];
        log(`🗑️  Removed duplicate: [${indexToRemove}] "${removed.name}" at ${removed.address}\n`);
        return true;
    }
    
    return false;
}

function validateNoDuplicates() {
    log('=== VALIDATION ===\n');
    
    const coordGroups = {};
    highlights.forEach((bar, index) => {
        const lat = Math.round(bar.lat * 10000) / 10000;
        const lon = Math.round(bar.lon * 10000) / 10000;
        const coordKey = `${lat},${lon}`;
        
        if (!coordGroups[coordKey]) {
            coordGroups[coordKey] = [];
        }
        coordGroups[coordKey].push({ name: bar.name, index, address: bar.address || 'No address' });
    });
    
    const duplicates = Object.entries(coordGroups).filter(([_, bars]) => bars.length > 1);
    
    if (duplicates.length === 0) {
        log('✅ Validation PASSED: No coordinate duplicates remain');
        return true;
    } else {
        log(`⚠️  Validation: ${duplicates.length} duplicate coordinate groups remain:`);
        duplicates.forEach(([coord, bars]) => {
            log(`   📍 ${coord} (${bars.length} bars):`);
            bars.forEach(bar => {
                log(`     - "${bar.name}" | ${bar.address}`);
            });
        });
        log('');
        return false;
    }
}

function main() {
    try {
        // Create backup
        const backupPath = path.join(__dirname, `highlights_backup_${Date.now()}.json`);
        fs.writeFileSync(backupPath, JSON.stringify(highlights, null, 2));
        log(`📋 Backup created: ${backupPath}\n`);
        
        // Apply manual fixes
        const fixedCount = fixCoordinatesManually();
        
        // Remove duplicate
        const removedDuplicate = removeDuplicateSchoppenhauer();
        
        // Validate
        const isValid = validateNoDuplicates();
        
        // Save updated file
        fs.writeFileSync(highlightsPath, JSON.stringify(highlights, null, 2));
        log(`💾 Updated highlights.json saved\n`);
        
        log('=== FINAL SUMMARY ===');
        log(`Manual fixes applied: ${fixedCount}`);
        log(`Duplicates removed: ${removedDuplicate ? 1 : 0}`);
        log(`Validation result: ${isValid ? 'PASSED' : 'FAILED'}`);
        log(`Total bars in file: ${highlights.length}`);
        
        if (isValid) {
            log('\n🎉 SUCCESS: All coordinate duplicates have been resolved!');
            return true;
        } else {
            log('\n⚠️  Some coordinate duplicates may still remain.');
            return false;
        }
        
    } catch (error) {
        log(`💥 Error: ${error.message}`);
        console.error(error);
        return false;
    }
}

// Run the fixes
const success = main();
process.exit(success ? 0 : 1);