import type { SessionMessageInfo } from "@opencode/client"

import { formatDuration } from "../presentation/format.js"
import type { PanelTextSegment } from "../presentation/types.js"
import type { SubagentChildSnapshot, SubagentSnapshot } from "../services/subagent-snapshot.js"

export type SubagentStatus = "successful" | "running" | "failed"

export type SubagentEntry = {
  id: string
  title: string
  agent: string
  model: string
  status: SubagentStatus
  startedAt: number
  durationMs: number
  duration: string
}

export type SubagentPanelModel = {
  primary: readonly SubagentEntry[]
  rest: readonly SubagentEntry[]
  successful: number
  running: number
  failed: number
  summary: readonly PanelTextSegment[]
}

export type SubagentEntryRowAllocation = {
  disclosure: number
  title: number
  beforeDurationGap: number
  duration: number
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function normalizedCells(value: number): number {
  return Math.max(0, Math.floor(finite(value) ?? 0))
}

function newestMessage<Type extends SessionMessageInfo["type"]>(
  messages: readonly SessionMessageInfo[],
  type: Type,
): Extract<SessionMessageInfo, { type: Type }> | undefined {
  let newest: SessionMessageInfo | undefined
  let newestCreated = Number.NEGATIVE_INFINITY
  for (const message of messages) {
    if (message.type !== type) continue
    const created = finite(message.time?.created) ?? Number.NEGATIVE_INFINITY
    if (!newest || created > newestCreated) {
      newest = message
      newestCreated = created
    }
  }
  return newest as Extract<SessionMessageInfo, { type: Type }> | undefined
}

function identity(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function durationBetween(end: unknown, start: unknown): number {
  const finiteEnd = finite(end)
  const finiteStart = finite(start)
  if (finiteEnd === undefined || finiteStart === undefined) return 0
  return Math.max(0, Math.floor(finiteEnd - finiteStart))
}

export function allocateSubagentEntryRow(
  availableCells: number,
  durationCells: number,
): SubagentEntryRowAllocation {
  const available = normalizedCells(availableCells)
  const requestedDuration = normalizedCells(durationCells)
  const disclosure = Math.min(2, available)
  const remaining = available - disclosure
  const gap = disclosure > 0 && requestedDuration > 0 ? 2 : 0
  const duration = requestedDuration + gap <= remaining ? requestedDuration : 0
  const beforeDurationGap = duration > 0 ? gap : 0
  const title = remaining - beforeDurationGap - duration
  return { disclosure, title, beforeDurationGap, duration }
}

export function subagentEntryDuration(entry: SubagentEntry, now: number): string {
  return entry.status === "running"
    ? formatDuration(durationBetween(now, entry.startedAt), "hours")
    : entry.duration
}

export function createSubagentPanelModel(
  snapshot: SubagentSnapshot,
  failureTimes: Readonly<Record<string, number>>,
  now: number,
): SubagentPanelModel {
  const direct = (snapshot.children
    .filter(({ session }) => session.parentID === snapshot.parentID) as SubagentChildSnapshot[] & {
      toSorted(compareFn: (left: SubagentChildSnapshot, right: SubagentChildSnapshot) => number): SubagentChildSnapshot[]
    })
    .toSorted((left, right) =>
      right.session.time.created - left.session.time.created
        || left.session.id.localeCompare(right.session.id))

  const entries = direct.map(({ session, status: synchronizedStatus, messages }) => {
    const assistant = newestMessage(messages, "assistant")
    const idle = newestMessage(messages, "idle")
    const errorTimes = messages
      .map((message) => message.type === "assistant" && message.error
        ? finite(message.time.completed ?? message.time.created)
        : message.type === "idle" && message.outcome !== "succeeded"
          ? finite(message.time.created)
          : undefined)
      .filter((value): value is number => value !== undefined)
    const hasRetainedFailure = Object.hasOwn(failureTimes, session.id)
    const retainedFailureTime = finite(failureTimes[session.id])
    const hasMessageFailure = messages.some((message) =>
      (message.type === "assistant" && Boolean(message.error))
      || (message.type === "idle" && message.outcome !== "succeeded"))
    const failedOutcome = session.outcome === "failed" || session.outcome === "interrupted"
    const hasFailure = hasRetainedFailure || hasMessageFailure || failedOutcome
    const status: SubagentStatus = hasFailure
      ? "failed"
      : synchronizedStatus === "running"
        ? "running"
        : synchronizedStatus === "idle" || session.outcome === "succeeded" || idle?.outcome === "succeeded"
          ? "successful"
          : assistant?.time.completed !== undefined ? "successful" : "running"
    const failureTime = [retainedFailureTime, ...errorTimes, ...(failedOutcome ? [finite(session.time.idle)] : [])]
      .filter((value): value is number => value !== undefined)
      .reduce<number | undefined>((earliest, value) => earliest === undefined ? value : Math.min(earliest, value), undefined)
    const durationMs = status === "successful"
      ? durationBetween(session.time.idle ?? idle?.time.created ?? assistant?.time.completed, session.time.created)
      : status === "failed"
        ? durationBetween(failureTime ?? (failedOutcome ? assistant?.time.completed : undefined), session.time.created)
        : durationBetween(now, session.time.created)

    return {
      id: session.id,
      title: session.title ?? session.id,
      agent: identity(session.agent) ?? identity(assistant?.agent) ?? "-",
      model: identity(session.model?.id) ?? identity(assistant?.model?.id) ?? "-",
      status,
      startedAt: session.time.created,
      durationMs,
      duration: formatDuration(durationMs, "hours"),
    }
  })
  const successful = entries.filter(({ status }) => status === "successful").length
  const running = entries.filter(({ status }) => status === "running").length
  const failed = entries.filter(({ status }) => status === "failed").length

  return {
    primary: entries.slice(0, 5),
    rest: entries.slice(5),
    successful,
    running,
    failed,
    summary: [
      { text: String(successful), status: "success" },
      { text: "/", status: "textMuted" },
      { text: String(running), status: "warning" },
      { text: "/", status: "textMuted" },
      { text: String(failed), status: "error" },
    ],
  }
}
