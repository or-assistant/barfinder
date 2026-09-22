#!/bin/bash
# Barfinder — naechtlicher Lauf.
#
# Reihenfolge: erst sichern, dann Termine holen, dann pruefen.
# Das Skript bricht bewusst NICHT beim ersten Fehler ab (kein set -e):
# ein toter Sammler darf die Sicherung und die Pruefung nicht verhindern.
#
# Aufruf ueber barfinder-nacht.timer, taeglich 04:10.

cd /home/openclaw/.openclaw/workspace/barfinder || exit 1
export PATH="/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin"
DATUM=$(date -Iseconds)
echo "=== Barfinder naechtlicher Lauf $DATUM ==="

echo "--- 1. Datenbank sichern ---"
bash backup-db.sh || echo "❌ Sicherung fehlgeschlagen"

echo "--- 2. Termine einsammeln ---"
timeout 600 node sammler_events.js || echo "❌ Sammler abgebrochen (Bestand bleibt erhalten)"

echo "--- 3. Datenqualitaet ---"
node test_data_quality.js 2>&1 | tail -20 || true

echo "--- 4. Server erreichbar? ---"
for pfad in /api/places /api/hot /api/network-events /api/weather; do
  if curl -sf -m 20 "http://localhost:3002$pfad" > /dev/null; then
    echo "✅ $pfad"
  else
    echo "❌ $pfad antwortet nicht"
  fi
done

echo "--- 5. Bestand ---"
# sqlite3 ist auf dieser Maschine nicht installiert, deshalb ueber node.
node -e "
const db=require('better-sqlite3')('barfinder.db',{readonly:true});
const z=(s)=>{try{return db.prepare(s).get().n}catch(e){return 'n/a'}};
console.log(z('select count(*) n from places')+' Orte');
// Die Spalte heisst vibe_base_score, nicht vibe_score. Das alte Skript fragte
// nach einer Spalte, die es nie gab, und meldete deshalb immer n/a.
console.log(z('select count(*) n from places where vibe_base_score is not null and vibe_base_score>0')+' davon mit VibeScore');
console.log(z('select count(*) n from places where community_score is not null')+' mit Community Score');
" || echo "❌ Datenbank nicht lesbar"

node -e "
const fs=require('fs');
try{const j=JSON.parse(fs.readFileSync('live_events_cache.json','utf8'));
const q=Object.entries(j.quellen||{}).map(([k,v])=>k+(v.ok?':'+v.anzahl:':FEHLER')).join('  ');
console.log(j.anzahl+' Live-Termine  ['+q+']  Stand '+j.generiert);
}catch(e){console.log('keine live_events_cache.json')}"

echo "=== Fertig $(date -Iseconds) ==="
