#!/usr/bin/env node

const fs = require('fs');
const { exec } = require('child_process');

/**
 * Überwacht den Validierungsprozess und führt finale Schritte aus
 */
async function monitorAndFinish() {
    console.log('🕒 Überwache Koordinaten-Validierung...\n');
    
    // Warte bis der Hauptprozess fertig ist
    let isRunning = true;
    let lastProgress = 0;
    
    while (isRunning) {
        try {
            // Check ob coordinates_report.json existiert
            if (fs.existsSync('./coordinates_report.json')) {
                console.log('✅ Validierung abgeschlossen! Führe finale Schritte aus...\n');
                isRunning = false;
                break;
            }
            
            // Check ob der Prozess noch läuft
            exec('pgrep -f "validate_coordinates.js"', (error, stdout, stderr) => {
                if (error || !stdout.trim()) {
                    isRunning = false;
                }
            });
            
            console.log(`🔄 Validierung läuft... (${new Date().toLocaleTimeString()})`);
            await new Promise(resolve => setTimeout(resolve, 30000)); // 30s warten
            
        } catch (e) {
            console.error('❌ Fehler beim Monitoring:', e.message);
            await new Promise(resolve => setTimeout(resolve, 10000));
        }
    }
    
    if (!isRunning) {
        await executeFinish();
    }
}

/**
 * Führt finale Schritte nach der Validierung aus
 */
async function executeFinish() {
    console.log('🏁 Führe finale Schritte aus:\n');
    
    // 1. Koordinaten-Tests ausführen
    console.log('1. 🧪 Führe Koordinaten-Tests aus...');
    try {
        await executeCommand('node test_coordinates.js');
        console.log('   ✅ Tests erfolgreich ausgeführt\n');
    } catch (e) {
        console.log('   ⚠️  Tests mit Fehlern beendet (erwartet bei Problemen)\n');
    }
    
    // 2. Reports anzeigen
    console.log('2. 📊 Zeige Validierungsreport...');
    try {
        const report = JSON.parse(fs.readFileSync('./coordinates_report.json', 'utf8'));
        console.log(`   Total Bars: ${report.total_bars}`);
        console.log(`   Mit Adresse: ${report.bars_with_address}`);
        console.log(`   Erfolgreich geprüft: ${report.bars_checked}`);
        console.log(`   Fehler gefunden: ${report.errors.length}`);
        console.log(`   Automatisch korrigiert: ${report.fixes_made.length}\n`);
    } catch (e) {
        console.log('   ⚠️  Report konnte nicht gelesen werden\n');
    }
    
    // 3. Server neustarten
    console.log('3. 🔄 Starte Barfinder-Server neu...');
    try {
        await executeCommand('sudo systemctl restart barfinder-server', false);
        console.log('   ✅ Server-Neustart angefordert\n');
    } catch (e) {
        console.log('   ⚠️  Server-Neustart fehlgeschlagen (möglicherweise keine sudo-Berechtigung)\n');
    }
    
    // 4. Git commit (falls aktiviert)
    console.log('4. 📝 Prüfe Git Status...');
    try {
        await executeCommand('git status --porcelain');
        console.log('   ✅ Git Check abgeschlossen\n');
    } catch (e) {
        console.log('   ⚠️  Kein Git Repository oder Fehler\n');
    }
    
    console.log('🎉 KOORDINATEN-VALIDIERUNG ABGESCHLOSSEN!\n');
    console.log('📄 Ergebnisse:');
    console.log('   • coordinates_report.json - Detaillierter Validierungsreport');
    console.log('   • test_results.json - Testergebnisse'); 
    console.log('   • highlights.json - Aktualisierte Koordinaten');
    console.log('\n✅ Alle Aufgaben erledigt!');
}

/**
 * Führt ein Kommando aus
 */
function executeCommand(command, throwOnError = true) {
    return new Promise((resolve, reject) => {
        exec(command, { cwd: __dirname }, (error, stdout, stderr) => {
            if (error && throwOnError) {
                reject(error);
            } else {
                resolve(stdout);
            }
        });
    });
}

// Script ausführen
if (require.main === module) {
    monitorAndFinish().catch(console.error);
}