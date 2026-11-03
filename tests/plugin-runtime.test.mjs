import { spawnSync } from "node:child_process"
import assert from "node:assert/strict"
import { dirname, resolve } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { acquireService, defineTuiPlugin } from "../.tmp-test/plugin-runtime.mjs"

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..")

function runPluginRuntimeContractCheck() {
  return spawnSync(
    process.execPath,
    [
      resolve(rootDir, "node_modules/typescript/bin/tsc"),
      "--noEmit",
      "--ignoreConfig",
      "--pretty",
      "false",
      "--strict",
      "--target",
      "ES2022",
      "--module",
      "ESNext",
      "--moduleResolution",
      "bundler",
      "--jsx",
      "preserve",
      "--jsxImportSource",
      "@opentui/solid",
      "--types",
      "node",
      "--skipLibCheck",
      "tests/plugin-runtime-contract.fixture.ts",
    ],
    { cwd: rootDir, encoding: "utf8" },
  )
}

const descriptor = {
  id: "aamkye/opencode-tools-test-runtime",
  key: "quota",
  options: "none",
  outfile: "dist/test-runtime.js",
  source: "tui/test-runtime.ts",
}

async function rejectionOf(operation) {
  try {
    await operation()
    return { rejected: false }
  } catch (error) {
    return { rejected: true, error }
  }
}

test("native setup returns one idempotent LIFO disposer", async () => {
  const calls = []
  const plugin = defineTuiPlugin(descriptor, (scope) => {
    scope.onCleanup(() => { calls.push("first") })
    scope.onCleanup(() => { calls.push("second") })
  })
  const dispose = await plugin.setup({ renderer: {}, options: {} })
  assert.equal(plugin.id, descriptor.id)
  assert.match(descriptor.id, /^aamkye\/opencode-tools-[^/]+$/)
  await dispose()
  await dispose()
  assert.deepEqual(calls, ["second", "first"])
})

test("native setup passes the original context with options to activation", async () => {
  const api = { renderer: {}, options: { enabled: true } }
  let received
  const plugin = defineTuiPlugin(descriptor, (...args) => { received = args })
  const dispose = await plugin.setup(api)
  assert.equal(received.length, 2)
  assert.equal(received[1], api)
  assert.deepEqual(received[1].options, { enabled: true })
  await dispose()
})

test("defineTuiPlugin rolls back registered cleanups and rethrows the activation error", async () => {
  const events = []
  const module = defineTuiPlugin(descriptor, async (context) => {
    context.onCleanup(async () => {
      await Promise.resolve()
      events.push("async cleanup")
    })
    context.onCleanup(() => {
      events.push("cleanup")
      throw new Error("cleanup failed")
    })
    throw new Error("activation failed")
  })

  await assert.rejects(module.setup({ renderer: {}, options: {} }), /activation failed/)
  assert.deepEqual(events, ["cleanup", "async cleanup"])
})

test("native disposer awaits returned and registered async cleanups once under concurrent calls", async () => {
  const events = []
  let finishReturned
  const returnedGate = new Promise((resolve) => { finishReturned = resolve })
  const module = defineTuiPlugin(descriptor, async (context) => {
    context.onCleanup(async () => {
      events.push("registered:start")
      await Promise.resolve()
      events.push("registered:end")
    })
    return async () => {
      events.push("returned:start")
      await returnedGate
      events.push("returned:end")
    }
  })

  const dispose = await module.setup({ renderer: {}, options: {} })
  const first = dispose()
  const second = dispose()
  assert.equal(first, second)
  assert.deepEqual(events, ["returned:start"])
  finishReturned()
  await Promise.all([first, second])
  await dispose()
  assert.deepEqual(events, [
    "returned:start",
    "returned:end",
    "registered:start",
    "registered:end",
  ])
})

test("defineTuiPlugin drains every cleanup and throws the first cleanup failure", async () => {
  const events = []
  const module = defineTuiPlugin(descriptor, async (context) => {
    context.onCleanup(() => {
      events.push("first")
      throw new Error("first cleanup failed")
    })
    context.onCleanup(() => {
      events.push("second")
      throw new Error("second cleanup failed")
    })
  })

  const dispose = await module.setup({ renderer: {}, options: {} })

  await assert.rejects(dispose(), /second cleanup failed/)
  await assert.rejects(dispose(), /second cleanup failed/)
  assert.deepEqual(events, ["second", "first"])
})

test("defineTuiPlugin preserves undefined thrown by activation over cleanup failures", async () => {
  let cleanupCount = 0
  const module = defineTuiPlugin(descriptor, async (context) => {
    context.onCleanup(() => {
      cleanupCount += 1
      throw new Error("cleanup failed")
    })
    throw undefined
  })

  assert.deepEqual(
    await rejectionOf(() => module.setup({ renderer: {}, options: {} })),
    { rejected: true, error: undefined },
  )
  assert.equal(cleanupCount, 1)
})

test("native disposer preserves undefined as the first cleanup failure", async () => {
  const events = []
  const module = defineTuiPlugin(descriptor, async (context) => {
    context.onCleanup(() => {
      events.push("later error")
      throw new Error("later cleanup failed")
    })
    context.onCleanup(() => {
      events.push("first undefined")
      throw undefined
    })
  })

  const dispose = await module.setup({ renderer: {}, options: {} })
  assert.deepEqual(
    await rejectionOf(dispose),
    { rejected: true, error: undefined },
  )
  assert.deepEqual(await rejectionOf(dispose), { rejected: true, error: undefined })
  assert.deepEqual(events, ["first undefined", "later error"])
})

test("runtime contracts use the published native definition, context and cleanup types", () => {
  const result = runPluginRuntimeContractCheck()
  assert.equal(result.status, 0, [result.stdout, result.stderr].filter(Boolean).join("\n"))
})

test("acquireService shares different contexts on one renderer and disposes on final release", async () => {
  const renderer = {}
  const apiA = { renderer, options: {} }
  const apiB = { renderer, options: {} }
  const apiC = { renderer: {}, options: {} }
  const key = Symbol("shared-service")
  let creations = 0
  let disposals = 0

  const factory = () => ({
    id: ++creations,
    dispose() {
      disposals += 1
    },
  })

  const first = acquireService(apiA, key, factory)
  const second = acquireService(apiB, key, factory)
  const otherRenderer = acquireService(apiC, key, factory)

  assert.equal(first.value, second.value)
  assert.notEqual(first.value, otherRenderer.value)
  assert.equal(creations, 2)

  await first.release()
  await first.release()
  assert.equal(disposals, 0)

  await second.release()
  assert.equal(disposals, 1)

  await second.release()
  assert.equal(disposals, 1)

  await otherRenderer.release()
  assert.equal(disposals, 2)
})

test("acquireService retries failed factory calls and replaces services during reentrant disposal", async () => {
  const api = { renderer: {}, options: {} }
  const retryKey = Symbol("retry-service")
  const reentrantKey = Symbol("reentrant-service")
  let retryAttempts = 0

  assert.throws(() => acquireService(api, retryKey, () => {
    retryAttempts += 1
    throw new Error(`factory failed ${retryAttempts}`)
  }), /factory failed 1/)

  const retried = acquireService(api, retryKey, () => ({
    id: ++retryAttempts,
    dispose() {},
  }))
  assert.equal(retryAttempts, 2)
  assert.equal(retried.value.id, 2)
  await retried.release()

  let creations = 0
  let disposals = 0
  let reentrantLease
  const factory = () => {
    const id = ++creations
    return {
      id,
      dispose() {
        disposals += 1
        if (id === 1) reentrantLease = acquireService(api, reentrantKey, factory)
      },
    }
  }

  const original = acquireService(api, reentrantKey, factory)
  await original.release()

  assert.equal(disposals, 1)
  assert.equal(creations, 2)
  assert.ok(reentrantLease)
  assert.notEqual(reentrantLease.value, original.value)
  assert.equal(reentrantLease.value.id, 2)

  await reentrantLease.release()
  assert.equal(disposals, 2)
})

test("defineTuiPlugin activation context releases acquired service leases on cleanup", async () => {
  const key = Symbol("context-service")
  let creations = 0
  let disposals = 0
  let firstLeaseValue
  let secondLeaseValue

  const module = defineTuiPlugin(descriptor, async (context) => {
    const first = context.acquireService(key, () => ({
      id: ++creations,
      dispose() {
        disposals += 1
      },
    }))
    const second = context.acquireService(key, () => ({
      id: ++creations,
      dispose() {
        disposals += 1
      },
    }))
    firstLeaseValue = first.value
    secondLeaseValue = second.value
  })

  const dispose = await module.setup({ renderer: {}, options: {} })

  assert.equal(creations, 1)
  assert.equal(firstLeaseValue, secondLeaseValue)
  assert.equal(disposals, 0)

  await dispose()
  assert.equal(disposals, 1)
})

test("activation rollback releases its lease without disposing another plugin's shared service", async () => {
  const renderer = {}
  const key = Symbol("shared-rollback")
  let creations = 0
  let disposals = 0
  const factory = () => ({
    id: ++creations,
    dispose() { disposals += 1 },
  })
  const active = defineTuiPlugin(descriptor, (scope) => {
    scope.acquireService(key, factory)
  })
  const failed = defineTuiPlugin(descriptor, (scope) => {
    scope.acquireService(key, factory)
    throw new Error("activation failed")
  })

  const dispose = await active.setup({ renderer, options: {} })
  await assert.rejects(failed.setup({ renderer, options: {} }), /activation failed/)
  assert.equal(creations, 1)
  assert.equal(disposals, 0)
  await dispose()
  assert.equal(disposals, 1)
})

test("defineTuiPlugin activation context replaces reentrant services during cleanup", async () => {
  const key = Symbol("context-reentrant-service")
  let creations = 0
  let disposals = 0
  let firstValue
  let replacementValue

  const module = defineTuiPlugin(descriptor, async (context) => {
    const factory = () => {
      const id = ++creations
      return {
        id,
        dispose() {
          disposals += 1
          if (id === 1) replacementValue = context.acquireService(key, factory).value
        },
      }
    }

    firstValue = context.acquireService(key, factory).value
  })

  const dispose = await module.setup({ renderer: {}, options: {} })
  await dispose()

  assert.equal(creations, 2)
  assert.equal(disposals, 2)
  assert.notEqual(replacementValue, firstValue)
  assert.equal(replacementValue.id, 2)
})
