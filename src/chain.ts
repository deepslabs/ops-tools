import type { ApiPromise } from "@polkadot/api";
import { ApiPromise as PolkadotApi, WsProvider } from "@polkadot/api";
import { Keyring } from "@polkadot/keyring";
import type { KeyringPair } from "@polkadot/keyring/types";
import type { EventRecord } from "@polkadot/types/interfaces";
import type { DispatchError } from "@polkadot/types/interfaces/system";
import type { ISubmittableResult } from "@polkadot/types/types";
import type { Codec } from "@polkadot/types/types";
import type { Option } from "@polkadot/types-codec";
import { cryptoWaitReady } from "@polkadot/util-crypto";

import type { DistributionEntry } from "./csv.js";
import { DPS_DECIMALS, TOP_UP_AMOUNT } from "./csv.js";

export const DEFAULT_RPC_URL = "wss://rpc-testnet.deeps.fi";

export interface ReleaseSchedule {
  fromBlock: number;
  toBlock: number;
  releaseInterval: number;
}

export interface ChainIdentity {
  chain: string;
  genesisHash: string;
  finalizedBlock: number;
  tokenSymbol: string;
  tokenDecimals: number;
}

export interface PlannedDistribution extends DistributionEntry {
  hasExistingRelease: boolean;
  createRelease: boolean;
}

export interface FinalizedTransaction {
  blockHash: string;
  extrinsicHash: string;
}

export interface LinearReleaseBalance {
  address: string;
  total: bigint;
  remaining: bigint;
  fromBlock: number;
  toBlock: number;
  releaseInterval: number;
  latestWithdrawBlock: number | null;
}

export async function connectApi(rpcUrl: string): Promise<ApiPromise> {
  return PolkadotApi.create({ provider: new WsProvider(rpcUrl) as never });
}

export async function createSigner(signerUri: string): Promise<KeyringPair> {
  await cryptoWaitReady();
  return new Keyring({ type: "ethereum" }).addFromUri(signerUri);
}

export async function validateRuntime(api: ApiPromise): Promise<ChainIdentity> {
  const properties = await api.rpc.system.properties();
  const tokenSymbols = properties.tokenSymbol.unwrapOrDefault();
  const tokenDecimals = properties.tokenDecimals.unwrapOrDefault();
  const symbol = tokenSymbols[0]?.toString() ?? "";
  const decimals = tokenDecimals[0]?.toNumber() ?? -1;

  if (symbol !== "DPS" || decimals !== DPS_DECIMALS) {
    throw new Error(`Unexpected chain token: ${symbol || "unknown"} with ${decimals} decimals`);
  }
  if (!api.tx.incentive?.addLinerRelease || !api.query.incentive?.linearReleaseForAccount) {
    throw new Error("Runtime does not expose incentive.addLinerRelease and linearReleaseForAccount");
  }
  if (!api.tx.utility?.batchAll || !api.tx.balances?.transferAllowDeath) {
    throw new Error("Runtime does not expose utility.batchAll and balances.transferAllowDeath");
  }

  const releaseAccountType = api.tx.incentive.addLinerRelease.meta.args[0]?.type.toString();
  if (releaseAccountType !== "AccountId20") {
    throw new Error(`Unexpected release account type: ${releaseAccountType ?? "unknown"}`);
  }

  const finalizedHash = await api.rpc.chain.getFinalizedHead();
  const header = await api.rpc.chain.getHeader(finalizedHash);
  return {
    chain: (await api.rpc.system.chain()).toString(),
    genesisHash: api.genesisHash.toHex(),
    finalizedBlock: header.number.toNumber(),
    tokenSymbol: symbol,
    tokenDecimals: decimals,
  };
}

export function validateReleaseTimeRuntime(api: ApiPromise): void {
  if (!api.tx.incentive?.updateLinerReleaseTime) {
    throw new Error("Runtime does not expose incentive.updateLinerReleaseTime");
  }
  if (!api.tx.sudo?.sudo || !api.query.sudo?.key) {
    throw new Error("Runtime does not expose sudo.sudo and sudo.key");
  }

  const argumentTypes = api.tx.incentive.updateLinerReleaseTime.meta.args.map((argument) => argument.type.toString());
  if (argumentTypes.join(",") !== "Vec<AccountId20>,u32,u32") {
    throw new Error(`Unexpected updateLinerReleaseTime arguments: ${argumentTypes.join(", ")}`);
  }
}

export function validateWithdrawRuntime(api: ApiPromise): void {
  if (!api.tx.incentive?.withdrawLinerRelease) {
    throw new Error("Runtime does not expose incentive.withdrawLinerRelease");
  }
  if (!api.tx.sudo?.sudoAs || !api.query.sudo?.key) {
    throw new Error("Runtime does not expose sudo.sudoAs and sudo.key");
  }
  if (!api.tx.utility?.batchAll) {
    throw new Error("Runtime does not expose utility.batchAll");
  }

  if (api.tx.incentive.withdrawLinerRelease.meta.args.length !== 0) {
    throw new Error("Unexpected withdrawLinerRelease arguments");
  }
  const sudoAsTypes = api.tx.sudo.sudoAs.meta.args.map((argument) => argument.type.toString());
  if (sudoAsTypes.join(",") !== "MultiAddress,Call") {
    throw new Error(`Unexpected sudoAs arguments: ${sudoAsTypes.join(", ")}`);
  }
}

export async function validateSudoSigner(api: ApiPromise, signer: KeyringPair): Promise<void> {
  const sudoKey = (await api.query.sudo!.key!()).toString();
  if (sudoKey.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(`ROOT_KEY signer ${signer.address} does not match on-chain sudo key ${sudoKey}`);
  }
}

export function validateSchedule(schedule: ReleaseSchedule): void {
  const values = [schedule.fromBlock, schedule.toBlock, schedule.releaseInterval];
  if (values.some((value) => !Number.isInteger(value) || value < 0 || value > 0xffff_ffff)) {
    throw new Error("Release block values must be u32 integers");
  }
  if (schedule.toBlock < schedule.fromBlock) {
    throw new Error("toBlock must be greater than or equal to fromBlock");
  }
}

export async function planDistributions(
  api: ApiPromise,
  entries: DistributionEntry[],
): Promise<PlannedDistribution[]> {
  const plans: PlannedDistribution[] = [];
  const query = api.query.incentive!.linearReleaseForAccount!;
  const chunkSize = 100;
  for (let offset = 0; offset < entries.length; offset += chunkSize) {
    const chunk = entries.slice(offset, offset + chunkSize);
    const releases = await query.multi(chunk.map((entry) => entry.address)) as Option<Codec>[];
    for (let index = 0; index < chunk.length; index += 1) {
      const entry = chunk[index]!;
      plans.push(createDistributionPlan(entry, releases[index]?.isSome ?? false));
    }
  }
  return plans;
}

export async function getLinearReleaseBalances(
  api: ApiPromise,
  accounts: string[],
): Promise<Array<LinearReleaseBalance | null>> {
  const results: Array<LinearReleaseBalance | null> = [];
  const query = api.query.incentive!.linearReleaseForAccount!;
  const chunkSize = 100;
  for (let offset = 0; offset < accounts.length; offset += chunkSize) {
    const chunk = accounts.slice(offset, offset + chunkSize);
    const releases = await query.multi(chunk) as Option<Codec>[];
    for (let index = 0; index < chunk.length; index += 1) {
      const account = chunk[index]!;
      const release = releases[index];
      results.push(release?.isSome ? parseLinearReleaseBalance(account, release.unwrap()) : null);
    }
  }
  return results;
}

export function parseLinearReleaseBalance(address: string, release: Codec): LinearReleaseBalance {
  const value = release.toJSON() as {
    total?: string | number;
    remaining?: string | number;
    fromBlock?: string | number;
    toBlock?: string | number;
    releaseInterval?: string | number;
    latestWithdrawBlock?: string | number | null;
  };
  if (value.total === undefined || value.remaining === undefined ||
      value.fromBlock === undefined || value.toBlock === undefined || value.releaseInterval === undefined) {
    throw new Error(`Invalid linear release record for ${address}`);
  }
  return {
    address,
    total: BigInt(value.total),
    remaining: BigInt(value.remaining),
    fromBlock: Number(value.fromBlock),
    toBlock: Number(value.toBlock),
    releaseInterval: Number(value.releaseInterval),
    latestWithdrawBlock: value.latestWithdrawBlock === null || value.latestWithdrawBlock === undefined
      ? null
      : Number(value.latestWithdrawBlock),
  };
}

export function createDistributionPlan(
  entry: DistributionEntry,
  hasExistingRelease: boolean,
): PlannedDistribution {
  return {
    ...entry,
    hasExistingRelease,
    createRelease: entry.baseUnitAmount > 0n && !hasExistingRelease,
  };
}

export function requiredPrincipal(plans: PlannedDistribution[]): bigint {
  const releases = plans.reduce(
    (total, plan) => total + (plan.createRelease ? plan.baseUnitAmount : 0n),
    0n,
  );
  return releases + BigInt(plans.length) * TOP_UP_AMOUNT;
}

export async function getFreeBalance(api: ApiPromise, address: string): Promise<bigint> {
  const account = await api.query.system!.account!(address);
  const json = account.toJSON() as { data?: { free?: string | number } };
  const free = json.data?.free;
  if (free === undefined) {
    throw new Error("Unable to read signer free balance");
  }
  return BigInt(free);
}

export async function estimateFees(
  api: ApiPromise,
  signer: KeyringPair,
  plans: PlannedDistribution[],
  schedule: ReleaseSchedule,
  batchSize: number,
): Promise<bigint> {
  let total = 0n;
  for (const group of chunkPlans(plans, batchSize)) {
    const info = await buildBatch(api, group, schedule).paymentInfo(signer);
    total += BigInt(info.partialFee.toString());
  }
  return total;
}

export function chunkPlans(plans: PlannedDistribution[], batchSize: number): PlannedDistribution[][] {
  return chunkItems(plans, batchSize);
}

export function chunkItems<T>(items: T[], batchSize: number): T[][] {
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error("batchSize must be a positive integer");
  }
  const groups: T[][] = [];
  for (let offset = 0; offset < items.length; offset += batchSize) {
    groups.push(items.slice(offset, offset + batchSize));
  }
  return groups;
}

export function buildBatch(
  api: ApiPromise,
  plans: PlannedDistribution[],
  schedule: ReleaseSchedule,
) {
  const calls = [];
  for (const plan of plans) {
    if (plan.createRelease) {
      calls.push(api.tx.incentive!.addLinerRelease!(
        plan.address,
        plan.baseUnitAmount,
        schedule.fromBlock,
        schedule.toBlock,
        schedule.releaseInterval,
      ));
    }
    calls.push(api.tx.balances!.transferAllowDeath!(plan.address, TOP_UP_AMOUNT));
  }
  return api.tx.utility!.batchAll!(calls);
}

export function buildReleaseTimeUpdate(
  api: ApiPromise,
  accounts: string[],
  schedule: Pick<ReleaseSchedule, "fromBlock" | "toBlock">,
) {
  if (accounts.length === 0) throw new Error("Cannot update an empty account batch");
  const update = api.tx.incentive!.updateLinerReleaseTime!(
    accounts,
    schedule.fromBlock,
    schedule.toBlock,
  );
  return api.tx.sudo!.sudo!(update);
}

export function buildWithdrawBatch(api: ApiPromise, accounts: string[]) {
  if (accounts.length === 0) throw new Error("Cannot withdraw an empty account batch");
  const calls = accounts.map((account) => api.tx.sudo!.sudoAs!(
    account,
    api.tx.incentive!.withdrawLinerRelease!(),
  ));
  return api.tx.utility!.batchAll!(calls);
}

export async function estimateWithdrawFees(
  api: ApiPromise,
  signer: KeyringPair,
  accountGroups: string[][],
): Promise<bigint> {
  let total = 0n;
  for (const accounts of accountGroups) {
    const info = await buildWithdrawBatch(api, accounts).paymentInfo(signer);
    total += BigInt(info.partialFee.toString());
  }
  return total;
}

export async function submitWithdrawBatch(
  api: ApiPromise,
  signer: KeyringPair,
  accounts: string[],
): Promise<FinalizedTransaction> {
  return submitExtrinsic(api, buildWithdrawBatch(api, accounts), signer);
}

export async function estimateReleaseTimeUpdateFees(
  api: ApiPromise,
  signer: KeyringPair,
  accountGroups: string[][],
  schedule: Pick<ReleaseSchedule, "fromBlock" | "toBlock">,
): Promise<bigint> {
  let total = 0n;
  for (const accounts of accountGroups) {
    const info = await buildReleaseTimeUpdate(api, accounts, schedule).paymentInfo(signer);
    total += BigInt(info.partialFee.toString());
  }
  return total;
}

export async function submitReleaseTimeUpdate(
  api: ApiPromise,
  signer: KeyringPair,
  accounts: string[],
  schedule: Pick<ReleaseSchedule, "fromBlock" | "toBlock">,
): Promise<FinalizedTransaction> {
  return submitExtrinsic(api, buildReleaseTimeUpdate(api, accounts, schedule), signer);
}

export async function submitPlans(
  api: ApiPromise,
  signer: KeyringPair,
  plans: PlannedDistribution[],
  schedule: ReleaseSchedule,
): Promise<FinalizedTransaction> {
  if (plans.length === 0) throw new Error("Cannot submit an empty batch");
  const batch = buildBatch(api, plans, schedule);
  return submitExtrinsic(api, batch, signer);
}

function submitExtrinsic(
  api: ApiPromise,
  extrinsic: ReturnType<typeof buildBatch>,
  signer: KeyringPair,
): Promise<FinalizedTransaction> {
  return new Promise((resolve, reject) => {
    let unsubscribe: (() => void) | undefined;
    let settled = false;

    const finish = (error: Error | null, value?: FinalizedTransaction): void => {
      if (settled) return;
      settled = true;
      unsubscribe?.();
      if (error) reject(error);
      else if (value) resolve(value);
    };

    extrinsic.signAndSend(signer, (result: ISubmittableResult) => {
      try {
        const failure = findDispatchFailure(api, result.events);
        if (failure) {
          finish(new Error(failure));
          return;
        }
        if (result.status.isFinalized) {
          finish(null, {
            blockHash: result.status.asFinalized.toHex(),
            extrinsicHash: extrinsic.hash.toHex(),
          });
        }
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    }).then((unsub) => {
      unsubscribe = unsub;
      if (settled) unsubscribe();
    }).catch((error: unknown) => {
      finish(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

export function findDispatchFailure(api: ApiPromise, events: EventRecord[]): string | undefined {
  for (const { event } of events) {
    if (event.section === "system" && event.method === "ExtrinsicFailed") {
      const dispatchError = event.data[0] as DispatchError | undefined;
      if (dispatchError?.isModule) {
        const decoded = api.registry.findMetaError(dispatchError.asModule);
        return `${decoded.section}.${decoded.name}: ${decoded.docs.join(" ")}`;
      }
      return dispatchError?.toString() ?? "system.ExtrinsicFailed";
    }
    if (event.section === "utility" && event.method === "BatchInterrupted") {
      return `utility.BatchInterrupted: ${event.data.toString()}`;
    }
    if (event.section === "sudo" && (event.method === "Sudid" || event.method === "SudoAsDone")) {
      const result = event.data[0] as unknown as { isErr: boolean; asErr: DispatchError };
      if (result.isErr) {
        const dispatchError = result.asErr;
        if (dispatchError.isModule) {
          const decoded = api.registry.findMetaError(dispatchError.asModule);
          return `${event.method}: ${decoded.section}.${decoded.name}: ${decoded.docs.join(" ")}`;
        }
        return `${event.method}: ${dispatchError.toString()}`;
      }
    }
  }
  return undefined;
}