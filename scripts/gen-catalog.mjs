#!/usr/bin/env node
// =============================================================================
// gen-catalog.mjs — build dist/catalog/index.json from the built artifacts.
//
// Dependency-free. Scans extensions/<id>/manifest.json, and for each extension
// reads the already-built artifact at dist/artifacts/<id>-<version>.tgz,
// computes its sha256, and emits a catalog entry.
//
//   artifactUrl:
//     - ${CATALOG_BASE_URL}/<id>-<version>.tgz   when CATALOG_BASE_URL is set
//       (absolute https:// URL for a remote/published catalog). CI points this
//       at the rolling GitHub Release that hosts the artifacts, whose assets
//       live in a flat namespace, so no /artifacts/ path segment.
//     - file://<abs path to dist/artifacts/<id>-<version>.tgz>  otherwise
//       (local testing — Cate treats non-http(s) URLs as local paths and a
//       file:// URL points straight at the on-disk artifact).
//
// Index shape (what Cate fetches):
//   { "extensions": [ { manifest, artifactUrl, sha256, description } ] }
// =============================================================================
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const EXT_DIR = join(ROOT, "extensions");
const DIST_DIR = join(ROOT, "dist");
const ARTIFACT_DIR = join(DIST_DIR, "artifacts");
const CATALOG_DIR = join(DIST_DIR, "catalog");

const baseUrl = (process.env.CATALOG_BASE_URL || "").replace(/\/+$/, "");

// First line of a README, or undefined.
function readmeFirstLine(dir) {
  const p = join(dir, "README.md");
  if (!existsSync(p)) return undefined;
  for (const raw of readFileSync(p, "utf8").split(/\r?\n/)) {
    const line = raw.replace(/^#+\s*/, "").trim();
    if (line) return line;
  }
  return undefined;
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

const extensions = [];

const entries = existsSync(EXT_DIR)
  ? readdirSync(EXT_DIR, { withFileTypes: true }).filter((e) => e.isDirectory())
  : [];

for (const entry of entries) {
  const dir = join(EXT_DIR, entry.name);
  const manifestPath = join(dir, "manifest.json");
  if (!existsSync(manifestPath)) {
    console.warn(`skip ${entry.name}: no manifest.json`);
    continue;
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const id = manifest.id || entry.name;
  const version = manifest.version || "0.0.0";

  // Dev/reference extensions (frontendkit, kitchensink) are built for local dev
  // and tests but kept out of the user-facing catalog. Log it — never drop silently.
  if (manifest.dev === true) {
    console.log(`catalog: skip ${id}@${version} (dev: true)`);
    continue;
  }

  const artifactName = `${id}-${version}.tgz`;
  const artifactPath = join(ARTIFACT_DIR, artifactName);
  if (!existsSync(artifactPath) || !statSync(artifactPath).isFile()) {
    throw new Error(`missing artifact for ${id}: expected ${artifactPath} (run build.sh first)`);
  }

  const artifactUrl = baseUrl
    ? `${baseUrl}/${artifactName}`
    : pathToFileURL(artifactPath).href;

  const description =
    manifest.description || readmeFirstLine(dir) || manifest.name || id;

  extensions.push({
    manifest,
    artifactUrl,
    sha256: sha256(artifactPath),
    description,
  });

  console.log(`catalog: ${id}@${version} -> ${artifactUrl}`);
}

mkdirSync(CATALOG_DIR, { recursive: true });
const indexPath = join(CATALOG_DIR, "index.json");
writeFileSync(indexPath, JSON.stringify({ extensions }, null, 2) + "\n");
console.log(`wrote ${indexPath} (${extensions.length} extension(s))`);
