#!/usr/bin/env node

import "dotenv/config";

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import {
  DEFAULT_RPC_URL,
  chunkItems,
  chunkPlans,
  connectApi,
  createSigner,
  estimateFees,
  estimateReleaseTimeUpdateFees,
  estimateWithdrawFees,
  getLinearReleaseBalances,
  getFreeBalance,
  planDistributions,
  requiredPrincipal,
  submitPlans,
  submitReleaseTimeUpdate,
  submitWithdrawBatch,
  validateReleaseTimeRuntime,
  validateRuntime,
  validateSchedule,
  validateSudoSigner,
  validateWithdrawRuntime,
  type ReleaseSchedule,
} from "./chain.js";
import { formatCsvRow, formatDps, loadDistributionCsv, TOP_UP_AMOUNT } from "./csv.js";
import {
  appendBatchSuccess,
  createJournalHeader,
  hashManifest,
  initializeJournal,
  loadJournal,
} from "./journal.js";

interface CliOptions {
  csvPath: string;
  rpcUrl: string;
  schedule: ReleaseSchedule;
  execute: boolean;
  yes: boolean;
  batchSize: number;
  updateReleaseTime: boolean;
  withdrawRelease: boolean;
  lockedBalances: boolean;
  journalPath: string;
  resumePath?: string;
  manifestPath?: string;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    csvPath: "tDPS.csv",
    rpcUrl: DEFAULT_RPC_URL,
    schedule: { fromBlock: 10_000_000, toBlock: 20_000_000, releaseInterval: 1_000 },
    execute: false,
    yes: false,
    batchSize: 10,
    updateReleaseTime: false,
    withdrawRelease: false,
    lockedBalances: false,
    journalPath: "distribution-results.jsonl",
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const value = (): string => {
      const next = args[index + 1];
      if (!next) throw new Error(`${arg} requires a value`);
      index += 1;
      return next;
    };
    switch (arg) {
      case "--csv": options.csvPath = value(); break;
      case "--rpc": options.rpcUrl = value(); break;
      case "--from-block": options.schedule.fromBlock = Number(value()); break;
      case "--to-block": options.schedule.toBlock = Number(value()); break;
      case "--release-interval": options.schedule.releaseInterval = Number(value()); break;
      case "--batch-size": options.batchSize = Number(value()); break;
      case "--update-release-time": options.updateReleaseTime = true; break;
      case "--withdraw-release": options.withdrawRelease = true; break;
      case "--locked-balances": options.lockedBalances = true; break;
      case "--journal": options.journalPath = value(); break;
      case "--resume": options.resumePath = value(); break;
      case "--manifest": options.manifestPath = value(); break;
      case "--execute": options.execute = true; break;
      case "--yes": options.yes = true; break;
      case "--help": printHelp(); process.exit(0);
      default: throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (options.resumePath) options.journalPath = options.resumePath;
  validateSchedule(options.schedule);
  if (!Number.isInteger(options.batchSize) || options.batchSize < 1) {
    throw new Error("--batch-size must be a positive integer");
  }
  const selectedModes = [options.updateReleaseTime, options.withdrawRelease, options.lockedBalances]
    .filter(Boolean).length;
  if (selectedModes > 1) {
    throw new Error("--update-release-time, --withdraw-release, and --locked-balances are mutually exclusive");
  }
  return options;
}

function printHelp(): void {
  console.log(`Usage: npm run dry-run -- [options]

Options:
  --csv <path>                 CSV input (default: tDPS.csv)
  --rpc <url>                  WebSocket RPC URL
  --from-block <u32>           Release start block (default: 10000000)
  --to-block <u32>             Release end block (default: 20000000)
  --release-interval <u32>     Release interval (default: 1000)
  --batch-size <count>         Accounts per atomic batch (default: 10)
  --update-release-time        Update release times using ROOT_KEY via sudo
  --withdraw-release           Withdraw releases for accounts using sudoAs
  --locked-balances            Output per-account locked release data as CSV
  --manifest <path>            Write the normalized dry-run manifest as JSON
  --execute                    Sign and broadcast transactions
  --journal <path>             New execution journal path
  --resume <path>              Resume a matching execution journal
  --yes                        Skip the interactive EXECUTE confirmation
  --help                       Show this help`);
}

async function confirmExecution(): Promise<void> {
  const readline = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await readline.question('Type "EXECUTE" to broadcast transactions: ');
    if (answer !== "EXECUTE") throw new Error("Execution cancelled");
  } finally {
    readline.close();
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const manifest = await loadDistributionCsv(resolve(options.csvPath));
  const manifestHash = hashManifest(manifest.entries);

  if (!options.lockedBalances) {
    console.log(`CSV rows: ${manifest.sourceRowCount}`);
    console.log(`Unique addresses: ${manifest.uniqueAddressCount}`);
    console.log(`Aggregated duplicate rows: ${manifest.duplicateRowCount}`);
    console.log(`Zero-allocation addresses: ${manifest.zeroAmountCount}`);
    console.log(`Release total: ${formatDps(manifest.totalBaseUnitAmount)} DPS`);
    console.log(`Top-up total: ${formatDps(manifest.totalTopUpAmount)} DPS`);
    console.log(`Manifest hash: ${manifestHash}`);
  }

  if (options.manifestPath) {
    const output = {
      manifestHash,
      schedule: options.schedule,
      entries: manifest.entries.map((entry) => ({
        address: entry.address,
        tokenAmount: entry.tokenAmount.toString(),
        baseUnitAmount: entry.baseUnitAmount.toString(),
        sourceRows: entry.sourceRows,
      })),
    };
    await writeFile(resolve(options.manifestPath), `${JSON.stringify(output, null, 2)}\n`, { flag: "wx" });
    console.log(`Manifest written: ${resolve(options.manifestPath)}`);
  }

  const api = await connectApi(options.rpcUrl);
  try {
    const identity = await validateRuntime(api);
    if (options.updateReleaseTime) validateReleaseTimeRuntime(api);
    if (options.withdrawRelease) validateWithdrawRuntime(api);
    if (!options.lockedBalances) {
      console.log(`Chain: ${identity.chain}`);
      console.log(`Genesis hash: ${identity.genesisHash}`);
      console.log(`Finalized block: ${identity.finalizedBlock}`);
    }
    if (!options.withdrawRelease && !options.lockedBalances) {
      console.log(`Release schedule: ${options.schedule.fromBlock} -> ${options.schedule.toBlock}, interval ${options.schedule.releaseInterval}`);
      if (identity.finalizedBlock >= options.schedule.toBlock) {
        console.warn("WARNING: the configured release period has already ended.");
      } else if (identity.finalizedBlock >= options.schedule.fromBlock) {
        console.warn("WARNING: the configured release period has already started.");
      }
    }

    if (options.updateReleaseTime) {
      const groups = chunkItems(manifest.entries.map((entry) => entry.address), options.batchSize);
      console.log(`Release-time update batches: ${groups.length} (up to ${options.batchSize} accounts each)`);
      if (!options.execute) {
        console.log("Dry-run complete. No transaction was signed or broadcast.");
        return;
      }

      const rootUri = process.env.ROOT_KEY;
      if (!rootUri) throw new Error("ROOT_KEY is required with --update-release-time --execute");
      const rootSigner = await createSigner(rootUri);
      await validateSudoSigner(api, rootSigner);
      console.log(`Root signer: ${rootSigner.address}`);
      const fees = await estimateReleaseTimeUpdateFees(api, rootSigner, groups, options.schedule);
      const freeBalance = await getFreeBalance(api, rootSigner.address);
      console.log(`Estimated fees: ${formatDps(fees)} DPS`);
      console.log(`Root signer free balance: ${formatDps(freeBalance)} DPS`);
      if (freeBalance < fees) throw new Error("ROOT_KEY signer balance is insufficient for estimated fees");
      if (!options.yes) await confirmExecution();

      for (let index = 0; index < groups.length; index += 1) {
        const accounts = groups[index]!;
        console.log(`[${index + 1}/${groups.length}] Updating release time for ${accounts.length} accounts`);
        const transaction = await submitReleaseTimeUpdate(api, rootSigner, accounts, options.schedule);
        console.log(`Finalized ${transaction.extrinsicHash} in ${transaction.blockHash}`);
      }
      console.log("Release-time update complete.");
      return;
    }

    if (options.withdrawRelease) {
      const groups = chunkItems(manifest.entries.map((entry) => entry.address), options.batchSize);
      console.log(`Delegated withdrawal batches: ${groups.length} (up to ${options.batchSize} accounts each)`);
      if (!options.execute) {
        console.log("Dry-run complete. No transaction was signed or broadcast.");
        return;
      }

      const rootKey = process.env.ROOT_KEY;
      if (!rootKey) throw new Error("ROOT_KEY is required with --withdraw-release --execute");
      const rootSigner = await createSigner(rootKey);
      await validateSudoSigner(api, rootSigner);
      console.log(`Root signer: ${rootSigner.address}`);
      const fees = await estimateWithdrawFees(api, rootSigner, groups);
      const freeBalance = await getFreeBalance(api, rootSigner.address);
      console.log(`Estimated fees: ${formatDps(fees)} DPS`);
      console.log(`Root signer free balance: ${formatDps(freeBalance)} DPS`);
      if (freeBalance < fees) throw new Error("ROOT_KEY signer balance is insufficient for estimated fees");
      if (!options.yes) await confirmExecution();

      for (let index = 0; index < groups.length; index += 1) {
        const accounts = groups[index]!;
        console.log(`[${index + 1}/${groups.length}] Withdrawing releases for ${accounts.length} accounts`);
        const transaction = await submitWithdrawBatch(api, rootSigner, accounts);
        console.log(`Finalized ${transaction.extrinsicHash} in ${transaction.blockHash}`);
      }
      console.log("Delegated withdrawal complete.");
      return;
    }

    if (options.lockedBalances) {
      const accounts = manifest.entries.map((entry) => entry.address);
      const releases = await getLinearReleaseBalances(api, accounts);
      console.log(formatCsvRow([
        "Address",
        "Status",
        "RemainingDPS",
        "TotalDPS",
        "FromBlock",
        "ToBlock",
        "ReleaseInterval",
        "LatestWithdrawBlock",
      ]));
      for (let index = 0; index < accounts.length; index += 1) {
        const account = accounts[index]!;
        const release = releases[index];
        if (!release) {
          console.log(formatCsvRow([account, "NoRelease", null, null, null, null, null, null]));
          continue;
        }
        console.log(formatCsvRow([
          account,
          "Active",
          formatDps(release.remaining),
          formatDps(release.total),
          release.fromBlock,
          release.toBlock,
          release.releaseInterval,
          release.latestWithdrawBlock,
        ]));
      }
      return;
    }

    console.log("Checking existing linear releases...");
    const plans = await planDistributions(api, manifest.entries);
    const newReleaseCount = plans.filter((plan) => plan.createRelease).length;
    const existingReleaseCount = plans.filter((plan) => plan.hasExistingRelease).length;
    console.log(`New releases: ${newReleaseCount}`);
    console.log(`Existing releases (top-up only): ${existingReleaseCount}`);
    console.log(`Zero allocations (top-up only): ${manifest.zeroAmountCount}`);

    if (!options.execute) {
      console.log("Dry-run complete. No transaction was signed or broadcast.");
      return;
    }

    const signerUri = process.env.SIGNER_KEY;
    if (!signerUri) throw new Error("SIGNER_KEY is required with --execute");
    const signer = await createSigner(signerUri);
    console.log(`Signer: ${signer.address}`);

    const completed = options.resumePath
      ? await loadJournal(resolve(options.resumePath), {
          genesisHash: identity.genesisHash,
          signerAddress: signer.address,
          manifestHash,
          schedule: options.schedule,
        })
      : new Set<string>();
    const pending = plans.filter((plan) => !completed.has(plan.address));
    console.log(`Already completed: ${completed.size}`);
    console.log(`Pending transactions: ${pending.length}`);
    if (pending.length === 0) {
      console.log("Nothing to execute.");
      return;
    }

    console.log("Estimating transaction fees...");
    const principal = requiredPrincipal(pending);
    const groups = chunkPlans(pending, options.batchSize);
    console.log(`Atomic batches: ${groups.length} (up to ${options.batchSize} accounts each)`);
    const fees = await estimateFees(api, signer, pending, options.schedule, options.batchSize);
    const freeBalance = await getFreeBalance(api, signer.address);
    console.log(`Required principal: ${formatDps(principal)} DPS`);
    console.log(`Estimated fees: ${formatDps(fees)} DPS`);
    console.log(`Signer free balance: ${formatDps(freeBalance)} DPS`);
    if (freeBalance < principal + fees) throw new Error("Signer balance is insufficient for principal plus estimated fees");

    if (!options.yes) await confirmExecution();
    if (!options.resumePath) {
      await initializeJournal(resolve(options.journalPath), createJournalHeader(
        identity,
        signer.address,
        manifestHash,
        options.schedule,
      ));
    }

    for (let index = 0; index < groups.length; index += 1) {
      const group = groups[index]!;
      console.log(`[${index + 1}/${groups.length}] Submitting atomic batch for ${group.length} accounts`);
      const transaction = await submitPlans(api, signer, group, options.schedule);
      await appendBatchSuccess(resolve(options.journalPath), group, transaction, TOP_UP_AMOUNT);
      console.log(`Finalized ${transaction.extrinsicHash} in ${transaction.blockHash}`);
    }
    console.log(`Execution complete. Journal: ${resolve(options.journalPath)}`);
  } finally {
    await api.disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});