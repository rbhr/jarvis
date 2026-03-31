#!/bin/bash
cd "$(dirname "$0")"

trap 'kill $(jobs -p) 2>/dev/null' EXIT

source venv/bin/activate

echo "Starting JARVIS..."
python server.py &
cd frontend && npm run dev &
cd ..

wait
