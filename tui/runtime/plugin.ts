import { Plugin } from "@opencode/plugin/tui"

import type { PluginManifestEntry } from "./manifest.js"

type FeatureCleanup = Plugin.Cleanup

export type ServiceKey = PropertyKey
export type ServiceValue<T> = T extends object | FeatureCleanup ? T & { dispose?: FeatureCleanup } : T
export type ServiceFactory<T> = () => ServiceValue<T>
export type ServiceLease<T> = {
  value: ServiceValue<T>
  release(): void | Promise<void>
}

type ServiceRecord<T> = {
  value: ServiceValue<T>
  references: number
  dispose?: FeatureCleanup
}

const rendererServices = new WeakMap<Plugin.Context["renderer"], Map<ServiceKey, ServiceRecord<unknown>>>()

function serviceDisposeOf(value: unknown): FeatureCleanup | undefined {
  if ((!value || typeof value !== "object") && typeof value !== "function") return undefined
  const dispose = (value as { dispose?: unknown }).dispose
  return typeof dispose === "function" ? dispose.bind(value) : undefined
}

// Location-dependent services include directory/workspace in their key.
export function acquireService<T>(
  api: Plugin.Context,
  key: ServiceKey,
  factory: ServiceFactory<T>,
): ServiceLease<T> {
  const renderer = api.renderer
  let services = rendererServices.get(renderer)
  let record = services?.get(key) as ServiceRecord<T> | undefined

  if (!record) {
    const value = factory()
    record = { value, references: 0, dispose: serviceDisposeOf(value) }
    services ??= new Map()
    services.set(key, record)
    rendererServices.set(renderer, services)
  }

  record.references += 1
  let released = false

  return {
    value: record.value,
    async release() {
      if (released) return
      released = true
      const activeServices = rendererServices.get(renderer)
      if (!activeServices || activeServices.get(key) !== record) return
      record.references -= 1
      if (record.references > 0) return
      activeServices.delete(key)
      if (activeServices.size === 0) rendererServices.delete(renderer)
      await record.dispose?.()
    },
  }
}

export type TuiFeatureContext = {
  onCleanup(cleanup: FeatureCleanup): FeatureCleanup
  acquireService<T>(key: ServiceKey, factory: ServiceFactory<T>): ServiceLease<T>
}

export type FeatureActivation = (
  scope: TuiFeatureContext,
  api: Plugin.Context,
) => void | Plugin.Cleanup | Promise<void | Plugin.Cleanup>

export function defineTuiPlugin(
  descriptor: PluginManifestEntry,
  activate: FeatureActivation,
): Plugin.Definition {
  return Plugin.define({
    id: descriptor.id,
    async setup(api) {
      const cleanups: Plugin.Cleanup[] = []
      const scope: TuiFeatureContext = {
        onCleanup(cleanup) {
          cleanups.push(cleanup)
          return cleanup
        },
        acquireService(key, factory) {
          const lease = acquireService(api, key, factory)
          cleanups.push(lease.release)
          return lease
        },
      }

      let cleanupPromise: Promise<void> | undefined
      const cleanup = () => cleanupPromise ??= (async () => {
        let failed = false
        let firstError: unknown
        while (cleanups.length) {
          try {
            await cleanups.pop()!()
          } catch (error) {
            if (!failed) {
              failed = true
              firstError = error
            }
          }
        }
        if (failed) throw firstError
      })()

      try {
        const returnedCleanup = await activate(scope, api)
        if (returnedCleanup) scope.onCleanup(returnedCleanup)
        return cleanup
      } catch (error) {
        try {
          await cleanup()
        } catch {
          // Preserve the activation error over any rollback failure.
        }
        throw error
      }
    },
  })
}
