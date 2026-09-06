import { describe, expect, it, vi } from 'vitest'
import { sweep } from '../src/sweep/reconcile.js'
import type { SweepDeps, SweepOptions } from '../src/sweep/reconcile.js'

const OPTIONS: SweepOptions = {
  site: 'cdk-core.ty.ler.dev',
  stackPrefix: 'CdkCore',
  repo: 'tylerschloesser/cdk-core',
  dryRun: false,
}

type PrStateOrError = 'OPEN' | 'CLOSED' | 'MERGED' | Error

interface FakeState {
  stacks: string[]
  keys: string[]
  prefixes: string[]
  prStates: Record<number, PrStateOrError>
  deletedStacks: string[]
  deletedKeys: string[]
  deletedPrefixes: string[]
  failStacks: Set<string>
  failKeys: Set<string>
  failPrefixes: Set<string>
}

function emptyState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    stacks: [],
    keys: [],
    prefixes: [],
    prStates: {},
    deletedStacks: [],
    deletedKeys: [],
    deletedPrefixes: [],
    failStacks: new Set(),
    failKeys: new Set(),
    failPrefixes: new Set(),
    ...overrides,
  }
}

function createFakeDeps(state: FakeState): SweepDeps {
  return {
    async listPreviewStacks() {
      return state.stacks
    },
    async deleteStack(name) {
      if (state.failStacks.has(name)) {
        throw new Error(`boom: ${name}`)
      }
      state.deletedStacks.push(name)
    },
    async listKvsKeys() {
      return state.keys
    },
    async deleteKvsKey(key) {
      if (state.failKeys.has(key)) {
        throw new Error(`boom: ${key}`)
      }
      state.deletedKeys.push(key)
    },
    async listAssetPrefixes() {
      return state.prefixes
    },
    async deleteAssetPrefix(prefix) {
      if (state.failPrefixes.has(prefix)) {
        throw new Error(`boom: ${prefix}`)
      }
      state.deletedPrefixes.push(prefix)
    },
    async prState(n) {
      const value = state.prStates[n]
      if (value === undefined) {
        throw new Error(`test bug: no fake prState configured for PR #${n}`)
      }
      if (value instanceof Error) {
        throw value
      }
      return value
    },
    log: vi.fn(),
  }
}

describe('sweep', () => {
  it('finds nothing in a clean account and exits 0', async () => {
    const deps = createFakeDeps(emptyState())
    const result = await sweep(deps, OPTIONS)
    expect(result.rows).toEqual([])
    expect(result.exitCode).toBe(0)
  })

  it('exits 0 for a dry run of a clean account too', async () => {
    const deps = createFakeDeps(emptyState())
    const result = await sweep(deps, { ...OPTIONS, dryRun: true })
    expect(result.exitCode).toBe(0)
  })

  it("leaves an open PR's stack, key and prefix alone", async () => {
    const state = emptyState({
      stacks: ['CdkCore-pr-5'],
      keys: ['pr-5.preview.cdk-core.ty.ler.dev'],
      prefixes: ['pr-5/'],
      prStates: { 5: 'OPEN' },
    })
    const deps = createFakeDeps(state)
    const result = await sweep(deps, OPTIONS)

    expect(result.exitCode).toBe(0)
    expect(state.deletedStacks).toEqual([])
    expect(state.deletedKeys).toEqual([])
    expect(state.deletedPrefixes).toEqual([])
    expect(result.rows.every((row) => row.action === 'kept')).toBe(true)
  })

  it("deletes a closed PR's stack, key and prefix", async () => {
    const state = emptyState({
      stacks: ['CdkCore-pr-7'],
      keys: ['pr-7.preview.cdk-core.ty.ler.dev'],
      prefixes: ['pr-7/'],
      prStates: { 7: 'CLOSED' },
    })
    const deps = createFakeDeps(state)
    const result = await sweep(deps, OPTIONS)

    expect(state.deletedStacks).toEqual(['CdkCore-pr-7'])
    expect(state.deletedKeys).toEqual(['pr-7.preview.cdk-core.ty.ler.dev'])
    expect(state.deletedPrefixes).toEqual(['pr-7/'])
    expect(result.exitCode).toBe(0)
  })

  it('dry-runs the same closed-PR scenario without deleting anything, and is red', async () => {
    const state = emptyState({
      stacks: ['CdkCore-pr-7'],
      keys: ['pr-7.preview.cdk-core.ty.ler.dev'],
      prefixes: ['pr-7/'],
      prStates: { 7: 'CLOSED' },
    })
    const deps = createFakeDeps(state)
    const result = await sweep(deps, { ...OPTIONS, dryRun: true })

    expect(state.deletedStacks).toEqual([])
    expect(state.deletedKeys).toEqual([])
    expect(state.deletedPrefixes).toEqual([])
    expect(result.exitCode).not.toBe(0)
    expect(result.rows.every((row) => row.action === 'would-delete')).toBe(true)
  })

  it.each(['CdkCore-pr-1x', 'CdkCoreOther', 'CdkCore-pr-'])(
    'never deletes a stack name that fails the anchor: %s',
    async (name) => {
      const state = emptyState({ stacks: [name] })
      const deps = createFakeDeps(state)
      const result = await sweep(deps, OPTIONS)

      expect(state.deletedStacks).toEqual([])
      expect(result.rows).toEqual([])
      expect(result.exitCode).toBe(0)
    },
  )

  it('keeps everything and goes red when prState rejects', async () => {
    const state = emptyState({
      stacks: ['CdkCore-pr-9'],
      keys: ['pr-9.preview.cdk-core.ty.ler.dev'],
      prefixes: ['pr-9/'],
      prStates: { 9: new Error('gh: pull request not found') },
    })
    const deps = createFakeDeps(state)
    const result = await sweep(deps, OPTIONS)

    expect(state.deletedStacks).toEqual([])
    expect(state.deletedKeys).toEqual([])
    expect(state.deletedPrefixes).toEqual([])
    expect(result.exitCode).not.toBe(0)
    expect(result.rows.every((row) => row.action === 'kept')).toBe(true)
    expect(result.rows.every((row) => row.reason.includes('PR lookup failed'))).toBe(true)
  })

  it('deletes an orphaned key whose stack no longer matches anything, with no stack in play', async () => {
    const state = emptyState({
      keys: ['pr-3.preview.cdk-core.ty.ler.dev'],
      prStates: { 3: 'CLOSED' },
    })
    const deps = createFakeDeps(state)
    const result = await sweep(deps, OPTIONS)

    expect(state.deletedKeys).toEqual(['pr-3.preview.cdk-core.ty.ler.dev'])
    expect(result.exitCode).toBe(0)
  })

  it('catches orphans independently on each side: a key with no matching stack, and a stack with no matching key', async () => {
    const state = emptyState({
      // PR 10's stack is already gone (never in the listing) but its key survives.
      // PR 11's stack is still around; its prefix already got cleaned up somehow.
      stacks: ['CdkCore-pr-11'],
      keys: ['pr-10.preview.cdk-core.ty.ler.dev', 'pr-11.preview.cdk-core.ty.ler.dev'],
      prefixes: ['pr-11/'],
      prStates: { 10: 'CLOSED', 11: 'MERGED' },
    })
    const deps = createFakeDeps(state)
    const result = await sweep(deps, OPTIONS)

    expect(state.deletedStacks).toEqual(['CdkCore-pr-11'])
    expect(state.deletedKeys.sort()).toEqual([
      'pr-10.preview.cdk-core.ty.ler.dev',
      'pr-11.preview.cdk-core.ty.ler.dev',
    ])
    expect(state.deletedPrefixes).toEqual(['pr-11/'])
    expect(result.exitCode).toBe(0)
  })

  it('keeps going past one deleteStack failure and still deletes the rest, and goes red', async () => {
    const state = emptyState({
      stacks: ['CdkCore-pr-1', 'CdkCore-pr-2'],
      prStates: { 1: 'CLOSED', 2: 'MERGED' },
      failStacks: new Set(['CdkCore-pr-1']),
    })
    const deps = createFakeDeps(state)
    const result = await sweep(deps, OPTIONS)

    expect(state.deletedStacks).toEqual(['CdkCore-pr-2'])
    expect(result.exitCode).not.toBe(0)

    const failedRow = result.rows.find((row) => row.id === 'CdkCore-pr-1')
    const deletedRow = result.rows.find((row) => row.id === 'CdkCore-pr-2')
    expect(failedRow?.action).toBe('failed')
    expect(deletedRow?.action).toBe('deleted')
  })
})
