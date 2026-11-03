import type { ModelInfo, SessionMessageAssistant, SessionMessageInfo } from "@opencode/client"

import { formatCount, formatCurrency } from "../presentation/format.js"
import type { PanelStatus } from "../presentation/types.js"

export type ContextPanelModel = {
  limit: string
  tokens: string
  used: string
  spent: string
  summary: string
  usageStatus?: PanelStatus
  spentStatus?: PanelStatus
}

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function messageTokens(message: SessionMessageAssistant): number {
  const tokens = message.tokens
  if (!tokens) return 0
  return finite(tokens.input)
    + finite(tokens.output)
    + finite(tokens.reasoning)
    + finite(tokens.cache?.read)
    + finite(tokens.cache?.write)
}

export function createContextPanelModel(
  messages: readonly SessionMessageInfo[],
  models: readonly ModelInfo[],
  sessionCost: number | undefined,
): ContextPanelModel {
  const spent = finite(sessionCost)
  let selected: { message: SessionMessageAssistant; tokens: number } | undefined

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.type !== "assistant") continue
    if (!selected) {
      const tokens = messageTokens(message)
      if (tokens > 0) selected = { message, tokens }
    }
  }

  const spentValue = formatCurrency(spent)
  const spentStatus = spent === 0 ? "textMuted" as const : undefined
  const tokens = selected ? formatCount(selected.tokens, 2) : "-"
  const unavailable: ContextPanelModel = {
    limit: "-",
    tokens,
    used: "-",
    spent: spentValue,
    summary: "-",
    ...(spentStatus ? { spentStatus } : {}),
  }
  if (!selected) return unavailable

  const model = models.find((candidate) => candidate.providerID === selected.message.model.providerID
    && candidate.id === selected.message.model.id)
  const limit = model?.limit?.context
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) return unavailable

  const percentage = Math.round((selected.tokens / limit) * 100)
  const used = `${percentage}%`
  const usageStatus: PanelStatus = percentage < 40
    ? "success"
    : percentage <= 60 ? "warning" : "error"
  return {
    limit: formatCount(limit),
    tokens,
    used,
    spent: spentValue,
    summary: used,
    usageStatus,
    ...(spentStatus ? { spentStatus } : {}),
  }
}
