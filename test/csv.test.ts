import assert from "node:assert/strict";
import test from "node:test";

import { DPS_BASE, TOP_UP_AMOUNT, formatCsvRow, formatDps, parseDistributionCsv } from "../src/csv.js";

const HEADER = "Address,BTCECO,DS800,DS15000,VDS,DPS";
const ADDRESS_A = "0x1111111111111111111111111111111111111111";
const ADDRESS_B = "0x2222222222222222222222222222222222222222";

test("aggregates duplicate addresses case-insensitively and scales DPS", () => {
  const manifest = parseDistributionCsv([
    HEADER,
    `${ADDRESS_A},0,0,0,0,12`,
    `${ADDRESS_A.toUpperCase().replace("0X", "0x")},0,0,0,0,8`,
    `${ADDRESS_B},0,0,0,0,0`,
  ].join("\n"));

  assert.equal(manifest.sourceRowCount, 3);
  assert.equal(manifest.uniqueAddressCount, 2);
  assert.equal(manifest.duplicateRowCount, 1);
  assert.equal(manifest.zeroAmountCount, 1);
  assert.equal(manifest.totalTokenAmount, 20n);
  assert.equal(manifest.totalBaseUnitAmount, 20n * DPS_BASE);
  assert.equal(manifest.totalTopUpAmount, 2n * TOP_UP_AMOUNT);
  assert.equal(manifest.entries[0]?.tokenAmount, 20n);
  assert.deepEqual(manifest.entries[0]?.sourceRows, [2, 3]);
});

test("retains integer precision beyond Number.MAX_SAFE_INTEGER", () => {
  const amount = "900719925474099312345";
  const manifest = parseDistributionCsv(`${HEADER}\n${ADDRESS_A},0,0,0,0,${amount}\n`);
  assert.equal(manifest.entries[0]?.baseUnitAmount, BigInt(amount) * DPS_BASE);
});

test("rejects an invalid header, address, or amount", () => {
  assert.throws(() => parseDistributionCsv(`Wrong,BTCECO,DS800,DS15000,VDS,DPS\n${ADDRESS_A},0,0,0,0,1`), /Invalid CSV header/);
  assert.throws(() => parseDistributionCsv(`${HEADER}\n0x1234,0,0,0,0,1`), /invalid 20-byte address/);
  assert.throws(() => parseDistributionCsv(`${HEADER}\n${ADDRESS_A},0,0,0,0,1.5`), /non-negative integer/);
});

test("formats exact DPS amounts", () => {
  assert.equal(TOP_UP_AMOUNT, 100_000_000_000_000_000n);
  assert.equal(formatDps(TOP_UP_AMOUNT), "0.1");
  assert.equal(formatDps(12n * DPS_BASE), "12");
});

test("formats CSV rows with empty and escaped fields", () => {
  assert.equal(formatCsvRow(["address", "Active", 10, null]), "address,Active,10,");
  assert.equal(formatCsvRow(['a,b', 'a"b']), '"a,b","a""b"');
});