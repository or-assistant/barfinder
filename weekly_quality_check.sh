#!/bin/bash
# Weekly Barfinder Quality Check
cd /home/openclaw/.openclaw/workspace/barfinder
LOG="quality_check.log"
echo "=== Quality Check $(date -Iseconds) ===" >> $LOG

# 1. Data quality tests
echo "Running data quality tests..." >> $LOG
node test_data_quality.js >> $LOG 2>&1
TESTS=$?

# 2. Quick scraper smoke tests
echo "Testing scrapers..." >> $LOG
for scraper in scrape_ratings_batch.js scrape_events_pipeline.js scrape_ecosystem_events.js; do
  if [ -f "$scraper" ]; then
    timeout 30 node "$scraper" --dry-run >> $LOG 2>&1 || echo "⚠️ $scraper failed" >> $LOG
  fi
done

# 3. Server health
curl -sf http://localhost:3002/api/places > /dev/null && echo "✅ Server healthy" >> $LOG || echo "❌ Server down!" >> $LOG

echo "=== Done ===" >> $LOG
exit $TESTS
