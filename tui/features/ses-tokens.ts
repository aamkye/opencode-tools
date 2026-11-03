import type { SessionMessageAssistant, SessionMessageInfo } from "@opencode/client"

import { formatCount } from "../presentation/format.js"
import type { PanelTextSegment } from "../presentation/types.js"
import type { SessionTreeSnapshot } from "../services/session-tree-snapshot.js"

export type SesTokensMessage = Pick<SessionMessageInfo, "type"> & Pick<SessionMessageAssistant, "tokens">

export type SesTokenTotals = {
  turns: number
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}

export type SesTokensPanelModel = {
  turns: string
  input: string
  output: string
  reasoning: string
  cacheRead: string
  cacheWrite: string
  cacheRatio: string
  total: string
  summary: readonly PanelTextSegment[]
}

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function sumMessages(messages: readonly SesTokensMessage[]): SesTokenTotals {
  const totals: SesTokenTotals = { turns: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
  for (const message of messages) {
    if (message.type !== "assistant") continue
    totals.turns += 1
    totals.input += finite(message.tokens?.input)
    totals.output += finite(message.tokens?.output)
    totals.reasoning += finite(message.tokens?.reasoning)
    totals.cacheRead += finite(message.tokens?.cache?.read)
    totals.cacheWrite += finite(message.tokens?.cache?.write)
  }
  return totals
}

function formatTotals(totals: SesTokenTotals): SesTokensPanelModel {
  const denominator = totals.input + totals.cacheWrite
  const cacheRatio = denominator > 0
    ? `${(totals.cacheRead / denominator).toFixed(1)}×`
    : totals.cacheRead > 0 ? "∞" : "-"
  const turns = formatCount(totals.turns)
  const total = formatCount(totals.input + totals.output + totals.reasoning + totals.cacheRead + totals.cacheWrite)
  return {
    turns,
    input: formatCount(totals.input),
    output: formatCount(totals.output),
    reasoning: formatCount(totals.reasoning),
    cacheRead: formatCount(totals.cacheRead),
    cacheWrite: formatCount(totals.cacheWrite),
    cacheRatio,
    total,
    summary: [{ text: total }],
  }
}

export function createSesTokensPanelModel(messages: readonly SesTokensMessage[]): SesTokensPanelModel {
  return formatTotals(sumMessages(messages))
}

/** Snapshot histories are immutable; replaced or removed arrays are collectible. */
export function createSesTokensModelCache(): (snapshot: SessionTreeSnapshot) => SesTokensPanelModel {
  const histories = new WeakMap<readonly SesTokensMessage[], SesTokenTotals>()
  const models = new WeakMap<SessionTreeSnapshot, SesTokensPanelModel>()
  return (snapshot) => {
    const cached = models.get(snapshot)
    if (cached) return cached
    const totals: SesTokenTotals = { turns: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
    const batches = snapshot.messagesBySession
      ? snapshot.sessionIDs.map((id) => snapshot.messagesBySession!.get(id) ?? [])
      : [snapshot.messages]
    for (const messages of batches) {
      let subtotal = histories.get(messages)
      if (!subtotal) {
        subtotal = sumMessages(messages)
        histories.set(messages, subtotal)
      }
      totals.turns += subtotal.turns
      totals.input += subtotal.input
      totals.output += subtotal.output
      totals.reasoning += subtotal.reasoning
      totals.cacheRead += subtotal.cacheRead
      totals.cacheWrite += subtotal.cacheWrite
    }
    const model = formatTotals(totals)
    models.set(snapshot, model)
    return model
  }
}
