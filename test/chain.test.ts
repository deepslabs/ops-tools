import assert from "node:assert/strict";
import test from "node:test";

import type { ApiPromise } from "@polkadot/api";
import type { Codec } from "@polkadot/types/types";

import {
  buildBatch,
  buildReleaseTimeUpdate,
  buildWithdrawBatch,
  chunkPlans,
  createDistributionPlan,
  parseLinearReleaseBalance,
  requiredPrincipal,
  validateSchedule,
  type ReleaseSchedule,
} from "../src/chain.js";
import { DPS_BASE, TOP_UP_AMOUNT, type DistributionEntry } from "../src/csv.js";

const SCHEDULE: ReleaseSchedule = { fromBlock: 10_000_000, toBlock: 20_000_000, releaseInterval: 1_000 };
const ENTRY: DistributionEntry = {
  address: "0x1111111111111111111111111111111111111111",
  tokenAmount: 12n,
  baseUnitAmount: 12n * DPS_BASE,
  sourceRows: [2],
};

test("plans a release only for positive allocations without an existing release", () => {
  assert.equal(createDistributionPlan(ENTRY, false).createRelease, true);
  assert.equal(createDistributionPlan(ENTRY, true).createRelease, false);
  assert.equal(createDistributionPlan({ ...ENTRY, tokenAmount: 0n, baseUnitAmount: 0n }, false).createRelease, false);
});

test("required principal includes only new releases and every top-up", () => {
  const plans = [
    createDistributionPlan(ENTRY, false),
    createDistributionPlan({ ...ENTRY, address: "0x2222222222222222222222222222222222222222" }, true),
  ];
  assert.equal(requiredPrincipal(plans), 12n * DPS_BASE + 2n * TOP_UP_AMOUNT);
});

test("builds multiple accounts in one atomic batch", () => {
  const calls: unknown[] = [];
  const api = {
    tx: {
      incentive: {
        addLinerRelease: (...args: unknown[]) => ({ kind: "release", args }),
      },
      balances: {
        transferAllowDeath: (...args: unknown[]) => ({ kind: "transfer", args }),
      },
      utility: {
        batchAll: (batchCalls: unknown[]) => {
          calls.push(...batchCalls);
          return { batchCalls };
        },
      },
    },
  } as unknown as ApiPromise;

  const secondEntry = {
    ...ENTRY,
    address: "0x2222222222222222222222222222222222222222",
    baseUnitAmount: 0n,
    tokenAmount: 0n,
  };
  buildBatch(api, [
    createDistributionPlan(ENTRY, false),
    createDistributionPlan(secondEntry, false),
  ], SCHEDULE);
  assert.deepEqual(calls, [
    { kind: "release", args: [ENTRY.address, ENTRY.baseUnitAmount, 10_000_000, 20_000_000, 1_000] },
    { kind: "transfer", args: [ENTRY.address, TOP_UP_AMOUNT] },
    { kind: "transfer", args: [secondEntry.address, TOP_UP_AMOUNT] },
  ]);
});

test("existing releases and zero allocations build top-up-only batches", () => {
  const batches: unknown[][] = [];
  const api = {
    tx: {
      incentive: { addLinerRelease: () => assert.fail("release should not be called") },
      balances: { transferAllowDeath: (...args: unknown[]) => ({ kind: "transfer", args }) },
      utility: { batchAll: (calls: unknown[]) => { batches.push(calls); return { calls }; } },
    },
  } as unknown as ApiPromise;

  buildBatch(api, [createDistributionPlan(ENTRY, true)], SCHEDULE);
  buildBatch(api, [createDistributionPlan({ ...ENTRY, baseUnitAmount: 0n, tokenAmount: 0n }, false)], SCHEDULE);
  assert.equal(batches.length, 2);
  assert.ok(batches.every((calls) => calls.length === 1));
});

test("chunks account plans by the configured batch size", () => {
  const plans = [
    createDistributionPlan(ENTRY, false),
    createDistributionPlan({ ...ENTRY, address: "0x2222222222222222222222222222222222222222" }, false),
    createDistributionPlan({ ...ENTRY, address: "0x3333333333333333333333333333333333333333" }, false),
  ];
  assert.deepEqual(chunkPlans(plans, 2).map((group) => group.length), [2, 1]);
  assert.throws(() => chunkPlans(plans, 0), /positive integer/);
});

test("builds a root-authorized release-time update for an account group", () => {
  const accounts = [
    ENTRY.address,
    "0x2222222222222222222222222222222222222222",
  ];
  const api = {
    tx: {
      incentive: {
        updateLinerReleaseTime: (...args: unknown[]) => ({ kind: "update-time", args }),
      },
      sudo: {
        sudo: (call: unknown) => ({ kind: "sudo", call }),
      },
    },
  } as unknown as ApiPromise;

  assert.deepEqual(buildReleaseTimeUpdate(api, accounts, SCHEDULE), {
    kind: "sudo",
    call: { kind: "update-time", args: [accounts, 10_000_000, 20_000_000] },
  });
  assert.throws(() => buildReleaseTimeUpdate(api, [], SCHEDULE), /empty account batch/);
});

test("builds delegated withdrawals with each account as the call origin", () => {
  const accounts = [
    ENTRY.address,
    "0x2222222222222222222222222222222222222222",
  ];
  const api = {
    tx: {
      incentive: {
        withdrawLinerRelease: () => ({ kind: "withdraw" }),
      },
      sudo: {
        sudoAs: (account: string, call: unknown) => ({ kind: "sudoAs", account, call }),
      },
      utility: {
        batchAll: (calls: unknown[]) => ({ kind: "batchAll", calls }),
      },
    },
  } as unknown as ApiPromise;

  assert.deepEqual(buildWithdrawBatch(api, accounts), {
    kind: "batchAll",
    calls: accounts.map((account) => ({
      kind: "sudoAs",
      account,
      call: { kind: "withdraw" },
    })),
  });
  assert.throws(() => buildWithdrawBatch(api, []), /empty account batch/);
});

test("parses remaining locked balance from a linear release record", () => {
  const release = {
    toJSON: () => ({
      total: "0x00000000000000000000000000000064",
      remaining: "0x00000000000000000000000000000028",
      fromBlock: 10,
      toBlock: 20,
      releaseInterval: 5,
      latestWithdrawBlock: 15,
    }),
  } as unknown as Codec;

  assert.deepEqual(parseLinearReleaseBalance(ENTRY.address, release), {
    address: ENTRY.address,
    total: 100n,
    remaining: 40n,
    fromBlock: 10,
    toBlock: 20,
    releaseInterval: 5,
    latestWithdrawBlock: 15,
  });
});

test("validates u32 release schedules", () => {
  assert.doesNotThrow(() => validateSchedule(SCHEDULE));
  assert.throws(() => validateSchedule({ ...SCHEDULE, toBlock: 0 }), /toBlock/);
  assert.throws(() => validateSchedule({ ...SCHEDULE, releaseInterval: 2 ** 32 }), /u32/);
});