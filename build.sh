#!/usr/bin/env bash
# =============================================================================
# build.sh — build every extension under extensions/<id>/ into a distributable
# artifact at dist/artifacts/<id>-<version>.tgz (manifest.json at the tar root,
# the shape Cate's installer extracts), then generate dist/catalog/index.json.
#
# dist/ is recreated fresh on every run.
#
# Set CATALOG_BASE_URL to emit absolute https:// artifact URLs (publishing);
# leave it unset for local testing (file:// artifact URLs).
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_DIR="$ROOT/extensions"
DIST_DIR="$ROOT/dist"
ARTIFACT_DIR="$DIST_DIR/artifacts"

# Fresh dist/ each run.
rm -rf "$DIST_DIR"
mkdir -p "$ARTIFACT_DIR"

shopt -s nullglob
for dir in "$EXT_DIR"/*/; do
  id="$(basename "$dir")"
  manifest="$dir/manifest.json"
  if [[ ! -f "$manifest" ]]; then
    echo "skip $id: no manifest.json"
    continue
  fi
  version="$(node -e "process.stdout.write(String(require('$manifest').version || '0.0.0'))")"
  out="$ARTIFACT_DIR/$id-$version.tgz"
  # COPYFILE_DISABLE avoids macOS ._* AppleDouble entries in the tarball;
  # -C "$dir" . puts manifest.json at the tar root.
  COPYFILE_DISABLE=1 tar -czf "$out" -C "$dir" .
  echo "built $out"
done

# Emit dist/catalog/index.json (uses CATALOG_BASE_URL if set, else file://).
node "$ROOT/scripts/gen-catalog.mjs"

echo "done."
