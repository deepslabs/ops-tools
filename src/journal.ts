import { createHash } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";

import type { DistributionEntry } from "./csv.js";
import type { ChainIdentity, FinalizedTransaction, PlannedDistribution, ReleaseSchedule } from "./chain.js";

export interface JournalHeader {
  type: "header";
  version: 1;
  createdAt: string;
  genesisHash: string;
  signerAddress: string;
  manifestHash: string;
  schedule: ReleaseSchedule;
}

export interface JournalSuccess {
  type: "success";
  timestamp: string;
  address: string;
  operation: "release-and-top-up" | "top-up-only";
  releaseAmount: string;
  topUpAmount: string;
  blockHash: string;
  extrinsicHash: string;
}

export function hashManifest(entries: DistributionEntry[]): string {
  const canonical = entries.map((entry) => ({
    address: entry.address,
    baseUnitAmount: entry.baseUnitAmount.toString(),
  }));
  return `0x${createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}`;
}

export function createJournalHeader(
  identity: ChainIdentity,
  signerAddress: string,
  manifestHash: string,
  schedule: ReleaseSchedule,
): JournalHeader {
  return {
    type: "header",
    version: 1,
    createdAt: new Date().toISOString(),
    genesisHash: identity.genesisHash,
    signerAddress: signerAddress.toLowerCase(),
    manifestHash,
    schedule,
  };
}

export async function initializeJournal(filePath: string, header: JournalHeader): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(header)}\n`, { flag: "wx" });
}

export async function loadJournal(
  filePath: string,
  expected: Omit<JournalHeader, "type" | "version" | "createdAt">,
): Promise<Set<string>> {
  const lines = (await readFile(filePath, "utf8")).split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) throw new Error("Resume journal is empty");

  const header = JSON.parse(lines[0]!) as JournalHeader;
  if (header.type !== "header" || header.version !== 1) throw new Error("Unsupported journal header");
  if (header.genesisHash !== expected.genesisHash) throw new Error("Journal genesis hash does not match");
  if (header.signerAddress !== expected.signerAddress.toLowerCase()) throw new Error("Journal signer does not match");
  if (header.manifestHash !== expected.manifestHash) throw new Error("Journal manifest does not match");
  if (JSON.stringify(header.schedule) !== JSON.stringify(expected.schedule)) {
    throw new Error("Journal release schedule does not match");
  }

  const completed = new Set<string>();
  for (const line of lines.slice(1)) {
    const record = JSON.parse(line) as JournalSuccess;
    if (record.type !== "success" || !/^0x[0-9a-f]{40}$/.test(record.address)) {
      throw new Error("Journal contains an invalid success record");
    }
    if (completed.has(record.address)) throw new Error(`Journal contains duplicate success for ${record.address}`);
    completed.add(record.address);
  }
  return completed;
}

export async function appendBatchSuccess(
  filePath: string,
  plans: PlannedDistribution[],
  transaction: FinalizedTransaction,
  topUpAmount: bigint,
): Promise<void> {
  const timestamp = new Date().toISOString();
  const records = plans.map((plan): JournalSuccess => ({
      type: "success",
      timestamp,
      address: plan.address,
      operation: plan.createRelease ? "release-and-top-up" : "top-up-only",
      releaseAmount: plan.createRelease ? plan.baseUnitAmount.toString() : "0",
      topUpAmount: topUpAmount.toString(),
      blockHash: transaction.blockHash,
      extrinsicHash: transaction.extrinsicHash,
    }));
  await appendFile(filePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}