#!/usr/bin/env bash
# Deploy Spectre and Architect.
# Local: docker compose up -d
# Vercel: vercel --cwd apps/spectre && vercel --cwd apps/architect
set -euo pipefail

MODE="${1:-docker}"

if [ "$MODE" = "docker" ]; then
  docker compose up -d --build
  echo "Spectre: http://localhost:3000"
  echo "Architect: http://localhost:3001"
elif [ "$MODE" = "vercel" ]; then
  if ! command -v vercel >/dev/null; then
    echo "vercel CLI not found. npm i -g vercel"
    exit 1
  fi
  (cd apps/spectre && vercel --prod)
  (cd apps/architect && vercel --prod)
else
  echo "Usage: $0 [docker|vercel]"
  exit 1
fi
