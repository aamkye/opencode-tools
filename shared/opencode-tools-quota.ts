// Quota transport initializes RPC schemas. Keep it out of non-quota bundles.
export * from "./opencode-tools-shared.js";

import { createOpenAiProvider } from "../tui/providers/openai.js";
import { createOpenCodeGoProvider } from "../tui/providers/opencode-go.js";
import { createZaiProvider } from "../tui/providers/zai.js";
import {
  composeQuotaPanel,
  createQuotaSelection,
  normalizeQuotaOptions,
  quotaProviderDemand,
} from "../tui/features/quota.js";

export { createOpenAiProvider, createOpenCodeGoProvider, createZaiProvider };
export { acquireQuotaProviderHub, createQuotaProviderHub } from "../tui/services/quota-provider-hub.js";
export type { QuotaProviderDemand, QuotaProviderHub } from "../tui/services/quota-provider-hub.js";
export { mapOpenCodeGoPanelState, openCodeGoHomeQuotaSummary } from "../tui/providers/opencode-go.js";
export type {
  OpenCodeGoConfig,
  OpenCodeGoOptions,
  OpenCodeGoPanelPhase,
  OpenCodeGoPanelState,
  OpenCodeGoProviderOptions,
  OpenCodeGoQuotaData,
  OpenCodeGoWindow,
} from "../tui/providers/opencode-go.js";
export { composeQuotaPanel, createQuotaSelection, normalizeQuotaOptions, quotaProviderDemand };
export { selectedQuotaProviderID, selectedSessionQuotaProviderID } from "../tui/features/quota.js";
export type {
  NormalizedQuotaOptions,
  PercentageMode,
  ProgressColorOptions,
  QuotaCompositionOptions,
  QuotaPluginOptions,
  QuotaSelection,
  SortDirection,
} from "../tui/features/quota.js";

export const quotaAdapterShared = {
  normalizeOptions: normalizeQuotaOptions,
  composePanel: composeQuotaPanel,
  createSelection: createQuotaSelection,
  quotaProviderDemand,
  createZaiProvider,
  createOpenAiProvider,
  createOpenCodeGoProvider,
};
export type QuotaAdapterShared = typeof quotaAdapterShared;
