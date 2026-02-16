#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const https = require('https');
const { URL } = require('url');

// Configuration
const RATE_LIMIT_MS = 1000; // 1 second between requests
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36';

// Load data
const highlightsPath = path.join(__dirname, 'highlights.json');
const duplicatesPath = path.join(__dirname, 'duplicates_analysis.json');

let highlights = JSON.parse(fs.readFileSync(highlightsPath, 'utf8'));
const duplicatesData = JSON.parse(fs.readFileSync(duplicatesPath, 'utf8'));

// Logging
const logPath = path.join(__dirname, 'coordinate_fixes.log');
function log(message) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}\n`;
    console.log(message);
    fs.appendFileSync(logPath, logMessage);
}

// Clear log file
fs.writeFileSync(logPath, `=== Coordinate Fix Log Started at ${new Date().toISOString()} ===\n`);

// Google Maps search function
function searchGoogleMaps(query) {
    return new Promise((resolve, reject) => {
        const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&tbm=map`;
        const url = new URL(searchUrl);
        
        const options = {
            hostname: url.hostname,
            path: url.pathname + url.search,
            method: 'GET',
            headers: {
                'User-Agent': USER_AGENT,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
                'Accept-Encoding': 'gzip, deflate, br',
                'DNT': '1',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1'
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            
            res.on('data', (chunk) => {
                data += chunk;
            });
            
            res.on('end', () => {
                try {
                    // Look for coordinates in the response
                    // Pattern: 53.xxxxx,9.xxxxx or 53.xxxxx,10.xxxxx (Hamburg area)
                    const coordsPattern = /53\.\d{4,},[910]\.\d{4,}/g;
                    const matches = data.match(coordsPattern);
                    
                    if (matches && matches.length > 0) {
                        // Take the first match and parse it
                        const [latStr, lonStr] = matches[0].split(',');
                        const lat = parseFloat(latStr);
                        const lon = parseFloat(lonStr);
                        
                        // Validate coordinates are in Hamburg area
                        if (lat >= 53.4 && lat <= 53.7 && lon >= 9.8 && lon <= 10.3) {
                            resolve({ lat, lon });
                        } else {
                            resolve(null);
                        }
                    } else {
                        resolve(null);
                    }
                } catch (error) {
                    reject(error);
                }
            });
        });

        req.on('error', (error) => {
            reject(error);
        });

        req.end();
    });
}

// Sleep function for rate limiting
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Fix coordinates for a bar
async function fixBarCoordinates(bar, index) {
    log(`\n🔍 Fixing: "${bar.name}" (index ${index})`);
    log(`   Current: ${bar.lat}, ${bar.lon}`);
    log(`   Address: ${bar.address || 'No address'}`);
    
    // Build search query
    let searchQuery = bar.name + ' Hamburg';
    if (bar.address && bar.address !== 'No address') {
        // Extract meaningful address parts
        const address = bar.address.replace(/Eppendorfer Weg,|Eppendorfer Weg \d+,|Eppendorfer Weg$/, 'Eppendorf');
        searchQuery = `${bar.name} ${address} Hamburg`;
    } else if (bar.name.includes('Eppendorf')) {
        searchQuery = `${bar.name} Eppendorf Hamburg`;
    }
    
    log(`   Search: "${searchQuery}"`);
    
    try {
        await sleep(RATE_LIMIT_MS);
        const coords = await searchGoogleMaps(searchQuery);
        
        if (coords) {
            log(`   ✅ Found: ${coords.lat}, ${coords.lon}`);
            highlights[index].lat = coords.lat;
            highlights[index].lon = coords.lon;
            return true;
        } else {
            log(`   ❌ No coordinates found`);
            return false;
        }
    } catch (error) {
        log(`   ⚠️  Error: ${error.message}`);
        return false;
    }
}

// Main fixing function
async function fixDuplicateCoordinates() {
    log('=== STARTING COORDINATE FIXES ===');
    
    let totalFixed = 0;
    let totalAttempted = 0;
    
    // Process each duplicate group
    for (const [coord, bars] of Object.entries(duplicatesData.duplicates)) {
        if (bars.length <= 1) continue;
        
        log(`\n📍 Processing duplicate group: ${coord} (${bars.length} bars)`);
        
        for (const bar of bars) {
            totalAttempted++;
            const success = await fixBarCoordinates(highlights[bar.index], bar.index);
            if (success) totalFixed++;
        }
    }
    
    log(`\n=== COORDINATE FIXES COMPLETE ===`);
    log(`Total attempted: ${totalAttempted}`);
    log(`Successfully fixed: ${totalFixed}`);
    
    return { totalAttempted, totalFixed };
}

// Remove duplicate Restaurant Schoppenhauer
function removeDuplicateRestaurant() {
    log('\n=== REMOVING DUPLICATE RESTAURANT SCHOPPENHAUER ===');
    
    const duplicateIndices = duplicatesData.nameGroups['Restaurant Schoppenhauer']
        .map(entry => entry.index)
        .sort((a, b) => b - a); // Sort descending to remove from end first
    
    log(`Found ${duplicateIndices.length} Restaurant Schoppenhauer entries at indices: ${duplicateIndices.join(', ')}`);
    
    if (duplicateIndices.length > 1) {
        // Remove the last one (highest index)
        const indexToRemove = duplicateIndices[0];
        const removed = highlights.splice(indexToRemove, 1)[0];
        log(`🗑️  Removed duplicate: Index ${indexToRemove} - "${removed.name}" at ${removed.address}`);
        return true;
    }
    
    return false;
}

// Validate no duplicates remain
function validateNoDuplicates() {
    log('\n=== VALIDATION ===');
    
    const coordGroups = {};
    highlights.forEach((bar, index) => {
        const lat = Math.round(bar.lat * 10000) / 10000;
        const lon = Math.round(bar.lon * 10000) / 10000;
        const coordKey = `${lat},${lon}`;
        
        if (!coordGroups[coordKey]) {
            coordGroups[coordKey] = [];
        }
        coordGroups[coordKey].push({ name: bar.name, index });
    });
    
    const remaining = Object.entries(coordGroups).filter(([_, bars]) => bars.length > 1);
    
    if (remaining.length === 0) {
        log('✅ Validation passed: No coordinate duplicates remain');
        return true;
    } else {
        log(`❌ Validation failed: ${remaining.length} duplicate groups remain:`);
        remaining.forEach(([coord, bars]) => {
            log(`   ${coord}: ${bars.map(b => `"${b.name}"`).join(', ')}`);
        });
        return false;
    }
}

// Main execution
async function main() {
    try {
        log('Starting coordinate fixing process...');
        
        // 1. Fix duplicate coordinates
        const results = await fixDuplicateCoordinates();
        
        // 2. Remove duplicate restaurant
        removeDuplicateRestaurant();
        
        // 3. Save the updated file
        const backupPath = path.join(__dirname, `highlights_backup_${Date.now()}.json`);
        fs.writeFileSync(backupPath, JSON.stringify(JSON.parse(fs.readFileSync(highlightsPath, 'utf8')), null, 2));
        log(`\n📋 Backup saved: ${backupPath}`);
        
        fs.writeFileSync(highlightsPath, JSON.stringify(highlights, null, 2));
        log(`💾 Updated highlights.json saved`);
        
        // 4. Validate
        const isValid = validateNoDuplicates();
        
        log(`\n=== SUMMARY ===`);
        log(`Coordinates attempted: ${results.totalAttempted}`);
        log(`Coordinates fixed: ${results.totalFixed}`);
        log(`Duplicates removed: 1 (Restaurant Schoppenhauer)`);
        log(`Final validation: ${isValid ? 'PASSED' : 'FAILED'}`);
        log(`Total bars in file: ${highlights.length}`);
        
        if (isValid) {
            log('\n🎉 All coordinate duplicates have been successfully resolved!');
        } else {
            log('\n⚠️  Some duplicates may remain. Manual review needed.');
        }
        
    } catch (error) {
        log(`\n💥 Error during execution: ${error.message}`);
        console.error(error);
    }
}

// Run it
main();