#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
node "$ROOT_DIR/scripts/build-release.mjs" --sync-src
ls -lh "$ROOT_DIR/dist/jiankebiao-pwa.zip"
