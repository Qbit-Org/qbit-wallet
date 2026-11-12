// Test support, not a test file: the tests of the extension and of the
// packages import it, and no source file does, so it never reaches a bundle.

// Taken when this module loads, before a test installs fake timers:
// vi.useFakeTimers() replaces setTimeout, and a fake one fires only when the
// test moves the clock.
const realSetTimeout = globalThis.setTimeout

const nextTurn = () => new Promise<void>(resolve => realSetTimeout(resolve, 0))

/**
 * The reasons of the rejections that nothing handled while `run` ran, as Node
 * reports them through `unhandledRejection`.
 *
 * Node reports a rejection only once the microtasks have drained after the
 * task that made it, so this lets two turns of the event loop pass after
 * `run`, on real timers whatever the test's clock. While it listens, vitest
 * does not report those rejections itself: the test has to assert on them.
 *
 * Only a promise that the code under test was given can show up here. A spy
 * (`vi.fn`, `vi.spyOn`) attaches its own handlers to every promise it returns,
 * so `mockRejectedValue` and the like hand over a rejection that is already
 * handled. To test that code leaves no rejection unhandled, return the
 * rejecting promise from a plain function and count the calls with a separate
 * spy.
 */
export async function unhandledRejectionsDuring(run: () => unknown): Promise<unknown[]> {
  const reasons: unknown[] = []
  const record = (reason: unknown) => {
    reasons.push(reason)
  }
  globalThis.process.on('unhandledRejection', record)
  try {
    await run()
    await nextTurn()
    await nextTurn()
  } finally {
    globalThis.process.off('unhandledRejection', record)
  }
  return reasons
}
