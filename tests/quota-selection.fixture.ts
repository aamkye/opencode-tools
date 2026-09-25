import { createStore } from "solid-js/store"
import type { Plugin } from "@opencode/plugin/tui"
import type { ModelRef, SessionMessageInfo, SessionModelSelected } from "@opencode/client"
import { createQuotaSelection } from "../tui/features/quota.js"
import type { QuotaProviderAdapter } from "../tui/providers/types.js"

const owners = new WeakMap<Plugin.Context, (cleanup: () => void) => void>()
export function createQuotaSelectionHost(input: {
  provider: readonly { id: string }[]
  messages: Record<string, readonly SessionMessageInfo[]>
  models?: Record<string, ModelRef>
  disposeRegistrationError?: Error
}) {
  const messages = { ...input.messages }
  const [state, setState] = createStore({ provider: [...input.provider], unreadableMessages: false, models: input.models ?? {} })
  const listeners = new Set<(event: SessionModelSelected) => void>()
  let cleanups: (() => void)[] = [], disposed = false, messageReads = 0, providerReads = 0
  function onCleanup(cleanup: () => void) {
    if (input.disposeRegistrationError) throw input.disposeRegistrationError
    if (disposed) cleanup()
    else cleanups.push(cleanup)
  }
  const on: Plugin.Context["data"]["on"] = (type, handler) => {
    if (type !== "session.model.selected") throw new Error(`Unexpected event: ${type}`)
    const listener = handler as (event: SessionModelSelected) => void
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }
  const api = {
    location: { directory: "/remote" },
    data: {
      on,
      location: { provider: { list: () => { providerReads++; return state.provider } } },
      session: {
        get: (id: string) => state.models[id] ? { model: state.models[id] } : undefined,
        message: { list: (id: string) => {
          messageReads++
          if (state.unreadableMessages) throw new Error("messages unavailable")
          return messages[id] ?? []
        } },
      },
    },
  } as unknown as Plugin.Context
  owners.set(api, onCleanup)
  return {
    api, onCleanup,
    eventListenerCount: () => listeners.size, lifecycleCount: () => cleanups.length,
    messageReadCount: () => messageReads, providerReadCount: () => providerReads,
    setMessages(id: string, values: readonly SessionMessageInfo[]) { messages[id] = values },
    setProvider(values: readonly { id: string }[]) { setState("provider", [...values]) },
    setUnreadableMessages(value: boolean) { setState("unreadableMessages", value) },
    setModel(id: string, model: ModelRef) { setState("models", id, model) },
    emitModelSelected(sessionID: string, selected?: { model?: ModelRef }) {
      const model = selected?.model ?? messages[sessionID]?.findLast((message) => message.type === "assistant")?.model
      if (!model) return
      const event: SessionModelSelected = {
        type: "session.model.selected", id: "model-event", created: 0,
        durable: { aggregateID: sessionID, seq: 1, version: 1 }, data: { sessionID, model },
      }
      for (const listener of listeners) listener(event)
    },
    async dispose() {
      if (disposed) return
      disposed = true
      for (const cleanup of cleanups.reverse()) cleanup()
      cleanups = []
    },
  }
}

export function mountQuotaSelection(api: Plugin.Context, providers: readonly QuotaProviderAdapter[]) {
  const selection = createQuotaSelection(api, () => providers)
  try { owners.get(api)!(selection.dispose) } catch (error) { selection.dispose(); throw error }
  return {
    ...selection,
    renderSidebar(sessionID: string) {
      selection.setSessionID(sessionID)
      for (const provider of providers) provider.setSessionID(sessionID)
    },
  }
}
