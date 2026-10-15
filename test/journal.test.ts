import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createDistributionPlan, type ChainIdentity } from "../src/chain.js";
import { DPS_BASE, TOP_UP_AMOUNT, type DistributionEntry } from "../src/csv.js";
import {
  appendBatchSuccess,
  createJournalHeader,
  hashManifest,
  initializeJournal,
  loadJournal,
} from "../src/journal.js";

const ENTRY: DistributionEntry = {
  address: "0x1111111111111111111111111111111111111111",
  tokenAmount: 5n,
  baseUnitAmount: 5n * DPS_BASE,
  sourceRows: [2],
};
const IDENTITY: ChainIdentity = {
  chain: "DeepS Beta Testnet",
  genesisHash: "0xabc",
  finalizedBlock: 1,
  tokenSymbol: "DPS",
  tokenDecimals: 18,
};
const SCHEDULE = { fromBlock: 10_000_000, toBlock: 20_000_000, releaseInterval: 1_000 };

test("journal resumes completed addresses only when identity matches", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dps-journal-"));
  const filePath = join(directory, "result.jsonl");
  const manifestHash = hashManifest([ENTRY]);
  const signerAddress = "0x2222222222222222222222222222222222222222";
  await initializeJournal(filePath, createJournalHeader(IDENTITY, signerAddress, manifestHash, SCHEDULE));
  await appendBatchSuccess(filePath, [createDistributionPlan(ENTRY, false)], {
    blockHash: "0xblock",
    extrinsicHash: "0xtx",
  }, TOP_UP_AMOUNT);

  const completed = await loadJournal(filePath, {
    genesisHash: IDENTITY.genesisHash,
    signerAddress,
    manifestHash,
    schedule: SCHEDULE,
  });
  assert.deepEqual([...completed], [ENTRY.address]);
  const contents = await readFile(filePath, "utf8");
  assert.match(contents, /release-and-top-up/);
  await assert.rejects(() => loadJournal(filePath, {
    genesisHash: "0xdifferent",
    signerAddress,
    manifestHash,
    schedule: SCHEDULE,
  }), /genesis hash/);
});

test("manifest hash ignores CSV source row metadata but includes amounts", () => {
  assert.equal(hashManifest([ENTRY]), hashManifest([{ ...ENTRY, sourceRows: [99] }]));
  assert.notEqual(hashManifest([ENTRY]), hashManifest([{ ...ENTRY, baseUnitAmount: 6n * DPS_BASE }]));
});