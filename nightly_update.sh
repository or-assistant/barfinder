#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# 🌙 NIGHTLY UPDATE — Barfinder Hamburg
# ═══════════════════════════════════════════════════════════════
# Scrapt alle Quellen, startet Server neu, führt Tests aus.
# Läuft täglich um 04:00 CET (03:00 UTC) via OpenClaw Cron.
# ═══════════════════════════════════════════════════════════════

set -o pipefail
SCRIPT_DIR="/home/openclaw/.openclaw/workspace/barfinder"
cd "$SCRIPT_DIR" || exit 1

mkdir -p logs
DATE=$(date '+%Y-%m-%d')
LOG="logs/nightly_${DATE}.log"
ERROR_LOG="logs/errors.log"
PID_FILE="nightly.pid"
HAS_ERROR=0

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG"; }
err() { log "ERROR: $1"; echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$ERROR_LOG"; HAS_ERROR=1; }

# Lock
if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  err "Already running (PID $(cat "$PID_FILE"))"
  exit 1
fi
echo $$ > "$PID_FILE"
trap 'rm -f "$PID_FILE"' EXIT

log "═══ Nightly Update gestartet ═══"

# ── Scrapers ──
run_scraper() {
  local name="$1" script="$2"
  if [ -f "$SCRIPT_DIR/$script" ]; then
    log "▶ $name ($script)..."
    if timeout 300 node "$script" >> "$LOG" 2>&1; then
      log "✅ $name fertig"
    else
      err "$name fehlgeschlagen (exit $?)"
    fi
  else
    log "⏭️ $name übersprungen ($script nicht vorhanden)"
  fi
}

run_scraper "Bar Events" "scrape_bar_events.js"
run_scraper "Hamburg Sources" "scrape_hamburg_sources.js"
run_scraper "Hamburg Events" "scrape_hamburg_events.js"
run_scraper "Events Pipeline" "scrape_events_pipeline.js"
run_scraper "Eventbrite Hamburg" "scrape_eventbrite.js"
run_scraper "Ecosystem Events" "scrape_ecosystem_events.js"
run_scraper "Yelp Reviews" "scrape_yelp_reviews.js"
run_scraper "New Sources (Startupcity, MOPO etc.)" "scrape_new_sources.js"
run_scraper "Mit Vergnügen Hamburg" "scrape_mitvergnuegen.js"
run_scraper "OpenTable Hamburg" "scrape_opentable.js"
run_scraper "Hamburg Digital Ecosystem" "scrape_hamburgwork.js"
run_scraper "Rural Events (Lentföhrden)" "scrape_rural_events.js"

# Google Ratings nur Sonntags
DOW=$(date '+%u')  # 7 = Sonntag
if [ "$DOW" -eq 7 ]; then
  log "📅 Sonntag → Google Ratings Refresh"
  run_scraper "Google Ratings" "scrape_ratings_batch.js"
else
  log "📅 Kein Sonntag → Google Ratings übersprungen"
fi

# ── Server Restart ──
log "🔄 Server neustarten..."
if systemctl is-active --quiet barfinder-server; then
  if sudo systemctl restart barfinder-server 2>>"$LOG"; then
    sleep 3
    log "✅ Server neugestartet"
  else
    err "Server Restart fehlgeschlagen"
  fi
else
  log "⚠️ barfinder-server nicht aktiv, überspringe Restart"
fi

# ── Tests ──
log "🧪 Tests starten..."
if node test_barfinder.js >> "$LOG" 2>&1; then
  log "✅ Alle Tests bestanden"
else
  err "Tests fehlgeschlagen"
fi

# Location plausibility check
log "🗺️ Standort-Plausibilitätscheck..."
if node validate_locations.js >> "$LOG" 2>&1; then
  log "✅ Alle Standorte plausibel"
else
  err "⚠️ Verdächtige Koordinaten gefunden — siehe location_issues.json"
fi

# ── Data Enrichment ──
log "📊 Running data enrichment..."
node enrich_data.js 2>&1 | tee -a "$LOG_FILE"

# ── Quality Check ──
log "🔍 Running quality check..."
node quality_check.js 2>&1 | tee -a "$LOG_FILE"

# ── DB Re-Sync ──
log "🗄️ Re-syncing SQLite DB..."
node migrate_to_db.js 2>&1 | tee -a "$LOG_FILE"

# ── Summary ──
log "═══ Nightly Update beendet (Fehler: $HAS_ERROR) ═══"

# Log rotation (max 50 logs)
ls -t logs/nightly_*.log 2>/dev/null | tail -n +51 | xargs -r rm

exit $HAS_ERROR
