import { readFile } from "node:fs/promises";

import { parse } from "csv-parse/sync";

export const DPS_DECIMALS = 18;
export const DPS_BASE = 10n ** BigInt(DPS_DECIMALS);
export const TOP_UP_AMOUNT = DPS_BASE / 10n;

const EXPECTED_HEADER = ["Address", "BTCECO", "DS800", "DS15000", "VDS", "DPS"] as const;
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const INTEGER_PATTERN = /^\d+$/;

export interface DistributionEntry {
  address: string;
  tokenAmount: bigint;
  baseUnitAmount: bigint;
  sourceRows: number[];
}

export interface DistributionManifest {
  sourceRowCount: number;
  uniqueAddressCount: number;
  duplicateRowCount: number;
  zeroAmountCount: number;
  totalTokenAmount: bigint;
  totalBaseUnitAmount: bigint;
  totalTopUpAmount: bigint;
  entries: DistributionEntry[];
}

export async function loadDistributionCsv(filePath: string): Promise<DistributionManifest> {
  return parseDistributionCsv(await readFile(filePath, "utf8"));
}

export function parseDistributionCsv(content: string): DistributionManifest {
  const records = parse(content, {
    bom: true,
    columns: false,
    skip_empty_lines: true,
    trim: false,
    relax_column_count: false,
  }) as string[][];

  if (records.length === 0) {
    throw new Error("CSV is empty");
  }

  const header = records[0];
  if (!header || header.length !== EXPECTED_HEADER.length ||
      header.some((value, index) => value !== EXPECTED_HEADER[index])) {
    throw new Error(`Invalid CSV header; expected ${EXPECTED_HEADER.join(",")}`);
  }

  const aggregated = new Map<string, { tokenAmount: bigint; sourceRows: number[] }>();

  for (let index = 1; index < records.length; index += 1) {
    const record = records[index];
    const rowNumber = index + 1;
    if (!record || record.length !== EXPECTED_HEADER.length) {
      throw new Error(`Row ${rowNumber}: expected ${EXPECTED_HEADER.length} columns`);
    }

    const address = record[0];
    const amount = record[5];
    if (!address || !ADDRESS_PATTERN.test(address)) {
      throw new Error(`Row ${rowNumber}: invalid 20-byte address`);
    }
    if (!amount || !INTEGER_PATTERN.test(amount)) {
      throw new Error(`Row ${rowNumber}: DPS amount must be a non-negative integer`);
    }

    const normalizedAddress = address.toLowerCase();
    const current = aggregated.get(normalizedAddress);
    if (current) {
      current.tokenAmount += BigInt(amount);
      current.sourceRows.push(rowNumber);
    } else {
      aggregated.set(normalizedAddress, {
        tokenAmount: BigInt(amount),
        sourceRows: [rowNumber],
      });
    }
  }

  const entries = [...aggregated.entries()]
    .map(([address, value]) => ({
      address,
      tokenAmount: value.tokenAmount,
      baseUnitAmount: value.tokenAmount * DPS_BASE,
      sourceRows: value.sourceRows,
    }))
    .sort((left, right) => left.address.localeCompare(right.address));

  const totalTokenAmount = entries.reduce((total, entry) => total + entry.tokenAmount, 0n);
  const sourceRowCount = records.length - 1;

  return {
    sourceRowCount,
    uniqueAddressCount: entries.length,
    duplicateRowCount: sourceRowCount - entries.length,
    zeroAmountCount: entries.filter((entry) => entry.tokenAmount === 0n).length,
    totalTokenAmount,
    totalBaseUnitAmount: totalTokenAmount * DPS_BASE,
    totalTopUpAmount: BigInt(entries.length) * TOP_UP_AMOUNT,
    entries,
  };
}

export function formatDps(baseUnits: bigint): string {
  const whole = baseUnits / DPS_BASE;
  const fraction = (baseUnits % DPS_BASE).toString().padStart(DPS_DECIMALS, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function formatCsvRow(values: Array<string | number | null>): string {
  return values.map((value) => {
    const text = value === null ? "" : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  }).join(",");
}