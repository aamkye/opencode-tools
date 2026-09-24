import { renderCommandHeading } from "./format-utils";
import { formatQuotaStatsReport } from "./quota-stats-format";
import type { TokenReportData } from "./token-report-data";

const TUI_TOKEN_REPORT_MODEL_MAX_WIDTH = 25;

export function renderTokenReport(data: TokenReportData): string {
  switch (data.kind) {
    case "unknown_command":
      return `Unknown command: ${data.command}`;
    case "invalid_arguments":
      return `Invalid arguments for /${data.command}\n\n${data.error}\n\nExpected: /${data.command} YYYY-MM-DD YYYY-MM-DD\nExample: /${data.command} 2026-01-01 2026-01-15`;
    case "session_lookup_error":
      return [
        renderCommandHeading({
          title: `Token report unavailable (${data.command})`,
          generatedAtMs: data.generatedAtMs,
        }),
        "",
        "session_lookup_error:",
        `- session_id: ${data.sessionID}`,
        `- error: ${data.message}`,
      ].join("\n");
    case "report":
      return formatQuotaStatsReport({
        title: data.title,
        result: data.result,
        topModels: data.topModels,
        topSessions: data.topSessions,
        focusSessionID: data.focusSessionID,
        sessionOnly: data.sessionOnly,
        reportKind: data.reportKind,
        sessionTree: data.sessionTree,
        generatedAtMs: data.generatedAtMs,
        tableOptions: {
          compactHeaders: true,
          modelNameMaxWidth: TUI_TOKEN_REPORT_MODEL_MAX_WIDTH,
        },
      });
  }
}
