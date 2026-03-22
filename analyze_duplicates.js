#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Load the highlights.json file
const highlightsPath = path.join(__dirname, 'highlights.json');
const highlights = JSON.parse(fs.readFileSync(highlightsPath, 'utf8'));

// Function to round coordinates to 4 decimal places
function roundCoord(coord) {
    return Math.round(coord * 10000) / 10000;
}

// Group bars by coordinates (rounded to 4 decimal places)
const coordGroups = {};
highlights.forEach((bar, index) => {
    const lat = roundCoord(bar.lat);
    const lon = roundCoord(bar.lon);
    const coordKey = `${lat},${lon}`;
    
    if (!coordGroups[coordKey]) {
        coordGroups[coordKey] = [];
    }
    
    coordGroups[coordKey].push({
        index,
        name: bar.name,
        address: bar.address || 'No address',
        category: bar.category,
        originalCoords: `${bar.lat},${bar.lon}`
    });
});

// Find duplicates
const duplicates = {};
Object.keys(coordGroups).forEach(coord => {
    if (coordGroups[coord].length > 1) {
        duplicates[coord] = coordGroups[coord];
    }
});

// Log analysis results
console.log('=== DUPLICATE COORDINATES ANALYSIS ===\n');
console.log(`Total bars: ${highlights.length}`);
console.log(`Unique coordinates: ${Object.keys(coordGroups).length}`);
console.log(`Duplicate coordinate groups: ${Object.keys(duplicates).length}\n`);

// Show detailed duplicates
Object.keys(duplicates).forEach(coord => {
    const bars = duplicates[coord];
    console.log(`🔍 ${coord} (${bars.length} bars):`);
    bars.forEach(bar => {
        console.log(`  - "${bar.name}" | ${bar.address} | ${bar.category} (index: ${bar.index})`);
    });
    console.log('');
});

// Look for exact duplicate names
console.log('=== DUPLICATE NAMES ===\n');
const nameGroups = {};
highlights.forEach((bar, index) => {
    if (!nameGroups[bar.name]) {
        nameGroups[bar.name] = [];
    }
    nameGroups[bar.name].push({ index, address: bar.address || 'No address' });
});

Object.keys(nameGroups).forEach(name => {
    if (nameGroups[name].length > 1) {
        console.log(`🏷️  "${name}" appears ${nameGroups[name].length} times:`);
        nameGroups[name].forEach(entry => {
            console.log(`  - Index ${entry.index}: ${entry.address}`);
        });
        console.log('');
    }
});

// Export results for fixing script
fs.writeFileSync(path.join(__dirname, 'duplicates_analysis.json'), JSON.stringify({
    duplicates,
    nameGroups: Object.fromEntries(Object.entries(nameGroups).filter(([_, entries]) => entries.length > 1))
}, null, 2));

console.log('Analysis saved to duplicates_analysis.json');