import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const generator = fileURLToPath(new URL("./generate-preset-from-issue.mjs", import.meta.url));
const requiredFields = {
  "Domain (no protocol)": "votes.example",
  "Preset ID": "votesite:example",
  "VoteSite key (siteKey)": "Example",
  "Display name (displayName)": "Example",
  "ServiceSite (required)": "Example",
};

function generate(t, fields) {
  const cwd = mkdtempSync(join(tmpdir(), "preset-test-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const body = Object.entries({ ...requiredFields, ...fields })
    .map(([name, value]) => `### ${name}\n\n${value}`)
    .join("\n\n");
  const result = spawnSync(process.execPath, [generator], {
    cwd,
    env: { ISSUE_NUMBER: "1", ISSUE_BODY: body, PRESET_KIND: "votesite" },
    encoding: "utf8",
    timeout: 5000,
  });
  assert.ifError(result.error);
  return { result, cwd };
}

function readPreset({ result, cwd }) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(readFileSync(join(cwd, "presets/votesites/votes_example.meta.json"), "utf8"));
}

test("omits blank issue-form values from VoteSite metadata", (t) => {
  const preset = readPreset(generate(t, {
    "Extra domains (comma separated)": "_No response_",
    "Default VoteURL placeholder": "No response",
    "VoteDelay (optional)": "_No response_",
    "WaitUntilVoteDelay (optional)": "",
    "VoteDelayDaily (optional)": "_No response_",
    "VoteDelayDailyHour (optional)": "_No response_",
  }));
  assert.deepEqual(preset.match.domains, ["votes.example"]);
  assert.equal(preset.placeholders.voteURL.default, "VOTEURL");
  for (const key of ["voteDelay", "waitUntilVoteDelay", "voteDelayDaily", "voteDelayDailyHour"]) {
    assert.equal(preset.placeholders[key].default, "");
  }
});

test("keeps populated VoteSite options and similar text", (t) => {
  const preset = readPreset(generate(t, {
    "Extra domains (comma separated)": "https://www.alt.example/path, votes.example",
    "Default VoteURL placeholder": "https://votes.example/vote",
    "Display name (displayName)": "_No response_ example",
    "VoteDelay (optional)": "720",
    "WaitUntilVoteDelay (optional)": "False",
    "VoteDelayDaily (optional)": "True",
    "VoteDelayDailyHour (optional)": "0",
  }));
  assert.deepEqual(preset.match.domains, ["votes.example", "alt.example"]);
  assert.equal(preset.display.name, "_No response_ example (generic)");
  assert.equal(preset.placeholders.voteURL.default, "https://votes.example/vote");
  assert.equal(preset.placeholders.voteDelay.default, "720");
  assert.equal(preset.placeholders.waitUntilVoteDelay.default, "false");
  assert.equal(preset.placeholders.voteDelayDaily.default, "true");
  assert.equal(preset.placeholders.voteDelayDailyHour.default, "0");
});

test("rejects the blank sentinel in a required field", (t) => {
  const { result } = generate(t, { "ServiceSite (required)": "_No response_" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Error: serviceSite is required/);
});
