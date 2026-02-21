#!/bin/bash
# Barfinder DB Backup - copy-based (safe with WAL mode)
DB="/home/openclaw/.openclaw/workspace/barfinder/barfinder.db"
BACKUP_DIR="/home/openclaw/.openclaw/workspace/barfinder/backups"
DATE=$(date +%Y-%m-%d_%H%M)
BACKUP_FILE="$BACKUP_DIR/barfinder_${DATE}.db"

cp "$DB" "$BACKUP_FILE"

# Keep only last 7 backups
ls -1t "$BACKUP_DIR"/barfinder_*.db 2>/dev/null | tail -n +8 | xargs -r rm

echo "Backup OK: $BACKUP_FILE ($(du -sh "$BACKUP_FILE" | cut -f1))"
