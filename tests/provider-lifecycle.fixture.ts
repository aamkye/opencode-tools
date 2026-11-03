import type { Plugin } from "@opencode/plugin/tui"
import type { Plugin as ServerPlugin } from "@opencode/plugin"
import type { OpenCodeEvent, SessionMessageInfo } from "@opencode/client"
import { createSignal } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { fetchQuota } from "../quota-service.js"
import { QuotaRpc, type QuotaRequest } from "../shared/quota-rpc.js"
import { createOpenAiProvider } from "../tui/providers/openai.js"
import type { QuotaProviderOptions } from "../tui/providers/types.js"
import { createZaiProvider } from "../tui/providers/zai.js"

export function createNativeQuotaHost(input: {
  openai?: string | null
  zai?: string | null
  messages?: SessionMessageInfo[]
} = {}) {
  const keys = { openai: input.openai ?? null, zai: input.zai ?? null }
  let generation = 0
  const listeners = new Map<string, Set<(event: OpenCodeEvent) => void>>()
  const subscriptions: Array<{ type: string; disposals: number }> = []
  const [messages, setMessages] = createSignal(input.messages ?? [])
  const [location, setLocation] = createSignal({ directory: "/test", workspaceID: "wrk_test" })
  const stored: unknown[] = []
  const rpcCalls: Array<{ input: QuotaRequest; location: unknown; signal: AbortSignal }> = []
  const stores = new Map<string, object>()
  const server = { integration: { connection: {
    active: async (id: string) => (id === "openai" || id === "zai") && keys[id]
      ? { type: "credential", id: `${id}:${generation}`, label: id, method: id === "openai" ? "oauth" : "key" } : undefined,
    resolve: async (connection: { id: string }) => connection.id.startsWith("openai:")
      ? { type: "oauth", methodID: "oauth", access: keys.openai, refresh: "refresh-test", expires: Date.now() + 3600000 }
      : { type: "key", key: keys.zai },
  } } } as unknown as Pick<ServerPlugin.Context, "integration">
  const api = {
    renderer: {}, options: {},
    get location() { return location() },
    client: { rpc: (contract: typeof QuotaRpc) => {
      if (contract.id !== QuotaRpc.id) throw new Error("Unexpected RPC contract")
      return { fetch: (request: QuotaRequest, options: { signal: AbortSignal; location: unknown }) => {
        rpcCalls.push({ input: request, ...options })
        return fetchQuota(server, request, options.signal)
      } }
    } },
    data: {
      on(type: string, handler: (event: OpenCodeEvent) => void) {
        const subscription = { type, disposals: 0 }
        subscriptions.push(subscription)
        const set = listeners.get(type) ?? new Set()
        listeners.set(type, set)
        set.add(handler)
        return () => { subscription.disposals++; set.delete(handler) }
      },
      session: { get: () => undefined, message: { list: messages } },
      location: { default: location, provider: { list: () => [{ id: "zai-coding-plan" }, { id: "openai" }] } },
    },
    storage: {
      store<T extends object>(key: string, options: { initial: T }) {
        const [state, setState] = createStore<T>((stores.get(key) ?? options.initial) as T)
        stores.set(key, state)
        return [state, async (mutation: (draft: T) => void) => {
          setState(produce(mutation))
          stored.push(structuredClone(JSON.parse(JSON.stringify(state))))
        }] as const
      },
    },
  } as unknown as Plugin.Context
  function emit(type: string, data: object = {}, eventLocation = location()) {
    for (const handler of listeners.get(type) ?? []) handler({ type, id: "test-event", created: Date.now(), data, location: eventLocation } as OpenCodeEvent)
  }
  return {
    api, stored, rpcCalls, setMessages, setLocation, emit, subscriptions,
    listenerCount: () => [...listeners.values()].reduce((sum, value) => sum + value.size, 0),
    setCredential(provider: keyof typeof keys, key: string | null) {
      keys[provider] = key
      generation += 1
      emit("credential.switched", { integrationID: provider, credentialID: key ? `${provider}:${generation}` : null })
    },
  }
}

export function createReactiveOpenAiAdapter(initialKey: string | null, options: QuotaProviderOptions = {}) {
  const host = createNativeQuotaHost({ openai: initialKey })
  return { adapter: createOpenAiProvider(host.api, options), setCredential: (key: string | null) => host.setCredential("openai", key), host }
}

export function createReactiveZaiAdapter(initialKey: string | null, options: QuotaProviderOptions = {}) {
  const host = createNativeQuotaHost({ zai: initialKey })
  return { adapter: createZaiProvider(host.api, options), setCredential: (key: string | null) => host.setCredential("zai", key), host }
}

export function createReactiveZaiRetryAdapter(initialKey: string, retryText: string) {
  const host = createNativeQuotaHost({ zai: initialKey, messages: [{
    type: "assistant", id: "retry-message", time: { created: 0 }, agent: "build",
    model: { providerID: "zai-coding-plan", id: "glm" }, content: [{ type: "text", text: retryText }],
  }] })
  return { adapter: createZaiProvider(host.api), setCredential: (key: string) => host.setCredential("zai", key) }
}
