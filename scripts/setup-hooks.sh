#!/usr/bin/env bash
# Setup git hooks path untuk Personal Finance Tracker.
# Jalankan sekali per clone: ./scripts/setup-hooks.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

HOOKS_DIR=".githooks"

if [ ! -d "$HOOKS_DIR" ]; then
  echo "error: $HOOKS_DIR/ tidak ditemukan di $(pwd)" >&2
  exit 1
fi

# Pastikan semua hook executable
chmod +x "$HOOKS_DIR"/*

git config core.hooksPath "$HOOKS_DIR"

echo "✓ Git hooksPath set ke '$HOOKS_DIR'"
echo "  Aktif mulai commit berikutnya. Coba: git commit --allow-empty -m 'test' (akan run pre-commit, lalu abort manual)."