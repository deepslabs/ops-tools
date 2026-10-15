# DeepS DPS Distribution Tool

This CLI reads `tDPS.csv`, aggregates the addresses in the first column and the DPS amounts in the sixth column, creates linear release schedules through `incentive.addLinerRelease` on the DeepS Testnet, and transfers an additional `0.1 DPS` to each unique address.

## Fixed Rules

- RPC: `wss://rpc-testnet.deeps.fi`
- DPS precision: 18 decimals; the sixth CSV column represents whole DPS tokens
- Default release blocks: `10,000,000` to `20,000,000`, with an interval of `1,000`
- Addresses are aggregated case-insensitively, and values in the sixth column are summed for duplicate rows
- Addresses with a zero allocation do not receive a release schedule, but still receive `0.1 DPS`
- Addresses with an existing linear release schedule skip release creation, but still receive `0.1 DPS`
- By default, up to 10 addresses are combined into one `utility.batchAll`; the next batch is processed only after finalization

`addLinerRelease` transfers and locks the allocated amount from the signing account. The additional `0.1 DPS` is a separate Balances transfer within the same atomic batch.

## Installation and Checks

Node.js 20 or later is required:

```bash
npm install
npm run typecheck
npm test
```

## Dry Run

By default, the command connects to the testnet, validates the live metadata, and checks whether each address already has a release schedule. It does not read a mnemonic, sign, or broadcast transactions:

```bash
npm run dry-run -- --csv tDPS.csv
```

A normalized manifest can also be written for manual review; the output file must not already exist:

```bash
npm run dry-run -- --csv tDPS.csv --manifest distribution-manifest.json
```

The CLI displays CSV statistics, amounts, the manifest hash, chain/genesis hash, current finalized block, and counts of new releases and subsidy-only addresses. The default release start is absolute block `10,000,000`, not a block relative to the current block. The tool warns if the release period has already started or ended, but does not modify the parameters automatically.

## Testnet Execution

Copy the environment variable template and enter the mnemonic in a local `.env` file. `.env` is excluded by `.gitignore`; do not commit or share it:

```bash
cp .env.example .env
npm run start -- --csv tDPS.csv --execute
```

A shell environment variable can also be used directly. An exported `SIGNER_KEY` takes precedence over the value in `.env`:

```bash
export SIGNER_KEY='0x0000...01'
npm run start -- --csv tDPS.csv --execute
```

The tool applies the following safeguards:

1. Validates DPS, 18-decimal precision, AccountId20, and the required runtime methods.
2. Queries existing release schedules and estimates fees for all pending transactions.
3. Verifies that the signing account balance covers the principal for all new releases, every `0.1 DPS` subsidy, and the estimated fees.
4. Requires entering `EXECUTE` before broadcasting begins.
5. After each batch is finalized successfully, writes every address in that batch to `distribution-results.jsonl`; it stops immediately on failure.

Each transaction contains 10 accounts by default. The batch size can be adjusted:

```bash
npm run start -- --csv tDPS.csv --execute --batch-size 20
```

Each batch uses `utility.batchAll`, so a failure for any account rolls back the entire batch, and no addresses from that batch are written to the success log. Larger batches increase the weight and length of each transaction. Test with the default value first; do not combine all accounts into a single batch.

Automated environments can use `--yes` to skip interactive confirmation, but `--execute` must still be provided explicitly:

```bash
npm run start -- --csv tDPS.csv --execute --yes
```

## Batch Release-Time Updates

Configure the URI of the current on-chain sudo account in `.env`:

```dotenv
ROOT_KEY=your root account secret key
```

Run a dry run first. This mode reads only the first CSV column, deduplicates the addresses, and groups them according to `--batch-size`. It does not distribute tokens or transfer `0.1 DPS`:

```bash
npm run dry-run -- --csv tDPS.csv --update-release-time --from-block 10000000 --to-block 20000000
```

After confirming the number of batches and the release times, execute the update:

```bash
npm run start -- --csv tDPS.csv --update-release-time --from-block 10000000 --to-block 20000000 --batch-size 10 --execute
```

The tool verifies that the address derived from `ROOT_KEY` matches the on-chain `sudo.key`, then submits `sudo.sudo(incentive.updateLinerReleaseTime(accounts, fromBlock, toBlock))`. Each group of accounts is submitted as one transaction. The tool waits for finalization and detects inner-call errors in `sudo.Sudid`. This mode does not use `SIGNER_KEY`.

## Batch Release Withdrawal on Behalf of Accounts

Batch withdrawal uses the deduplicated addresses from the first CSV column and is signed by the sudo account associated with `ROOT_KEY`. Run a dry run first to review the number of accounts and batches:

```bash
npm run dry-run -- --csv tDPS.csv --withdraw-release --batch-size 10
```

After confirmation, execute the withdrawals:

```bash
npm run start -- --csv tDPS.csv --withdraw-release --batch-size 10 --execute
```

For each account, the tool constructs `sudo.sudoAs(account, incentive.withdrawLinerRelease())`, then combines each group using `utility.batchAll`. `sudoAs` makes the signed origin seen by `withdrawLinerRelease` the target account, so the released amount is deposited into the target account rather than the ROOT account. The tool verifies the ROOT address, estimates fees, waits for finalization, and checks the inner result of every `sudo.SudoAsDone` event.

Note: Inner failures from `sudoAs` are returned through events, while the outer call itself may still succeed. As a result, earlier accounts in a batch may withdraw successfully even if a later account fails; this mode must not be treated as an atomic rollback of the entire batch. When an error occurs, the tool stops subsequent batches and reports the failure. Check the on-chain withdrawal status before rerunning.

## Locked-Balance Statistics

Query `incentive.linearReleaseForAccount(account)` for the deduplicated addresses from the first CSV column:

```bash
npm run dry-run -- --csv tDPS.csv --locked-balances
```

This mode is read-only. It does not read `SIGNER_KEY` or `ROOT_KEY`, and it does not sign or broadcast transactions. The following CSV fields are written to stdout:

```text
Address,Status,RemainingDPS,TotalDPS,FromBlock,ToBlock,ReleaseInterval,LatestWithdrawBlock
```

Use `--silent` to save clean CSV output to a file without npm's command header appearing in the output:

```bash
npm run --silent dry-run -- --csv tDPS.csv --locked-balances > locked-balances.csv
```

One row is emitted per account; the total locked amount across accounts is not calculated. `RemainingDPS` and `TotalDPS` are converted to DPS using 18-decimal precision. Accounts without a release record use `Status=NoRelease`, with the remaining fields left empty.

## Resuming an Interrupted Run

After an interruption, resume using the original CSV, signing account, network, and release parameters:

```bash
npm run start -- --csv tDPS.csv --execute --resume distribution-results.jsonl
```

The log header binds the genesis hash, signer address, manifest hash, and release parameters. A mismatch in any value prevents the run from resuming. Addresses already recorded as successful do not receive another `0.1 DPS`. Do not edit the log manually.

## Options

```text
--csv <path>                 CSV file; defaults to tDPS.csv
--rpc <url>                  WebSocket RPC
--from-block <u32>           Absolute release start block
--to-block <u32>             Absolute release end block
--release-interval <u32>     Release interval
--batch-size <count>         Accounts per atomic batch; defaults to 10
--update-release-time        Batch-update release times using ROOT_KEY
--withdraw-release           Batch-withdraw releases using ROOT_KEY and sudoAs
--locked-balances            Output DPS lock information for each account
--manifest <path>            Write a normalized JSON manifest
--execute                    Sign and broadcast
--journal <path>             Path for a new execution log
--resume <path>              Resume from an existing execution log
--yes                        Skip the interactive EXECUTE confirmation
```

Before a full run, perform a testnet rehearsal with a small CSV containing only one address that does not yet have a release schedule. In a block explorer, verify the finalized transaction, the `Incentive.LinerReleaseInfo` event, the locked amount, and the `0.1 DPS` transfer.