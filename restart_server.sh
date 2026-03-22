#!/bin/bash
# Restart ONLY the node server, NOT the cloudflare tunnel
# Usage: bash restart_server.sh

cd /home/openclaw/.openclaw/workspace/barfinder

# Kill only node server processes on port 3002
lsof -ti:3002 | while read pid; do
  PROC=$(ps -p $pid -o comm= 2>/dev/null)
  if [ "$PROC" = "node" ]; then
    kill -9 $pid 2>/dev/null
    echo "Killed node PID $pid"
  fi
done

sleep 1
node server.js &
echo "Server restarted (PID: $!)"
