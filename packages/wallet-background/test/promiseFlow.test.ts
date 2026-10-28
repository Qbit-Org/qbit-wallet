import { describe, expect, it } from 'vitest'

import PromiseFlow from '../src/utils/promiseFlow'

describe('PromiseFlow', () => {
  it('throws when use() receives non-function', () => {
    const flow = new PromiseFlow()
    expect(() => flow.use(null as any)).toThrow('promise need function to handle')
  })

  it('composes middlewares and runs in sequence', async () => {
    const flow = new PromiseFlow()
    const order: string[] = []

    flow
      .use(async (ctx, next) => {
        order.push('a:before')
        ctx.count += 1
        await next()
        order.push('a:after')
      })
      .use(async (ctx, next) => {
        order.push('b:before')
        ctx.count += 2
        await next()
        order.push('b:after')
      })
      .use(async (ctx) => {
        order.push('c')
        ctx.count += 3
      })

    const fn = flow.callback()
    const ctx = { count: 0 }

    await fn(ctx)

    expect(ctx.count).toBe(6)
    expect(order).toEqual(['a:before', 'b:before', 'c', 'b:after', 'a:after'])
  })
})
