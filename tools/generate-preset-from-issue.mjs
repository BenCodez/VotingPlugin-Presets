#!/usr/bin/env node
/**
 * Generate VoteSite/Reward presets from a GitHub issue form body.
 *
 * This script is intended to run inside GitHub Actions.
 *
 * It:
 * - Parses issue form markdown body into fields
 * - Creates preset files under presets/
 * - Updates index.json via tools/build-index.mjs
 *
 * Inputs are passed through env vars by the workflow.
 */

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

/**
 * @param {string} s
 * @returns {string}
 */
function normDomain(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "");
}

/**
 * Parses GitHub Issue Form markdown (### Field\nvalue) into a map.
 *
 * @param {string} body
 * @returns {Record<string,string>}
 */
function parseIssueForm(body) {
  const text = String(body || "");
  const lines = text.split(/\r?\n/);

  /** @type {Record<string,string>} */
  const out = {};
  let curKey = null;
  let buf = [];

  function flush() {
    if (curKey != null) {
      out[curKey] = buf.join("\n").trim();
    }
    curKey = null;
    buf = [];
  }

  for (const ln of lines) {
    const m = ln.match(/^###\s+(.*)\s*$/);
    if (m) {
      flush();
      curKey = m[1].trim();
      continue;
    }
    if (curKey != null) buf.push(ln);
  }
  flush();

  // GitHub issue forms sometimes include "No response" for empty fields.
  for (const k of Object.keys(out)) {
    if (out[k].trim().toLowerCase() === "no response") out[k] = "";
  }
  return out;
}

/**
 * Ensures directories exist.
 * @param {string} p
 */
function mkdirp(p) {
  fs.mkdirSync(p, { recursive: true });
}

/**
 * Writes a file if it does not already exist.
 * @param {string} p
 * @param {string} content
 */
function writeFile(p, content) {
  mkdirp(path.dirname(p));
  fs.writeFileSync(p, content, "utf8");
}

/**
 * @param {string} s
 * @returns {boolean}
 */
function isBoolStr(s) {
  const v = String(s || "").trim().toLowerCase();
  return v === "true" || v === "false";
}

/**
 * @param {string} s
 * @returns {boolean}
 */
function isIntStr(s) {
  return /^\d+$/.test(String(s || "").trim());
}

function main() {
  const issueNumber = process.env.ISSUE_NUMBER;
  const issueTitle = process.env.ISSUE_TITLE || "";
  const issueBody = process.env.ISSUE_BODY || "";
  const repoRoot = process.cwd();

  if (!issueNumber) {
    throw new Error("Missing ISSUE_NUMBER env var");
  }

  const fields = parseIssueForm(issueBody);

  // Detect type by labels passed in (workflow sets PRESET_KIND), or infer from title.
  const kind = process.env.PRESET_KIND || (issueTitle.toLowerCase().includes("reward") ? "reward" : "votesite");

  if (kind === "votesite") {
    const domain = normDomain(fields["Domain (no protocol)"]);
    const extraDomainsRaw = fields["Extra domains (comma separated)"];
    const presetId = (fields["Preset ID"] || "").trim();
    const siteKey = (fields["VoteSite key (siteKey)"] || "").trim();
    const displayName = (fields["Display name (displayName)"] || "").trim();
    const serviceSite = (fields["ServiceSite (required)"] || "").trim();
    const voteUrlDefault = (fields["Default VoteURL placeholder"] || "").trim() || "ADD_VOTE_URL_LATER";

    const voteDelay = (fields["VoteDelay (optional)"] || "").trim();
    const waitUntil = (fields["WaitUntilVoteDelay (optional)"] || "").trim();
    const daily = (fields["VoteDelayDaily (optional)"] || "").trim();
    const dailyHour = (fields["VoteDelayDailyHour (optional)"] || "").trim();

    if (!domain) throw new Error("Domain is required");
    if (!presetId.startsWith("votesite:")) throw new Error("Preset ID must start with votesite:");
    if (!siteKey) throw new Error("siteKey is required");
    if (!displayName) throw new Error("displayName is required");
    if (!serviceSite) throw new Error("serviceSite is required");

    const domains = [domain];
    if (extraDomainsRaw) {
      for (const d of extraDomainsRaw.split(",")) {
        const nd = normDomain(d);
        if (nd && !domains.includes(nd)) domains.push(nd);
      }
    }

    // File slug
    const slug = domain.replaceAll(".", "_");

    const metaPath = path.join(repoRoot, "presets", "votesites", `${slug}.meta.json`);
    const meta = {
      schemaVersion: 1,
      id: presetId,
      display: {
        name: `${displayName} (generic)`,
        description: `Generic ${displayName} VoteSite preset.`
      },
      match: {
        domains,
        keywords: [siteKey.toLowerCase(), displayName.toLowerCase()]
      },
      placeholders: {
        siteKey: { type: "string", label: "VoteSite key", default: siteKey },
        displayName: { type: "string", label: "VoteSite display name", default: displayName },
        serviceSite: { type: "string", label: "ServiceSite", default: serviceSite },
        voteURL: { type: "string", label: "Vote URL", default: voteUrlDefault },

        voteDelay: { type: "string", label: "VoteDelay (blank = omit)", default: voteDelay || "" },
        waitUntilVoteDelay: { type: "string", label: "WaitUntilVoteDelay (true/false, blank = omit)", default: isBoolStr(waitUntil) ? waitUntil.toLowerCase() : "" },
        voteDelayDaily: { type: "string", label: "VoteDelayDaily (true/false, blank = omit)", default: isBoolStr(daily) ? daily.toLowerCase() : "" },
        voteDelayDailyHour: { type: "string", label: "VoteDelayDailyHour (0–23, blank = omit)", default: isIntStr(dailyHour) ? dailyHour : "" }
      },
      fragments: [
        { path: "presets/votesites/generic.votesites.yml", mergeInto: "VoteSites" }
      ],
      verified: false
    };

    writeFile(metaPath, JSON.stringify(meta, null, 2) + "\n");
  } else {
    // reward
    const presetId = (fields["Preset ID"] || "").trim();
    const displayName = (fields["Display name"] || "").trim();
    const rewardType = (fields["Reward type"] || "").trim().toLowerCase();
    const lines = (fields["Default lines (one per line)"] || "").trim();

    if (!presetId.startsWith("reward:")) throw new Error("Preset ID must start with reward:");
    if (!displayName) throw new Error("display name is required");
    if (rewardType !== "commands" && rewardType !== "messages") throw new Error("Reward type must be commands or messages");
    if (!lines) throw new Error("Default lines required");

    const slug = presetId.replaceAll(":", "_").replaceAll("/", "_");
    const metaPath = path.join(repoRoot, "presets", "rewards", `${slug}.meta.json`);
    const ymlPath = path.join(repoRoot, "presets", "rewards", `${slug}.rewardblock.yml`);

    const placeholderKey = rewardType === "commands" ? "commands" : "messages";
    const blockKey = rewardType === "commands" ? "commandsBlock" : "messagesBlock";
    const headerKey = rewardType === "commands" ? "Commands" : "Messages";

    const meta = {
      schemaVersion: 1,
      id: presetId,
      display: { name: displayName, description: `Inline Reward (${rewardType}) merged into VoteSites.<siteKey>.Rewards.` },
      match: { keywords: ["reward", "inline", rewardType] },
      placeholders: {
        [placeholderKey]: { type: "string", label: `${headerKey} (one per line)`, default: lines }
      },
      fragments: [
        { path: `presets/rewards/${path.basename(ymlPath)}`, mergeInto: "VoteSites.<siteKey>.Rewards" }
      ],
      verified: false
    };

    const yml = `${headerKey}:\n<${blockKey}>\n`;

    writeFile(metaPath, JSON.stringify(meta, null, 2) + "\n");
    writeFile(ymlPath, yml);
  }

  // Rebuild index.json
  execSync("node tools/build-index.mjs", { stdio: "inherit" });
}

main();
