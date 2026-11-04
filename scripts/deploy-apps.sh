#!/usr/bin/env bash
# Deploy Spectre and Conductor.
# Local: docker compose up -d
# Vercel: vercel --cwd apps/spectre && vercel --cwd apps/conductor
set -euo pipefail

MODE="${1:-docker}"

if [ "$MODE" = "docker" ]; then
  docker compose up -d --build
  echo "Spectre: http://localhost:3000"
  echo "Conductor: http://localhost:3001"
elif [ "$MODE" = "vercel" ]; then
  if ! command -v vercel >/dev/null; then
    echo "vercel CLI not found. npm i -g vercel"
    exit 1
  fi
  (cd apps/spectre && vercel --prod)
  (cd apps/conductor && vercel --prod)
else
  echo "Usage: $0 [docker|vercel]"
  exit 1
fi
