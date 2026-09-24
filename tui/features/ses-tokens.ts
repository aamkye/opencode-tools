import type { SessionMessageAssistant, SessionMessageInfo } from "@opencode/client"

import { formatCount } from "../presentation/format.js"
import type { PanelTextSegment } from "../presentation/types.js"

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

export function createSesTokensPanelModel(messages: readonly SesTokensMessage[]): SesTokensPanelModel {
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
