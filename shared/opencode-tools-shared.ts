import { createOpenAiProvider } from "../tui/providers/openai.js";
import {
  composeQuotaPanel,
  createQuotaSelection,
  normalizeQuotaOptions,
  quotaProviderDemand,
  selectedQuotaProviderID,
  selectedSessionQuotaProviderID,
} from "../tui/features/quota.js";
import { createOpenCodeGoProvider } from "../tui/providers/opencode-go.js";
import { createZaiProvider } from "../tui/providers/zai.js";

export { CompactPanel, CompactStatusRow, StatusChip } from "../tui/presentation/compact-panel.js";
export type {
  CompactPanelProps,
  CompactPanelSummary,
  CompactStatusRowProps,
  StatusChipProps,
  PanelTheme,
} from "../tui/presentation/compact-panel.js";
export type { PanelStatus } from "../tui/presentation/types.js";
export { allocateStatusRow, PANEL_MAX_CELLS } from "../tui/presentation/layout.js";
export type { StatusRowAllocation } from "../tui/presentation/layout.js";
export { createMcpPanelModel } from "../tui/features/mcp.js";
export type { McpPanelModel, McpStatusRow } from "../tui/features/mcp.js";
export { createContextPanelModel } from "../tui/features/context.js";
export type { ContextPanelModel } from "../tui/features/context.js";
export { createSesTokensPanelModel } from "../tui/features/ses-tokens.js";
export type { SesTokenTotals, SesTokensMessage, SesTokensPanelModel } from "../tui/features/ses-tokens.js";
export { allocateSubagentEntryRow, createSubagentPanelModel, subagentEntryDuration } from "../tui/features/subagent.js";
export type {
  SubagentEntry,
  SubagentEntryRowAllocation,
  SubagentPanelModel,
  SubagentStatus,
} from "../tui/features/subagent.js";
export { createSubagentSnapshotLoader } from "../tui/services/subagent-snapshot.js";
export type {
  CreateSubagentSnapshotLoaderOptions,
  SubagentChildSnapshot,
  SubagentSnapshot,
  SubagentSnapshotLoadContext,
  SubagentSnapshotLoader,
} from "../tui/services/subagent-snapshot.js";
export { createSubagentSource } from "../tui/services/subagent-source.js";
export type {
  RetainedFailures,
  SubagentEventRegistrar,
  SubagentRefreshEvent,
  SubagentSource,
  SubagentSourceDependencies,
  SubagentSourceState,
} from "../tui/services/subagent-source.js";
export {
  collectSessionTreeIDs,
  createSessionTreeSnapshotLoader,
  indexSessionsByParent,
  loadSessionTreeSnapshot,
} from "../tui/services/session-tree-snapshot.js";
export type {
  CreateSessionTreeSnapshotLoaderOptions,
  LoadSessionTreeSnapshotOptions,
  SessionTreeRecord,
  SessionTreeSnapshot,
  SessionTreeSnapshotLoadContext,
  SessionTreeSnapshotLoader,
} from "../tui/services/session-tree-snapshot.js";
export { createSesTokensSource } from "../tui/services/ses-tokens-source.js";
export { createSessionSourcePool } from "../tui/services/session-source-pool.js";
export type {
  SesTokensEventRegistrar,
  SesTokensRefreshEvent,
  SesTokensSource,
  SesTokensSourceDependencies,
  SesTokensSourceState,
} from "../tui/services/ses-tokens-source.js";
export { createOpenAiProvider };
export {
  acquireQuotaProviderHub,
  createQuotaProviderHub,
} from "../tui/services/quota-provider-hub.js";
export {
  createOpenCodeGoProvider,
  mapOpenCodeGoPanelState,
  openCodeGoHomeQuotaSummary,
} from "../tui/providers/opencode-go.js";
export type {
  OpenCodeGoConfig,
  OpenCodeGoOptions,
  OpenCodeGoPanelPhase,
  OpenCodeGoPanelState,
  OpenCodeGoProviderOptions,
  OpenCodeGoQuotaData,
  OpenCodeGoWindow,
} from "../tui/providers/opencode-go.js";
export { createZaiProvider };
export type {
  HomeQuotaSummary,
  OpenAiHomeQuotaSummary,
  OpenCodeGoHomeQuotaSummary,
  ProviderFreshness,
  QuotaProviderAdapter,
  ZaiHomeQuotaSummary,
} from "../tui/providers/types.js";
export type {
  QuotaProviderDemand,
  QuotaProviderHub,
} from "../tui/services/quota-provider-hub.js";
export {
  composeQuotaPanel,
  createQuotaSelection,
  normalizeQuotaOptions,
  quotaProviderDemand,
  selectedQuotaProviderID,
  selectedSessionQuotaProviderID,
};
export type {
  NormalizedQuotaOptions,
  PercentageMode,
  ProgressColorOptions,
  QuotaCompositionOptions,
  QuotaPluginOptions,
  QuotaSelection,
  SortDirection,
} from "../tui/features/quota.js";
export {
  formatHomeQuotaLine,
  homeQuotaPercentParts,
  homeQuotaStatusRole,
} from "../tui/features/home.js";

export type QuotaAdapterShared = {
  normalizeOptions: typeof normalizeQuotaOptions;
  composePanel: typeof composeQuotaPanel;
  createSelection: typeof createQuotaSelection;
  quotaProviderDemand: typeof quotaProviderDemand;
  createZaiProvider: typeof createZaiProvider;
  createOpenAiProvider: typeof createOpenAiProvider;
  createOpenCodeGoProvider: typeof createOpenCodeGoProvider;
};

export const quotaAdapterShared: QuotaAdapterShared = {
  normalizeOptions: normalizeQuotaOptions,
  composePanel: composeQuotaPanel,
  createSelection: createQuotaSelection,
  quotaProviderDemand,
  createZaiProvider,
  createOpenAiProvider,
  createOpenCodeGoProvider,
};

export { acquireService, defineTuiPlugin } from "../tui/runtime/plugin.js";
export { panelTheme } from "../tui/runtime/theme.js";
export type { FeatureActivation, ServiceFactory, ServiceKey, ServiceLease, ServiceValue, TuiFeatureContext } from "../tui/runtime/plugin.js";
export { pluginDescriptor, pluginManifest } from "../tui/runtime/manifest.js";
export type { PluginKey, PluginManifestEntry } from "../tui/runtime/manifest.js";
export { resolveCollapseDefault, resolveChipOption } from "../tui/features/collapse-options.js";
export type { PanelCollapseState, ResolvedCollapseDefault, ResolvedChipOption } from "../tui/features/collapse-options.js";
