#!/bin/bash
# Barfinder Nightly Update
# Runs: DB backup, data quality tests, server health check
set -e

cd /home/openclaw/.openclaw/workspace/barfinder
DATE=$(date -Iseconds)

echo "=== Barfinder Nightly Update $DATE ==="

# 1. DB Backup
echo "--- DB Backup ---"
bash backup-db.sh

# 2. Data Quality Tests
echo "--- Data Quality Tests ---"
node test_data_quality.js 2>&1 || true

# 3. Server Health
echo "--- Server Health ---"
curl -sf http://localhost:3002/api/places > /dev/null && echo "✅ Server healthy" || echo "❌ Server down!"
curl -sf http://localhost:3002/api/hot > /dev/null && echo "✅ /api/hot OK" || echo "❌ /api/hot down"
curl -sf http://localhost:3002/api/events > /dev/null && echo "✅ /api/events OK" || echo "❌ /api/events down"

# 4. DB Stats
echo "--- DB Stats ---"
sqlite3 barfinder.db "SELECT COUNT(*) || ' places total' FROM places;"
sqlite3 barfinder.db "SELECT COUNT(*) || ' with vibe_score' FROM places WHERE vibe_score IS NOT NULL AND vibe_score > 0;"

echo "=== Done ==="
