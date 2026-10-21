#!/usr/bin/env bash
# ==============================================================================
# VCall — 1-Click Git Stage, Commit & Push Script
# ==============================================================================

set -e

MSG="${1:-feat: update VCall app with E2EE, voice notes & modern UI}"

echo "=============================================="
echo "      VCall 1-Click Git Commit & Push"
echo "=============================================="

echo "[*] Staging changes..."
git add -A

echo "[*] Committing: \"$MSG\"..."
git commit -m "$MSG" || echo "[*] Nothing new to commit"

echo "[*] Pushing to remote..."
git push || {
    echo ""
    echo "[NOTICE] If no upstream remote is set yet, run:"
    echo "  git remote add origin <your-repo-url>"
    echo "  git push -u origin main"
}

echo "=============================================="
echo "✔ Git Push completed!"
echo "=============================================="
