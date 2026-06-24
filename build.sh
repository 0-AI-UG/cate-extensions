#!/usr/bin/env bash
# =============================================================================
# build.sh — build every extension under extensions/<id>/ into a distributable
# artifact at dist/artifacts/<id>-<version>.tgz (manifest.json at the tar root,
# the shape Cate's installer extracts), then generate dist/catalog/index.json.
#
# TypeScript extensions (those with a package.json build script) are compiled
# first (`npm install` once + `npm run build`); only manifest.json + the
# extension's dist/ ship in the artifact. Plain-asset extensions (no dist/)
# ship their directory as-is.
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

# Propagate the shared UI kit into each consuming extension's src/_kit/ before
# compiling, so builds pick up the latest kit/.
node "$ROOT/scripts/sync-kit.mjs"

shopt -s nullglob
for dir in "$EXT_DIR"/*/; do
  id="$(basename "$dir")"
  manifest="$dir/manifest.json"
  if [[ ! -f "$manifest" ]]; then
    echo "skip $id: no manifest.json"
    continue
  fi

  # Compile TypeScript extensions (anything with a package.json build script).
  if [[ -f "$dir/package.json" ]]; then
    echo "building $id ..."
    ( cd "$dir" && [[ -d node_modules ]] || npm install --no-audit --no-fund --silent )
    ( cd "$dir" && npm run build )
  fi

  version="$(node -e "process.stdout.write(String(require('$manifest').version || '0.0.0'))")"
  out="$ARTIFACT_DIR/$id-$version.tgz"
  # COPYFILE_DISABLE avoids macOS ._* AppleDouble entries in the tarball.
  if [[ -d "$dir/dist" ]]; then
    # Compiled extension: ship only the runnable output + manifest.
    COPYFILE_DISABLE=1 tar -czf "$out" -C "$dir" manifest.json dist
  else
    # Asset-only extension: ship the directory as-is (manifest.json at tar root).
    COPYFILE_DISABLE=1 tar -czf "$out" -C "$dir" .
  fi
  echo "built $out"
done

# Emit dist/catalog/index.json (uses CATALOG_BASE_URL if set, else file://).
node "$ROOT/scripts/gen-catalog.mjs"

echo "done."
