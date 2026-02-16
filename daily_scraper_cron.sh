#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# 📅 DAILY EVENT SCRAPER CRON JOB für Barfinder Hamburg
# ═══════════════════════════════════════════════════════════════
# Läuft täglich um 06:00 Uhr und scrapt Events für aktuellen HotScore
#
# INSTALLATION:
# chmod +x daily_scraper_cron.sh
# crontab -e
# 0 6 * * * /home/openclaw/.openclaw/workspace/barfinder/daily_scraper_cron.sh
# ═══════════════════════════════════════════════════════════════

# Konfiguration
SCRIPT_DIR="/home/openclaw/.openclaw/workspace/barfinder"
VENV_PATH="$SCRIPT_DIR/venv"
PYTHON_SCRIPT="$SCRIPT_DIR/final_event_scraper.py"
LOG_FILE="$SCRIPT_DIR/daily_scraper.log"
PID_FILE="$SCRIPT_DIR/scraper.pid"
MAX_LOG_SIZE=10485760  # 10MB

# Logging-Funktion
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
}

# Prüfe ob bereits läuft
if [ -f "$PID_FILE" ]; then
    if kill -0 `cat "$PID_FILE"` 2>/dev/null; then
        log "ERROR: Scraper already running (PID: $(cat $PID_FILE))"
        exit 1
    else
        log "WARN: Stale PID file removed"
        rm "$PID_FILE"
    fi
fi

# Starte Scraping
log "INFO: Starting daily event scraper..."
echo $$ > "$PID_FILE"

# Wechsle ins richtige Verzeichnis
cd "$SCRIPT_DIR" || {
    log "ERROR: Cannot change to script directory"
    rm -f "$PID_FILE"
    exit 1
}

# Aktiviere Virtual Environment
if [ -f "$VENV_PATH/bin/activate" ]; then
    source "$VENV_PATH/bin/activate"
    log "INFO: Virtual environment activated"
else
    log "ERROR: Virtual environment not found at $VENV_PATH"
    rm -f "$PID_FILE"
    exit 1
fi

# Führe Event Pipeline Scraper aus (Node.js — RSS + HTML, kein Playwright)
log "INFO: Running event pipeline scraper..."
if node "$SCRIPT_DIR/scrape_events_pipeline.js" >> "$LOG_FILE" 2>&1; then
    log "SUCCESS: Event pipeline scraper completed"
else
    log "WARN: Event pipeline scraper failed (continuing with main scraper)"
fi

# Führe Eventbrite Scraper aus (Playwright via smry.ai Proxy)
log "INFO: Running Eventbrite scraper..."
if node "$SCRIPT_DIR/scrape_eventbrite.js" >> "$LOG_FILE" 2>&1; then
    log "SUCCESS: Eventbrite scraper completed"
else
    log "WARN: Eventbrite scraper failed (continuing)"
fi

# Führe Scraper aus
start_time=$(date +%s)
if python "$PYTHON_SCRIPT" >> "$LOG_FILE" 2>&1; then
    end_time=$(date +%s)
    duration=$((end_time - start_time))
    log "SUCCESS: Scraper completed in ${duration}s"
    
    # Prüfe ob events_cache.json erstellt wurde
    if [ -f "$SCRIPT_DIR/events_cache.json" ]; then
        events_count=$(grep -o '"total_events":[0-9]*' "$SCRIPT_DIR/events_cache.json" | grep -o '[0-9]*')
        log "INFO: Events cache updated with $events_count events"
        
        # Restart Barfinder Server um neue Events zu laden
        if systemctl is-active --quiet barfinder-server; then
            log "INFO: Restarting barfinder-server to load new events..."
            sudo systemctl restart barfinder-server
            if [ $? -eq 0 ]; then
                log "SUCCESS: Barfinder server restarted successfully"
            else
                log "ERROR: Failed to restart barfinder server"
            fi
        else
            log "WARN: Barfinder server not running, skipping restart"
        fi
    else
        log "WARN: Events cache file not created"
    fi
    
else
    log "ERROR: Scraper failed with exit code $?"
fi

# Cleanup
rm -f "$PID_FILE"
deactivate

# Log-Rotation (behält nur letzte 10MB)
if [ -f "$LOG_FILE" ]; then
    log_size=$(wc -c < "$LOG_FILE")
    if [ "$log_size" -gt "$MAX_LOG_SIZE" ]; then
        tail -n 1000 "$LOG_FILE" > "$LOG_FILE.tmp"
        mv "$LOG_FILE.tmp" "$LOG_FILE"
        log "INFO: Log rotated (was ${log_size} bytes)"
    fi
fi

log "INFO: Daily scraper job completed"