import type { Plugin } from "@opencode/plugin/tui";

import { computeTokenReport, type ComputeTokenReportDependencies } from "../../lib/tokens/token-report-data.js";
import { renderTokenReport } from "../../lib/tokens/token-report-presenter.js";
import type { TokenReportCommandId } from "../../lib/tokens/token-commands.js";

export function activeSessionID(api: Plugin.Context): string | undefined {
  const route = api.ui.router.current();
  return route.type === "session" ? route.sessionID : undefined;
}

export async function persistTokenReport(
  api: Plugin.Context,
  sessionID: string,
  command: TokenReportCommandId,
  dependencies: ComputeTokenReportDependencies,
  argumentsValue?: string,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return;
  let text: string;
  try {
    text = renderTokenReport(await computeTokenReport({
      command,
      arguments: argumentsValue,
      sessionID,
    }, dependencies));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    text = `Token report failed: ${message}`;
  }
  if (signal?.aborted) return;
  try {
    await api.client.session.synthetic({ sessionID, text, resume: false }, { signal });
  } catch {
    if (!signal?.aborted) api.ui.toast.show({ message: "Unable to save token report" });
  }
}
