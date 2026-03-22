#!/usr/bin/env node

const fs = require('fs');

// Load existing data
const highlights = JSON.parse(fs.readFileSync('highlights.json', 'utf8'));
const existingReport = JSON.parse(fs.readFileSync('verification_report.json', 'utf8'));

// Find which bars are already verified
const verifiedNames = new Set(existingReport.map(bar => bar.name));
const unverifiedBars = highlights.filter(bar => !verifiedNames.has(bar.name));

console.log(`Total highlights: ${highlights.length}`);
console.log(`Already verified: ${existingReport.length}`);
console.log(`Need to verify: ${unverifiedBars.length}`);

if (unverifiedBars.length > 0) {
    console.log('\nBars that need verification:');
    unverifiedBars.forEach((bar, i) => {
        console.log(`${i+1}. ${bar.name} - ${bar.address}`);
    });
}

// Function to search Nominatim
async function searchNominatim(name, city = 'Hamburg') {
    const query = encodeURIComponent(`${name} ${city}`);
    const url = `https://nominatim.openstreetmap.org/search?q=${query}&format=json&limit=1`;
    
    try {
        const response = await fetch(url);
        const data = await response.json();
        return data.length > 0 ? data[0] : null;
    } catch (error) {
        console.error(`Error searching for ${name}:`, error.message);
        return null;
    }
}

// Function to search by address if name search fails
async function searchByAddress(address) {
    const query = encodeURIComponent(`${address} Hamburg`);
    const url = `https://nominatim.openstreetmap.org/search?q=${query}&format=json&limit=1`;
    
    try {
        const response = await fetch(url);
        const data = await response.json();
        return data.length > 0 ? data[0] : null;
    } catch (error) {
        console.error(`Error searching by address ${address}:`, error.message);
        return null;
    }
}

// Complete verification for remaining bars
async function completeVerification() {
    const newEntries = [];
    
    for (let i = 0; i < unverifiedBars.length; i++) {
        const bar = unverifiedBars[i];
        console.log(`\nVerifying ${i+1}/${unverifiedBars.length}: ${bar.name}`);
        
        // Try searching by name first
        let match = await searchNominatim(bar.name);
        let status = 'not_found';
        let notes = 'Not found via Nominatim search';
        let verification_attempts = [];
        
        verification_attempts.push({
            method: 'name_search',
            query: `${bar.name} Hamburg`,
            found: match !== null
        });
        
        if (match) {
            status = 'verified';
            notes = 'Found in OpenStreetMap with high confidence';
        } else {
            // Try searching by address
            console.log(`  Name search failed, trying address: ${bar.address}`);
            match = await searchByAddress(bar.address);
            
            verification_attempts.push({
                method: 'address_search', 
                query: `${bar.address} Hamburg`,
                found: match !== null
            });
            
            if (match) {
                status = 'verified';
                notes = 'Found via address search in OpenStreetMap';
            }
        }
        
        const entry = {
            name: bar.name,
            address: bar.address,
            website: bar.website || '',
            status: status,
            source: match ? 'osm' : 'none',
            notes: notes,
            verification_attempts: verification_attempts
        };
        
        if (match) {
            entry.nominatim_match = {
                display_name: match.display_name,
                lat: parseFloat(match.lat),
                lon: parseFloat(match.lon),
                osm_type: match.osm_type,
                osm_id: match.osm_id
            };
        } else {
            entry.nominatim_match = null;
        }
        
        newEntries.push(entry);
        
        // Wait 1.1 seconds between requests (rate limit)
        if (i < unverifiedBars.length - 1) {
            console.log('  Waiting 1.1 seconds...');
            await new Promise(resolve => setTimeout(resolve, 1100));
        }
    }
    
    // Merge with existing report
    const completeReport = [...existingReport, ...newEntries];
    
    // Sort by name for consistency
    completeReport.sort((a, b) => a.name.localeCompare(b.name));
    
    // Write updated report
    fs.writeFileSync('verification_report.json', JSON.stringify(completeReport, null, 2));
    
    console.log(`\nVerification complete! Total entries: ${completeReport.length}`);
    
    // Summary stats
    const verified = completeReport.filter(bar => bar.status === 'verified').length;
    const notFound = completeReport.filter(bar => bar.status === 'not_found').length;
    
    console.log(`Verified: ${verified}`);
    console.log(`Not found: ${notFound}`);
    
    return completeReport;
}

// Only run if this script is executed directly
if (require.main === module) {
    completeVerification().catch(console.error);
}

module.exports = { completeVerification };