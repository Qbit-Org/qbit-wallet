import { describe, expect, it } from 'vitest'

import { QbitSharedReads } from '../src/utils/qbit-shared-reads'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle
    reject = fail
  })
  return { promise, resolve, reject }
}

describe('QbitSharedReads latest answer per slot', () => {
  it('keeps a completed read with the key it ran under, for its scope and slot only', async () => {
    const reads = new QbitSharedReads<string>()
    const client = {}
    const answer = deferred<string>()
    const first = reads.run(client, 'qb1a#stats-1', () => answer.promise, 'qb1a')
    // A caller with the same key joins the running read.
    const joined = reads.run(client, 'qb1a#stats-1', async () => 'never read', 'qb1a')
    expect(reads.latest(client, 'qb1a')).toBeUndefined()

    answer.resolve('outputs')
    await expect(first).resolves.toBe('outputs')
    await expect(joined).resolves.toBe('outputs')

    expect(reads.latest(client, 'qb1a')).toEqual({ key: 'qb1a#stats-1', value: 'outputs' })
    expect(reads.latest(client, 'qb1b')).toBeUndefined()
    expect(reads.latest({}, 'qb1a')).toBeUndefined()
  })

  it('does not let a read that started earlier replace a later one that completed first', async () => {
    const reads = new QbitSharedReads<string>()
    const client = {}
    const older = deferred<string>()
    const olderRead = reads.run(client, 'qb1a#stats-1', () => older.promise, 'qb1a')
    await reads.run(client, 'qb1a#stats-2', async () => 'newer', 'qb1a')

    older.resolve('older')
    await olderRead

    expect(reads.latest(client, 'qb1a')).toEqual({ key: 'qb1a#stats-2', value: 'newer' })
  })

  it('keeps nothing for a failed read or a read without a slot', async () => {
    const reads = new QbitSharedReads<string>()
    const client = {}
    await reads.run(client, 'qb1a#stats-1', async () => 'first', 'qb1a')

    await expect(
      reads.run(
        client,
        'qb1a#stats-2',
        async () => Promise.reject(new Error('page failed')),
        'qb1a'
      )
    ).rejects.toThrow('page failed')
    await reads.run(client, 'qb1a#stats-3', async () => 'unslotted')

    expect(reads.latest(client, 'qb1a')).toEqual({ key: 'qb1a#stats-1', value: 'first' })
  })
})
