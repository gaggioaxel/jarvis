#!/usr/bin/env bash
# Rigenera i file dalla config privata e pubblica l'istanza.
#   scripts/deploy.sh hosting   PWA e regole su Firebase (firebase deploy)
#   scripts/deploy.sh worker    connettore MCP e notifiche su Cloudflare (wrangler deploy)
#   scripts/deploy.sh prova     solo controlli: tsc e wrangler deploy --dry-run
set -euo pipefail
cd "$(dirname "$0")/.."
python3 scripts/genera.py
case "${1:-prova}" in
  hosting) (cd bacheca && ${FIREBASE:-firebase} deploy --only hosting,firestore:rules) ;;
  worker)  (cd bacheca/mcp-worker && npx tsc --noEmit && npx wrangler deploy) ;;
  prova)   (cd bacheca/mcp-worker && npx tsc --noEmit && npx wrangler deploy --dry-run --outdir /tmp/jarvis-worker-prova) ;;
  *) echo "Uso: $0 [hosting|worker|prova]" >&2; exit 2 ;;
esac
