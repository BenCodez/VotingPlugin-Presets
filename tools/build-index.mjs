#!/usr/bin/env node
/**
 * @fileoverview Builds /index.json by scanning preset *.meta.json files.
 *
 * Usage:
 *   node tools/build-index.mjs
 *
 * Design goals:
 * - Contributors add presets by adding new *.meta.json (+ YAML fragments).
 * - Nobody edits index.json by hand.
 * - Output is stable, sorted, and easy to diff.
 */

import fs from "node:fs";
import path from "node:path";

/**
 * @param {string} p
 * @returns {boolean}
 */
function exists(p) {
  try {
    fs.accessSync(p, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} filePath
 * @returns {any}
 */
function readJson(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

/**
 * Recursively finds files matching a predicate.
 *
 * @param {string} dir
 * @param {(name: string) => boolean} match
 * @param {string[]} out
 * @returns {string[]}
 */
function findFiles(dir, match, out = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      findFiles(full, match, out);
    } else if (ent.isFile() && match(ent.name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Normalizes domains:
 * - lowercases
 * - strips leading www.
 *
 * @param {string[]} domains
 * @returns {string[]}
 */
function normalizeDomains(domains) {
  if (!Array.isArray(domains)) return [];
  return domains
    .filter((d) => typeof d === "string" && d.trim().length > 0)
    .map((d) => d.trim().toLowerCase())
    .map((d) => (d.startsWith("www.") ? d.substring(4) : d))
    .filter((d, i, a) => a.indexOf(d) === i)
    .sort();
}

/**
 * @param {string[]} keywords
 * @returns {string[]}
 */
function normalizeKeywords(keywords) {
  if (!Array.isArray(keywords)) return [];
  return keywords
    .filter((k) => typeof k === "string" && k.trim().length > 0)
    .map((k) => k.trim().toLowerCase())
    .filter((k, i, a) => a.indexOf(k) === i)
    .sort();
}

/**
 * Deduces category based on folder names.
 *
 * @param {string} metaPath
 * @returns {string}
 */
function inferCategory(metaPath) {
  const p = metaPath.replaceAll("\\", "/");
  if (p.includes("presets/votesites/")) return "votesites";
  if (p.includes("presets/rewards/")) return "rewards";
  if (p.includes("presets/milestones/")) return "milestones";
  if (p.includes("bundles/")) return "bundles";
  return "other";
}

/**
 * @param {any} meta
 * @param {string} relMetaPath
 * @returns {any}
 */
function toIndexEntry(meta, relMetaPath) {
  const id = meta?.id;
  const name = meta?.display?.name;
  if (typeof id !== "string" || id.trim() === "") {
    throw new Error(`Missing/invalid meta.id in ${relMetaPath}`);
  }
  if (typeof name !== "string" || name.trim() === "") {
    throw new Error(`Missing/invalid display.name in ${relMetaPath}`);
  }

  const description =
    typeof meta?.display?.description === "string" ? meta.display.description : "";

  const domains = normalizeDomains(meta?.match?.domains);
  const keywords = normalizeKeywords(meta?.match?.keywords);

  const updatedAt =
    typeof meta?.updatedAt === "string" && meta.updatedAt.trim() !== ""
      ? meta.updatedAt
      : null;

  const verified = meta?.verified === true;

  return {
    id,
    category: inferCategory(relMetaPath),
    name,
    description,
    keywords,
    domains,
    metaPath: relMetaPath.replaceAll("\\", "/"),
    updatedAt,
    verified,
  };
}

/**
 * @param {any[]} entries
 * @returns {any[]}
 */
function sortEntries(entries) {
  return entries.sort((a, b) => {
    // category, then id
    const c = (a.category || "").localeCompare(b.category || "");
    if (c !== 0) return c;
    return (a.id || "").localeCompare(b.id || "");
  });
}

(function main() {
  const repoRoot = process.cwd();
  const presetsDir = path.join(repoRoot, "presets");
  const bundlesDir = path.join(repoRoot, "bundles");

  if (!exists(presetsDir) && !exists(bundlesDir)) {
    console.error("No presets/ or bundles/ folder found. Run from repo root.");
    process.exit(1);
  }

  /** @type {string[]} */
  const metaFiles = [];
  if (exists(presetsDir)) {
    metaFiles.push(...findFiles(presetsDir, (n) => n.endsWith(".meta.json")));
  }
  if (exists(bundlesDir)) {
    metaFiles.push(...findFiles(bundlesDir, (n) => n.endsWith(".bundle.json")));
  }

  /** @type {any[]} */
  const entries = [];
  const seenIds = new Set();

  for (const absMeta of metaFiles) {
    const rel = path.relative(repoRoot, absMeta);
    const meta = readJson(absMeta);

    // Bundle files can be indexed too, but they might not have the same shape.
    // If you want bundles indexed, give them display.name and id like meta.
    if (absMeta.endsWith(".bundle.json")) {
      const id = meta?.id;
      const name = meta?.display?.name;
      if (typeof id !== "string" || typeof name !== "string") {
        throw new Error(`Bundle missing id/display.name: ${rel}`);
      }
      const entry = {
        id,
        category: "bundles",
        name,
        description: typeof meta?.display?.description === "string" ? meta.display.description : "",
        keywords: normalizeKeywords(meta?.keywords),
        domains: [],
        metaPath: rel.replaceAll("\\", "/"),
        updatedAt: typeof meta?.updatedAt === "string" ? meta.updatedAt : null,
        verified: meta?.verified === true,
      };
      if (seenIds.has(entry.id)) throw new Error(`Duplicate id: ${entry.id}`);
      seenIds.add(entry.id);
      entries.push(entry);
      continue;
    }

    const entry = toIndexEntry(meta, rel);
    if (seenIds.has(entry.id)) {
      throw new Error(`Duplicate id: ${entry.id}`);
    }
    seenIds.add(entry.id);
    entries.push(entry);
  }

  const index = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    entries: sortEntries(entries),
  };

  const outPath = path.join(repoRoot, "index.json");
  fs.writeFileSync(outPath, JSON.stringify(index, null, 2) + "\n", "utf8");
  console.log(`Wrote ${outPath} (${index.entries.length} entries)`);
})();
