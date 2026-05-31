import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const script = readFileSync("scripts/sws-refresh-region.sh", "utf8");

test("regional SWS refresh auto-ships full successful KR/TW runs by default", () => {
  assert.match(script, /SWS_REGION_AUTO_PR:-1/);
  assert.match(script, /SWS_KR_AUTO_PR:-\$\{SWS_REGION_AUTO_PR:-1\}/);
  assert.match(script, /SWS_TW_AUTO_PR:-\$\{SWS_REGION_AUTO_PR:-1\}/);
  assert.match(script, /SWS_REGION_AUTO_MERGE:-1/);
  assert.match(script, /SWS_KR_AUTO_MERGE:-\$\{SWS_REGION_AUTO_MERGE:-1\}/);
  assert.match(script, /SWS_TW_AUTO_MERGE:-\$\{SWS_REGION_AUTO_MERGE:-1\}/);
  assert.match(script, /AUTO_BRANCH="chore\/sws-\$\{CODE\}-auto-refresh-\$\{AUTO_STAMP\}"/);
  assert.match(script, /BASE_REF="origin\/main"/);
});

test("regional SWS refresh auto-ship skips unsafe or partial runs", () => {
  assert.match(script, /\[ -z "\$\{SWS_SCRAPE_LIMIT:-\}" \]/);
  assert.match(script, /command -v gh/);
  assert.match(script, /\[ "\$\{FAIL\}" -eq 0 \]/);
  assert.match(script, /\[ "\$\{SCRAPE_SKIPPED\}" != "true" \]/);
  assert.match(script, /\[ "\$\{AUTO_PR_ENABLED:-1\}" != "0" \]/);
  assert.match(script, /auto-PR skipped \(seed mode, failed shard, gh missing, scrape skipped, or auto-PR disabled\)/);
});

test("regional SWS refresh auto-ship uses a temporary clean worktree", () => {
  assert.match(script, /AUTO_WT="\$\(mktemp -d/);
  assert.match(script, /git worktree add -b "\$\{AUTO_BRANCH\}" "\$\{AUTO_WT\}" "\$\{BASE_REF\}"/);
  assert.match(script, /cp "\$\{DATA_DIR\}\/\$\{ARTIFACT\}" "\$\{AUTO_WT\}\/\$\{DATA_DIR\}\/\$\{ARTIFACT\}"/);
  assert.match(script, /git worktree remove --force "\$\{AUTO_WT\}"/);
});

test("regional SWS refresh stages only deployable region data artifacts", () => {
  for (const path of [
    '"${DATA_DIR}/deep-${CODE}.tar.gz"',
    '"${DATA_DIR}/last-refresh.json"',
    '"${DATA_DIR}/picks-latest.json"',
    '"${DATA_DIR}/sws-scored-universe.json"',
    '"${DATA_DIR}/v3-universe-stats.json"',
  ]) {
    assert.ok(script.includes(path), `expected script to stage ${path}`);
  }

  assert.doesNotMatch(script, /git (?:-C "\$\{AUTO_WT\}" )?add\s+data\/catalysts/);
  assert.doesNotMatch(script, /git (?:-C "\$\{AUTO_WT\}" )?add\s+data\/risk-lab/);
  assert.doesNotMatch(script, /git (?:-C "\$\{AUTO_WT\}" )?add\s+data\/sws-us/);
});

test("regional SWS refresh enables auto-merge with immediate squash fallback", () => {
  assert.match(script, /gh -R mayanktaluja\/stock-platform pr create --base main/);
  assert.match(script, /gh -R mayanktaluja\/stock-platform pr merge "\$\{PR_URL\}" --squash --auto/);
  assert.match(script, /gh -R mayanktaluja\/stock-platform pr merge "\$\{PR_URL\}" --squash 2>&1/);
});
