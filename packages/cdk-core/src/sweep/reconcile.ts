/**
 * `cdk-core sweep`'s pure reconciliation logic (plan.md D3 and "The sweeper
 * (`cdk-core sweep`)"). No AWS SDK import, no `gh`, no network — every side
 * effect the sweeper needs is a method on `SweepDeps`, so `test/sweep.test.ts`
 * exercises this file entirely against fakes. `src/sweep/aws.ts` supplies the
 * real implementations; `src/bin/sweep.ts` wires the two together.
 */

export interface SweepOptions {
  /** e.g. 'cdk-core.ty.ler.dev' */
  readonly site: string
  /** e.g. 'CdkCore' */
  readonly stackPrefix: string
  /** e.g. 'tylerschloesser/cdk-core' */
  readonly repo: string
  readonly dryRun: boolean
}

/** Everything that touches the outside world. The tests pass fakes. */
export interface SweepDeps {
  /** Non-deleted stack names. */
  listPreviewStacks(): Promise<string[]>
  /** Delete + wait for completion. */
  deleteStack(name: string): Promise<void>
  listKvsKeys(): Promise<string[]>
  deleteKvsKey(key: string): Promise<void>
  /** e.g. ['pr-1/', 'pr-7/'] */
  listAssetPrefixes(): Promise<string[]>
  deleteAssetPrefix(prefix: string): Promise<void>
  /** e.g. ['/aws/lambda/CdkCore-pr-1-ApiFn...'] */
  listLogGroups(): Promise<string[]>
  deleteLogGroup(name: string): Promise<void>
  /** Rejects if the lookup fails. */
  prState(n: number): Promise<'OPEN' | 'CLOSED' | 'MERGED'>
  log(line: string): void
}

export interface SweepRow {
  readonly kind: 'stack' | 'key' | 'prefix' | 'log-group'
  readonly id: string
  readonly pr: number
  readonly action: 'deleted' | 'would-delete' | 'kept' | 'failed'
  readonly reason: string
}

export interface SweepResult {
  readonly rows: SweepRow[]
  readonly exitCode: number
}

type PrState = 'OPEN' | 'CLOSED' | 'MERGED'

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isClosed(state: PrState): boolean {
  return state === 'CLOSED' || state === 'MERGED'
}

/**
 * Memoizes `prState` per PR number so steps 2-5 can share one GitHub lookup
 * per PR instead of issuing up to four. This is purely an optimization: each
 * step still derives its own keep/delete decision from the (possibly cached)
 * result rather than from another step having run for the same PR — a key or
 * prefix whose stack never matched anything in step 1 still gets its own
 * lookup here.
 */
function memoizePrState(
  prState: SweepDeps['prState'],
): (n: number) => Promise<PrState> {
  const cache = new Map<number, Promise<PrState>>()
  return (n) => {
    let entry = cache.get(n)
    if (!entry) {
      entry = prState(n)
      cache.set(n, entry)
    }
    return entry
  }
}

export async function sweep(
  deps: SweepDeps,
  options: SweepOptions,
): Promise<SweepResult> {
  const rows: SweepRow[] = []
  let hadFailure = false
  let hadLookupFailure = false
  const prState = memoizePrState(deps.prState)

  // ---- 1 & 2: CloudFormation stacks ----
  //
  // Anchored so nothing but exactly `<prefix>-pr-<digits>` is ever a
  // candidate for deletion. This is a safety property, not a convenience:
  // an unanchored pattern (or an un-escaped prefix) could let a crafted or
  // merely coincidental stack name reach `deleteStack` in an account that
  // hosts three other production sites.
  const stackPattern = new RegExp(
    `^${escapeRegExp(options.stackPrefix)}-pr-([0-9]+)$`,
  )

  const allStacks = await deps.listPreviewStacks()
  const matchedStacks: { name: string; pr: number }[] = []
  for (const name of allStacks) {
    const match = stackPattern.exec(name)
    if (!match) {
      deps.log(`skip: stack ${name} does not match the pr-stack anchor, leaving untouched`)
      continue
    }
    matchedStacks.push({ name, pr: Number(match[1]) })
  }

  // The set of stacks that will still exist once this sweep is done: a
  // stack we actually delete (or, in --dry-run, would delete) drops out of
  // it. Steps 3, 4 and 5 key their orphan check off this set rather than the
  // raw listing, so that a closed PR's key, prefix and log groups are
  // recognized as orphans in the very same run that deletes its stack,
  // without those steps having to depend on step 2 having run for that PR —
  // a resource whose stack was never in the raw listing at all (already
  // gone) is simply never in this set either.
  const stillLive = new Set(matchedStacks.map((s) => s.name))

  for (const { name, pr } of matchedStacks) {
    let state: PrState
    try {
      state = await prState(pr)
    } catch (error) {
      // A GitHub lookup failure must never be read as "closed" — keep the
      // stack, report why, and make the run red.
      hadLookupFailure = true
      rows.push({
        kind: 'stack',
        id: name,
        pr,
        action: 'kept',
        reason: `PR lookup failed: ${errorMessage(error)}`,
      })
      continue
    }

    if (!isClosed(state)) {
      rows.push({ kind: 'stack', id: name, pr, action: 'kept', reason: 'PR is open' })
      continue
    }

    if (options.dryRun) {
      stillLive.delete(name)
      rows.push({
        kind: 'stack',
        id: name,
        pr,
        action: 'would-delete',
        reason: `PR is ${state}`,
      })
      continue
    }

    try {
      await deps.deleteStack(name)
      stillLive.delete(name)
      rows.push({ kind: 'stack', id: name, pr, action: 'deleted', reason: `PR is ${state}` })
    } catch (error) {
      // One stack that refuses to delete must not stop the sweep — the
      // others are still owed a teardown.
      hadFailure = true
      rows.push({
        kind: 'stack',
        id: name,
        pr,
        action: 'failed',
        reason: `delete failed: ${errorMessage(error)}`,
      })
    }
  }

  // ---- 3: KVS keys ----
  const keyPattern = new RegExp(
    `^pr-([0-9]+)\\.preview\\.${escapeRegExp(options.site)}$`,
  )
  const allKeys = await deps.listKvsKeys()
  for (const key of allKeys) {
    const match = keyPattern.exec(key)
    if (!match) {
      deps.log(`skip: key ${key} does not match the pr-key anchor, leaving untouched`)
      continue
    }
    await reconcileOrphan(options, prState, {
      kind: 'key',
      id: key,
      pr: Number(match[1]),
      stillLive,
      rows,
      onFailure: () => {
        hadFailure = true
      },
      onLookupFailure: () => {
        hadLookupFailure = true
      },
      del: () => deps.deleteKvsKey(key),
    })
  }

  // ---- 4: S3 asset prefixes ----
  const prefixPattern = /^pr-([0-9]+)\/$/
  const allPrefixes = await deps.listAssetPrefixes()
  for (const prefix of allPrefixes) {
    const match = prefixPattern.exec(prefix)
    if (!match) {
      deps.log(`skip: prefix ${prefix} does not match the pr-prefix anchor, leaving untouched`)
      continue
    }
    await reconcileOrphan(options, prState, {
      kind: 'prefix',
      id: prefix,
      pr: Number(match[1]),
      stillLive,
      rows,
      onFailure: () => {
        hadFailure = true
      },
      onLookupFailure: () => {
        hadLookupFailure = true
      },
      del: () => deps.deleteAssetPrefix(prefix),
    })
  }

  // ---- 5: CloudWatch log groups ----
  //
  // Lambda creates `/aws/lambda/<function-name>` on first invoke, so
  // CloudFormation never owns the group and never deletes it with the stack
  // (issue #12). Anchored at `^/aws/lambda/<prefix>-pr-` for the same safety
  // reason as the stack pattern above, and with one extra constraint: the
  // trailing `-` after the capture group. A log-group name carries a function
  // suffix after the PR number, so without that hyphen `<prefix>-pr-1` would
  // also match `<prefix>-pr-12-Foo`. The anchor is also what keeps the live
  // `<prefix>Site-*` and `<prefix>Preview-*` groups — and the other
  // production sites sharing `/aws/lambda/` in this account — out of reach.
  const logGroupPattern = new RegExp(
    `^/aws/lambda/${escapeRegExp(options.stackPrefix)}-pr-([0-9]+)-`,
  )
  const allLogGroups = await deps.listLogGroups()
  for (const name of allLogGroups) {
    const match = logGroupPattern.exec(name)
    if (!match) {
      deps.log(
        `skip: log group ${name} does not match the pr-log-group anchor, leaving untouched`,
      )
      continue
    }
    await reconcileOrphan(options, prState, {
      kind: 'log-group',
      id: name,
      pr: Number(match[1]),
      stillLive,
      rows,
      onFailure: () => {
        hadFailure = true
      },
      onLookupFailure: () => {
        hadLookupFailure = true
      },
      del: () => deps.deleteLogGroup(name),
    })
  }

  // ---- 6: print ----
  printTable(deps, rows)

  // Exit code rule: 0 only when nothing failed and, in --dry-run, nothing
  // *would* be deleted. A dry run's job in the acceptance test is to prove
  // the account is clean, so "would delete something" is a red run, exactly
  // like an actual delete failure or a lookup failure would be.
  const wouldDeleteSomething = rows.some((row) => row.action === 'would-delete')
  const exitCode =
    hadFailure || hadLookupFailure || (options.dryRun && wouldDeleteSomething) ? 1 : 0

  return { rows, exitCode }
}

/**
 * Shared orphan logic for a KVS key, an S3 prefix or a log group: a resource
 * is an orphan
 * when the stack for its PR is not (and will not remain) in `stillLive` and
 * the PR itself is closed/merged. Both conditions are evaluated independently
 * of whichever other step ran — a lookup failure keeps the resource, exactly
 * as it does for a stack.
 */
async function reconcileOrphan(
  options: SweepOptions,
  prState: (n: number) => Promise<PrState>,
  args: {
    kind: 'key' | 'prefix' | 'log-group'
    id: string
    pr: number
    stillLive: ReadonlySet<string>
    rows: SweepRow[]
    onFailure: () => void
    onLookupFailure: () => void
    del: () => Promise<void>
  },
): Promise<void> {
  const { kind, id, pr, stillLive, rows, onFailure, onLookupFailure, del } = args
  const stackName = `${options.stackPrefix}-pr-${pr}`
  const stackIsLive = stillLive.has(stackName)

  let state: PrState
  try {
    state = await prState(pr)
  } catch (error) {
    onLookupFailure()
    rows.push({
      kind,
      id,
      pr,
      action: 'kept',
      reason: `PR lookup failed: ${errorMessage(error)}`,
    })
    return
  }

  const orphan = !stackIsLive && isClosed(state)
  if (!orphan) {
    rows.push({
      kind,
      id,
      pr,
      action: 'kept',
      reason: stackIsLive ? 'stack still live' : 'PR is open',
    })
    return
  }

  if (options.dryRun) {
    rows.push({
      kind,
      id,
      pr,
      action: 'would-delete',
      reason: `PR is ${state}, stack gone`,
    })
    return
  }

  try {
    await del()
    rows.push({ kind, id, pr, action: 'deleted', reason: `PR is ${state}, stack gone` })
  } catch (error) {
    onFailure()
    rows.push({
      kind,
      id,
      pr,
      action: 'failed',
      reason: `delete failed: ${errorMessage(error)}`,
    })
  }
}

function printTable(deps: SweepDeps, rows: readonly SweepRow[]): void {
  if (rows.length === 0) {
    deps.log('(nothing to reconcile)')
    return
  }
  const headers = ['KIND', 'ID', 'PR', 'ACTION', 'REASON']
  const data = rows.map((row) => [row.kind, row.id, String(row.pr), row.action, row.reason])
  const table = [headers, ...data]
  const widths = headers.map((_, col) => Math.max(...table.map((r) => r[col]!.length)))
  for (const r of table) {
    deps.log(r.map((cell, col) => cell.padEnd(widths[col]!)).join('  ').trimEnd())
  }
}
