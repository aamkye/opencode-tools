import {
  parseQuotaBetweenArgs,
  startOfLocalDayMs,
  startOfNextLocalDayMs,
} from "./command-parsing";
import {
  getTokenReportCommandSpec,
  type TokenReportCommandId,
} from "./token-commands";
import {
  SessionNotFoundError,
  type AggregateResult,
  type SessionTreeNode,
} from "./quota-stats";
import type { UsageQuery } from "./usage-source.js";

export type TokenReportData =
  | {
      kind: "report";
      title: string;
      result: AggregateResult;
      topModels?: number;
      topSessions?: number;
      focusSessionID: string;
      sessionOnly?: boolean;
      reportKind?: "standard" | "session" | "session_tree";
      sessionTree?: { rootSessionID: string; nodes: SessionTreeNode[] };
      generatedAtMs: number;
    }
  | {
      kind: "invalid_arguments";
      command: "tokens_between";
      error: string;
    }
  | {
      kind: "session_lookup_error";
      command: string;
      generatedAtMs: number;
      sessionID: string;
      message: string;
    }
  | {
      kind: "unknown_command";
      command: string;
    };

export type ComputeTokenReportParams = {
  command: TokenReportCommandId;
  arguments?: string;
  sessionID?: string;
  generatedAtMs?: number;
};

export type ComputeTokenReportDependencies = {
  aggregateUsage(params: UsageQuery): Promise<AggregateResult>;
  resolveSessionTree(sessionID: string): Promise<SessionTreeNode[]>;
};

function sessionLookupError(
  command: string,
  generatedAtMs: number,
  error: SessionNotFoundError,
): TokenReportData {
  return {
    kind: "session_lookup_error",
    command,
    generatedAtMs,
    sessionID: error.sessionID,
    message: error.message,
  };
}

async function computeUsageReport(params: {
  title: string;
  sinceMs?: number;
  untilMs?: number;
  sessionID: string;
  topModels?: number;
  topSessions?: number;
  filterSessionID?: string;
  filterSessionIDs?: string[];
  sessionOnly?: boolean;
  reportKind?: "standard" | "session" | "session_tree";
  sessionTree?: { rootSessionID: string; nodes: SessionTreeNode[] };
  generatedAtMs: number;
}, dependencies: ComputeTokenReportDependencies): Promise<TokenReportData> {
  const result = await dependencies.aggregateUsage({
    sinceMs: params.sinceMs,
    untilMs: params.untilMs,
    sessionID: params.filterSessionID,
    sessionIDs: params.filterSessionIDs,
  });
  return {
    kind: "report",
    title: params.title,
    result,
    topModels: params.topModels,
    topSessions: params.topSessions,
    focusSessionID: params.sessionID,
    sessionOnly: params.sessionOnly,
    reportKind: params.reportKind,
    sessionTree: params.sessionTree,
    generatedAtMs: params.generatedAtMs,
  };
}

export async function computeTokenReport(
  params: ComputeTokenReportParams,
  dependencies: ComputeTokenReportDependencies,
): Promise<TokenReportData> {
  const spec = getTokenReportCommandSpec(params.command);
  if (!spec) return { kind: "unknown_command", command: params.command };

  const sessionID = params.sessionID;
  const untilMs = params.generatedAtMs ?? Date.now();
  if (!sessionID && (spec.kind === "session" || spec.kind === "session_tree")) {
    return sessionLookupError(
      spec.template,
      untilMs,
      new SessionNotFoundError("(none)"),
    );
  }

  try {
    if (spec.kind === "between") {
      const parsed = parseQuotaBetweenArgs(params.arguments);
      if (!parsed.ok) {
        return { kind: "invalid_arguments", command: spec.id, error: parsed.error };
      }
      return await computeUsageReport({
        title: spec.titleForRange(parsed.startYmd, parsed.endYmd),
        sinceMs: startOfLocalDayMs(parsed.startYmd),
        untilMs: startOfNextLocalDayMs(parsed.endYmd),
        sessionID: sessionID ?? "",
        generatedAtMs: untilMs,
      }, dependencies);
    }

    let sinceMs: number | undefined;
    let filterSessionID: string | undefined;
    let filterSessionIDs: string[] | undefined;
    let sessionOnly: boolean | undefined;
    let topModels: number | undefined;
    let topSessions: number | undefined;
    let reportKind: "standard" | "session" | "session_tree" | undefined;
    let sessionTree: { rootSessionID: string; nodes: SessionTreeNode[] } | undefined;

    switch (spec.kind) {
      case "rolling":
        sinceMs = untilMs - spec.windowMs!;
        break;
      case "today": {
        const now = new Date(untilMs);
        sinceMs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        break;
      }
      case "session":
        filterSessionID = sessionID;
        sessionOnly = true;
        reportKind = "session";
        break;
      case "session_tree": {
        const nodes = await dependencies.resolveSessionTree(sessionID!);
        filterSessionIDs = nodes.map((node) => node.sessionID);
        reportKind = "session_tree";
        sessionTree = { rootSessionID: sessionID!, nodes };
        break;
      }
      case "all":
        topModels = spec.topModels;
        topSessions = spec.topSessions;
        break;
    }

    return await computeUsageReport({
      title: spec.title,
      sinceMs,
      untilMs: spec.kind === "rolling" || spec.kind === "today" ? untilMs : undefined,
      sessionID: sessionID ?? "",
      filterSessionID,
      filterSessionIDs,
      sessionOnly,
      reportKind,
      sessionTree,
      topModels,
      topSessions,
      generatedAtMs: untilMs,
    }, dependencies);
  } catch (error) {
    if (error instanceof SessionNotFoundError) {
      return sessionLookupError(spec.template, untilMs, error);
    }
    throw error;
  }
}
