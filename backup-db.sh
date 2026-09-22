#!/bin/bash
# Barfinder — Datenbanksicherung.
#
# Vorher wurde die .db-Datei mit cp kopiert. Das ist bei eingeschaltetem
# WAL-Modus nicht vollstaendig: die letzten Schreibvorgaenge stehen dann noch
# im Begleitschreiben barfinder.db-wal (hier zeitweise ueber 12 MB) und fehlen
# in der Kopie. Deshalb jetzt ueber die Sicherungsfunktion von SQLite, die
# einen in sich geschlossenen Stand schreibt.

cd /home/openclaw/.openclaw/workspace/barfinder || exit 1
ORDNER="/home/openclaw/.openclaw/workspace/barfinder/backups"
DATUM=$(date +%Y-%m-%d_%H%M)
ZIEL="$ORDNER/barfinder_${DATUM}.db"
mkdir -p "$ORDNER"

node -e "
const db = require('better-sqlite3')('barfinder.db');
db.backup('$ZIEL').then(() => { db.close(); process.exit(0); })
  .catch(e => { console.error('Sicherung fehlgeschlagen:', e.message); process.exit(1); });
" || exit 1

# nur die letzten sieben Staende behalten
ls -1t "$ORDNER"/barfinder_*.db 2>/dev/null | tail -n +8 | xargs -r rm

echo "Sicherung ok: $ZIEL ($(du -sh "$ZIEL" | cut -f1))"
