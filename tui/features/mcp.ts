import type { McpServer } from "@opencode/client"

import type { PanelStatus, PanelTextSegment } from "../presentation/types.js"

export type McpStatusRow = {
  name: string
  label: string
  status: PanelStatus
}

export type McpPanelModel = {
  rows: readonly McpStatusRow[]
  connected: number
  warning: number
  error: number
  total: number
  summary: readonly PanelTextSegment[]
}

type McpStatusDisplay = Pick<McpStatusRow, "label" | "status">

const STATUS_DISPLAY = Object.freeze({
  connected: { label: "Connected", status: "success" },
  pending: { label: "Pending", status: "warning" },
  disabled: { label: "Disabled", status: "textMuted" },
  failed: { label: "Failed", status: "error" },
  needs_auth: { label: "Needs auth", status: "error" },
} satisfies Record<string, McpStatusDisplay>)

const UNKNOWN_STATUS = Object.freeze({ label: "Unknown", status: "textMuted" } satisfies McpStatusDisplay)

function bucket(status: string): "success" | "warning" | "error" {
  if (status === "connected") return "success"
  if (status === "pending" || status === "disabled") return "warning"
  return "error"
}

export function createMcpPanelModel(entries: readonly McpServer[]): McpPanelModel {
  let connected = 0
  let warning = 0
  let error = 0
  const rows = entries.map((entry): McpStatusRow => {
    const status = entry.status.status
    const bucketStatus = bucket(status)
    if (bucketStatus === "success") connected += 1
    else if (bucketStatus === "warning") warning += 1
    else error += 1
    const display = Object.hasOwn(STATUS_DISPLAY, status)
      ? STATUS_DISPLAY[status]
      : UNKNOWN_STATUS
    return { name: entry.name, ...display }
  })
  const total = entries.length

  return {
    rows,
    connected,
    warning,
    error,
    total,
    summary: [
      { text: String(connected), status: "success" },
      { text: "/", status: "textMuted" },
      { text: String(warning), status: "warning" },
      { text: "/", status: "textMuted" },
      { text: String(error), status: "error" },
    ],
  }
}
