import type { SessionInfo } from "@opencode/client";
import { SessionNotFoundError, type UsageQuery, type UsageSource } from "./usage-source.js";
import {
  hasCost,
  hasProvider,
  hasModel,
  isModelsDevProviderId,
  listProvidersForModelId,
  lookupCost,
} from "./modelsdev-pricing";
import {
  isCursorModelId,
  isCursorProviderId,
  lookupCursorLocalCost,
  resolveCursorModel,
} from "./cursor-pricing";
import { calculateUsdFromTokenBuckets } from "./token-cost";
import {
  addTokenBuckets,
  emptyTokenBuckets,
  tokenBucketsFromMessage,
} from "./token-buckets";
import type { TokenBuckets } from "./token-buckets";

export { SessionNotFoundError } from "./usage-source.js";
export type { TokenBuckets } from "./token-buckets";

export type PricedKey = {
  provider: string;
  model: string;
};

export type UnknownKey = {
  sourceProviderID: string;
  sourceModelID: string;
  mappedProvider?: string;
  mappedModel?: string;
  normalizedModelID?: string;
  providerCandidates?: string[];
  reason?: "missing_model" | "missing_provider" | "ambiguous_model";
};

export type PricingResolution =
  | {
      ok: true;
      key: PricedKey;
      method:
        | "source_provider"
        | "model_prefix"
        | "unique_model"
        | "alias_fallback"
        | "cursor_local"
        | "cursor_api_alias";
    }
  | { ok: false; unknown: UnknownKey };

export type AggregateRow = {
  key: PricedKey;
  tokens: TokenBuckets;
  costUsd: number;
  messageCount: number;
};

export type SessionRow = {
  sessionID: string;
  title?: string;
  tokens: TokenBuckets;
  costUsd: number;
  messageCount: number;
};

export type SourceProviderRow = {
  providerID: string;
  tokens: TokenBuckets;
  costUsd: number;
  messageCount: number;
};

export type SourceModelRow = {
  sourceProviderID: string;
  sourceModelID: string;
  tokens: TokenBuckets;
  costUsd: number;
  messageCount: number;
};

export type UnknownRow = {
  key: UnknownKey;
  tokens: TokenBuckets;
  messageCount: number;
};

export type UnpricedKey = {
  sourceProviderID: string;
  sourceModelID: string;
  mappedProvider: string;
  mappedModel: string;
  reason: string;
};

export type UnpricedRow = {
  key: UnpricedKey;
  tokens: TokenBuckets;
  messageCount: number;
};

export type SessionTreeNode = {
  sessionID: string;
  parentID?: string;
  title?: string;
  depth: number;
};

export type AggregateResult = {
  window: { sinceMs?: number; untilMs?: number };
  totals: {
    priced: TokenBuckets;
    unknown: TokenBuckets;
    unpriced: TokenBuckets;
    costUsd: number;
    messageCount: number;
    sessionCount: number;
  };
  bySourceProvider: SourceProviderRow[];
  bySourceModel: SourceModelRow[];
  byModel: AggregateRow[];
  bySession: SessionRow[];
  unknown: UnknownRow[];
  unpriced: UnpricedRow[];
};

function normalizeModelId(raw: string): string {
  let s = raw.trim();
  if (s.toLowerCase().startsWith("antigravity-")) s = s.slice("antigravity-".length);
  s = s.replace(/(claude-[a-z-]+)-(\d+)\.(\d+)(?=$|[^0-9])/gi, "$1-$2-$3");
  s = s.replace(/\bglm-(\d+)\.(\d+)-free\b/i, "glm-$1.$2");
  if (s.toLowerCase() === "big-pickle") s = "glm-4.7";
  return s;
}

function stripFreeSuffix(modelId: string): string | null {
  if (!modelId.toLowerCase().endsWith("-free")) return null;
  const stripped = modelId.slice(0, -"-free".length);
  return stripped || null;
}

function freeSuffixCandidates(modelId: string): string[] {
  const candidates = [modelId];
  const stripped = stripFreeSuffix(modelId);
  if (stripped) candidates.push(stripped);
  return candidates.filter((value, index, list) => list.indexOf(value) === index);
}

function pickBestModelForProvider(providerID: string, candidates: readonly string[]): string | null {
  for (const candidate of candidates) {
    if (hasCost(providerID, candidate)) return candidate;
  }
  for (const candidate of candidates) {
    if (hasModel(providerID, candidate)) return candidate;
  }
  return null;
}

function parseModelIdHint(rawModelId?: string): { providerHint?: string; modelPart?: string } {
  if (!rawModelId || typeof rawModelId !== "string") return {};
  const trimmed = rawModelId.trim();
  if (!trimmed) return {};
  const lastSlash = trimmed.lastIndexOf("/");
  if (lastSlash === -1) return { modelPart: trimmed };
  if (lastSlash === trimmed.length - 1) return { providerHint: trimmed.slice(0, -1) };
  return { providerHint: trimmed.slice(0, lastSlash), modelPart: trimmed.slice(lastSlash + 1) };
}

const SOURCE_PROVIDER_ALIASES: Record<string, string> = {
  cursor: "cursor",
  "cursor-acp": "cursor",
  "github-copilot": "openai",
  "copilot-chat": "openai",
  chatgpt: "openai",
  codex: "openai",
  "zai-coding-plan": "zai",
  glm: "zai",
};

function normalizeSourceProviderId(raw?: string): string | undefined {
  if (!raw || typeof raw !== "string") return undefined;
  const lowered = raw.trim().toLowerCase();
  if (!lowered || lowered === "unknown") return undefined;

  const parts = lowered.split(/[/:]/g).filter(Boolean);
  const candidates = [lowered, ...parts].filter((v, i, arr) => arr.indexOf(v) === i);

  for (let i = candidates.length - 1; i >= 0; i--) {
    const candidate = candidates[i]!;
    if (isModelsDevProviderId(candidate)) return candidate;
    const alias = SOURCE_PROVIDER_ALIASES[candidate];
    if (alias && isModelsDevProviderId(alias)) return alias;
  }

  const directAlias = SOURCE_PROVIDER_ALIASES[lowered];
  return directAlias ?? lowered;
}

function inferOfficialProviderFromModelId(modelId: string): string | null {
  const providers = listProvidersForModelId(modelId);
  if (providers.length === 1) return providers[0] ?? null;

  const lower = modelId.toLowerCase();
  if (lower.startsWith("claude")) return "anthropic";
  if (lower.startsWith("gpt") || lower.startsWith("o")) return "openai";
  if (lower.startsWith("gemini")) return "google";
  if (lower.startsWith("kimi")) return "moonshotai";
  if (lower.startsWith("glm")) return "zai";
  if (lower.startsWith("grok")) return "xai";
  if (lower.includes("claude")) return "anthropic";
  if (lower.includes("gemini")) return "google";
  if (lower.includes("gpt")) return "openai";
  if (lower.includes("kimi")) return "moonshotai";
  if (lower.includes("glm")) return "zai";
  if (lower.includes("grok")) return "xai";
  return null;
}

function anthropicPricingCandidates(model: string): string[] {
  if (model === "claude-opus-4-6") return [model, "claude-opus-4-5"];
  if (model === "claude-sonnet-4-6") return [model, "claude-sonnet-4-7", "claude-sonnet-4-5"];
  const match = model.match(/^(claude-[a-z]+-\d+)-(\d+)$/);
  if (match) {
    const [, prefix, minor] = match;
    const minorNum = parseInt(minor, 10);
    if (minorNum > 0) return [model, `${prefix}-${minorNum - 1}`];
  }
  return [model];
}

function moonshotaiPricingCandidates(model: string): string[] {
  const candidates: string[] = [];
  for (const freeCandidate of freeSuffixCandidates(model)) {
    candidates.push(freeCandidate);
    if (freeCandidate.includes(".")) candidates.push(freeCandidate.replace(/\./g, "-"));
  }
  return candidates.filter((value, index, list) => list.indexOf(value) === index);
}

function resolveModelForProvider(providerID: string, normalizedModel: string): string | null {
  if (!isModelsDevProviderId(providerID)) return null;
  const preferredDirect = pickBestModelForProvider(providerID, freeSuffixCandidates(normalizedModel));
  if (preferredDirect) return preferredDirect;

  if (normalizedModel.toLowerCase().endsWith("-thinking")) {
    const withoutThinking = normalizedModel.slice(0, -"-thinking".length);
    if (hasModel(providerID, withoutThinking)) return withoutThinking;
  }

  if (providerID === "moonshotai" && normalizedModel === "kimi-k2") {
    if (hasModel("moonshotai", "kimi-k2-thinking")) return "kimi-k2-thinking";
  }

  if (providerID === "moonshotai") {
    const preferredMoonshot = pickBestModelForProvider("moonshotai", moonshotaiPricingCandidates(normalizedModel));
    if (preferredMoonshot) return preferredMoonshot;
  }

  if (providerID === "google") {
    if (normalizedModel === "gemini-3-pro" && hasModel("google", "gemini-3-pro-preview")) return "gemini-3-pro-preview";
    if (normalizedModel === "gemini-3-flash" && hasModel("google", "gemini-3-flash-preview")) return "gemini-3-flash-preview";
  }

  if (providerID === "anthropic") {
    const candidates = anthropicPricingCandidates(normalizedModel);
    for (const candidate of candidates) {
      if (hasModel("anthropic", candidate)) return candidate;
    }
  }

  return null;
}

export function resolvePricingKey(source: {
  providerID?: string;
  modelID?: string;
}): PricingResolution {
  const srcProvider = source.providerID ?? "unknown";
  const srcModel = source.modelID ?? "unknown";

  if (!source.modelID || typeof source.modelID !== "string") {
    return { ok: false, unknown: { sourceProviderID: srcProvider, sourceModelID: srcModel, reason: "missing_model" } };
  }

  const parsed = parseModelIdHint(source.modelID);
  if (!parsed.modelPart) {
    return { ok: false, unknown: { sourceProviderID: srcProvider, sourceModelID: srcModel, reason: "missing_model" } };
  }

  const normalizedModel = normalizeModelId(parsed.modelPart);
  const sourceProviderHint = normalizeSourceProviderId(source.providerID);
  const modelProviderHint = normalizeSourceProviderId(parsed.providerHint);

  const tryProvider = (
    providerID: string | undefined,
    method: "source_provider" | "model_prefix" | "alias_fallback" | "cursor_api_alias",
    modelIDHint: string = normalizedModel,
  ): PricingResolution | null => {
    if (!providerID) return null;
    const modelID = resolveModelForProvider(providerID, modelIDHint);
    if (!modelID) return null;
    return { ok: true, key: { provider: providerID, model: modelID }, method };
  };

  if (isCursorProviderId(source.providerID) || isCursorModelId(source.modelID)) {
    const cursorModel = resolveCursorModel(source.modelID);
    if (cursorModel.kind === "local") {
      return { ok: true, key: { provider: "cursor", model: cursorModel.model }, method: "cursor_local" };
    }
    if (cursorModel.kind === "official") {
      const resolved = tryProvider(cursorModel.providerHint, "cursor_api_alias", cursorModel.modelHint);
      if (resolved) return resolved;
    }
  }

  const fromSourceProvider = tryProvider(sourceProviderHint, "source_provider");
  if (fromSourceProvider) return fromSourceProvider;

  const fromModelPrefix = tryProvider(modelProviderHint, "model_prefix");
  if (fromModelPrefix) return fromModelPrefix;

  const modelCandidates = freeSuffixCandidates(normalizedModel);
  let ambiguousMatch: { model: string; providerCandidates: string[] } | null = null;

  for (const candidateModel of modelCandidates) {
    const providerCandidates = listProvidersForModelId(candidateModel);
    if (providerCandidates.length === 1) {
      const provider = providerCandidates[0]!;
      return { ok: true, key: { provider, model: candidateModel }, method: "unique_model" };
    }

    if (providerCandidates.length > 1) {
      const inferredAmbiguousProvider = inferOfficialProviderFromModelId(candidateModel);
      if (inferredAmbiguousProvider && providerCandidates.includes(inferredAmbiguousProvider)) {
        const inferredFromAmbiguous = tryProvider(inferredAmbiguousProvider, "alias_fallback", candidateModel);
        if (inferredFromAmbiguous) return inferredFromAmbiguous;
      }

      if (!ambiguousMatch) {
        ambiguousMatch = { model: candidateModel, providerCandidates: [...providerCandidates].sort((a, b) => a.localeCompare(b)) };
      }
    }
  }

  if (ambiguousMatch) {
    return {
      ok: false,
      unknown: {
        sourceProviderID: srcProvider,
        sourceModelID: srcModel,
        mappedModel: ambiguousMatch.model,
        normalizedModelID: ambiguousMatch.model,
        providerCandidates: ambiguousMatch.providerCandidates,
        reason: "ambiguous_model",
      },
    };
  }

  let inferredMissing: { provider: string; model: string } | null = null;
  for (const candidateModel of modelCandidates) {
    const inferredProvider = inferOfficialProviderFromModelId(candidateModel);
    const inferred = tryProvider(inferredProvider ?? undefined, "alias_fallback", candidateModel);
    if (inferred) return inferred;
    if (inferredProvider && !inferredMissing) {
      inferredMissing = { provider: inferredProvider, model: candidateModel };
    }
  }

  if (inferredMissing) {
    return {
      ok: false,
      unknown: {
        sourceProviderID: srcProvider,
        sourceModelID: srcModel,
        mappedProvider: inferredMissing.provider,
        mappedModel: inferredMissing.model,
        normalizedModelID: inferredMissing.model,
        reason: "missing_provider",
      },
    };
  }

  return {
    ok: false,
    unknown: {
      sourceProviderID: srcProvider,
      sourceModelID: srcModel,
      mappedModel: normalizedModel,
      normalizedModelID: normalizedModel,
      reason: "missing_provider",
    },
  };
}

function calculateCostUsd(params: {
  provider: string;
  model: string;
  tokens: TokenBuckets;
}): { ok: true; costUsd: number } | { ok: false } {
  const cost =
    params.provider === "cursor"
      ? lookupCursorLocalCost(params.model)
      : lookupCost(params.provider, params.model);
  if (!cost) return { ok: false };
  return { ok: true, costUsd: calculateUsdFromTokenBuckets(cost, params.tokens) };
}

function classifyMissingPricing(params: {
  mappedProvider: string;
  mappedModel: string;
}): { kind: "unpriced"; reason: string } | { kind: "unknown" } {
  if (params.mappedProvider === "cursor") return { kind: "unknown" };
  if (!hasProvider(params.mappedProvider)) return { kind: "unknown" };
  if (hasModel(params.mappedProvider, params.mappedModel)) {
    if (params.mappedModel.toLowerCase().endsWith("-free")) {
      return { kind: "unpriced", reason: "free-tier model id not priced in snapshot" };
    }
    return { kind: "unpriced", reason: "model id exists in snapshot but has no token pricing" };
  }
  return { kind: "unknown" };
}

function compareSessionCreatedAt(
  a: SessionInfo,
  b: SessionInfo,
): number {
  const aCreated = typeof a.time?.created === "number" && Number.isFinite(a.time.created) ? a.time.created : Number.MAX_SAFE_INTEGER;
  const bCreated = typeof b.time?.created === "number" && Number.isFinite(b.time.created) ? b.time.created : Number.MAX_SAFE_INTEGER;
  if (aCreated !== bCreated) return aCreated - bCreated;
  return a.id.localeCompare(b.id);
}

export async function resolveSessionTree(rootSessionID: string, source: UsageSource, signal?: AbortSignal): Promise<SessionTreeNode[]> {
  const sessions = await source.listSessions(signal);
  const root = sessions.find((session) => session.id === rootSessionID);
  if (!root) {
    throw new SessionNotFoundError(rootSessionID);
  }

  const childrenByParentID = new Map<string, SessionInfo[]>();
  for (const session of sessions) {
    if (!session.parentID) continue;
    const children = childrenByParentID.get(session.parentID);
    if (children) children.push(session);
    else childrenByParentID.set(session.parentID, [session]);
  }

  for (const children of childrenByParentID.values()) children.sort(compareSessionCreatedAt);

  const tree: SessionTreeNode[] = [];
  const visited = new Set<string>();

  const visit = (session: SessionInfo, depth: number): void => {
    if (visited.has(session.id)) return;
    visited.add(session.id);
    tree.push({ sessionID: session.id, parentID: session.parentID, title: session.title, depth });
    const children = childrenByParentID.get(session.id) ?? [];
    for (const child of children) visit(child, depth + 1);
  };

  visit(root, 0);
  return tree;
}

export async function aggregateUsage(params: UsageQuery, source: UsageSource, signal?: AbortSignal): Promise<AggregateResult> {
  if (params.sessionID !== undefined && params.sessionIDs !== undefined) {
    throw new Error("aggregateUsage received both sessionID and sessionIDs");
  }

  const { messages, sessions } = await source.load(params, signal);

  const byModel = new Map<string, AggregateRow>();
  const bySession = new Map<string, SessionRow>();
  const bySourceProvider = new Map<string, SourceProviderRow>();
  const bySourceModel = new Map<string, SourceModelRow>();
  const unknown = new Map<string, UnknownRow>();
  const unpriced = new Map<string, UnpricedRow>();

  let pricedTotals = emptyTokenBuckets();
  let unknownTotals = emptyTokenBuckets();
  let unpricedTotals = emptyTokenBuckets();
  let costTotal = 0;
  const resolutionCache = new Map<string, PricingResolution>();

  for (const msg of messages) {
    const tokens = tokenBucketsFromMessage(msg);
    const sid = msg.sessionID;
    const sessionTitle = sessions.get(sid)?.title;
    const existingSessionRow = bySession.get(sid);
    if (existingSessionRow) {
      existingSessionRow.tokens = addTokenBuckets(existingSessionRow.tokens, tokens);
      existingSessionRow.messageCount += 1;
    } else {
      bySession.set(sid, { sessionID: sid, title: sessionTitle, tokens, costUsd: 0, messageCount: 1 });
    }

    const { providerID, id: modelID } = msg.model;
    const cacheKey = `${providerID}|||${modelID}`;
    const cached = resolutionCache.get(cacheKey);
    const mapping = cached ?? resolvePricingKey({ providerID, modelID });
    if (!cached) resolutionCache.set(cacheKey, mapping);

    if (!mapping.ok) {
      unknownTotals = addTokenBuckets(unknownTotals, tokens);
      const k = JSON.stringify(mapping.unknown);
      const row = unknown.get(k);
      if (row) { row.tokens = addTokenBuckets(row.tokens, tokens); row.messageCount += 1; }
      else { unknown.set(k, { key: mapping.unknown, tokens, messageCount: 1 }); }
      continue;
    }

    const priced = calculateCostUsd({ provider: mapping.key.provider, model: mapping.key.model, tokens });
    if (!priced.ok) {
      const classification = classifyMissingPricing({ mappedProvider: mapping.key.provider, mappedModel: mapping.key.model });

      if (classification.kind === "unpriced") {
        unpricedTotals = addTokenBuckets(unpricedTotals, tokens);
        const rowKey: UnpricedKey = {
          sourceProviderID: providerID,
          sourceModelID: modelID,
          mappedProvider: mapping.key.provider,
          mappedModel: mapping.key.model,
          reason: classification.reason,
        };
        const k = JSON.stringify(rowKey);
        const row = unpriced.get(k);
        if (row) { row.tokens = addTokenBuckets(row.tokens, tokens); row.messageCount += 1; }
        else { unpriced.set(k, { key: rowKey, tokens, messageCount: 1 }); }
        continue;
      }

      unknownTotals = addTokenBuckets(unknownTotals, tokens);
      const unk: UnknownKey = {
        sourceProviderID: providerID,
        sourceModelID: modelID,
        mappedProvider: mapping.key.provider,
        mappedModel: mapping.key.model,
      };
      const k = JSON.stringify(unk);
      const row = unknown.get(k);
      if (row) { row.tokens = addTokenBuckets(row.tokens, tokens); row.messageCount += 1; }
      else { unknown.set(k, { key: unk, tokens, messageCount: 1 }); }
      continue;
    }

    pricedTotals = addTokenBuckets(pricedTotals, tokens);
    costTotal += priced.costUsd;

    const srcProviderID = providerID;
    const srcModelID = modelID;
    const srcModelKey = `${srcProviderID}\n${srcModelID}`;
    const sm = bySourceModel.get(srcModelKey);
    if (sm) { sm.tokens = addTokenBuckets(sm.tokens, tokens); sm.costUsd += priced.costUsd; sm.messageCount += 1; }
    else { bySourceModel.set(srcModelKey, { sourceProviderID: srcProviderID, sourceModelID: srcModelID, tokens, costUsd: priced.costUsd, messageCount: 1 }); }

    const src = bySourceProvider.get(srcProviderID);
    if (src) { src.tokens = addTokenBuckets(src.tokens, tokens); src.costUsd += priced.costUsd; src.messageCount += 1; }
    else { bySourceProvider.set(srcProviderID, { providerID: srcProviderID, tokens, costUsd: priced.costUsd, messageCount: 1 }); }

    const modelKey = `${mapping.key.provider}/${mapping.key.model}`;
    const existing = byModel.get(modelKey);
    if (existing) { existing.tokens = addTokenBuckets(existing.tokens, tokens); existing.costUsd += priced.costUsd; existing.messageCount += 1; }
    else { byModel.set(modelKey, { key: mapping.key, tokens, costUsd: priced.costUsd, messageCount: 1 }); }

    const s = bySession.get(sid);
    if (s) s.costUsd += priced.costUsd;
  }

  return {
    window: { sinceMs: params.sinceMs, untilMs: params.untilMs },
    totals: {
      priced: pricedTotals,
      unknown: unknownTotals,
      unpriced: unpricedTotals,
      costUsd: costTotal,
      messageCount: messages.length,
      sessionCount: new Set(messages.map((m) => m.sessionID)).size,
    },
    bySourceProvider: Array.from(bySourceProvider.values()).sort((a, b) => b.costUsd - a.costUsd),
    bySourceModel: Array.from(bySourceModel.values()).sort((a, b) => b.costUsd - a.costUsd),
    byModel: Array.from(byModel.values()).sort((a, b) => b.costUsd - a.costUsd),
    bySession: Array.from(bySession.values()).sort((a, b) => b.costUsd - a.costUsd),
    unknown: Array.from(unknown.values()).sort((a, b) =>
      b.tokens.input + b.tokens.output + b.tokens.reasoning + b.tokens.cache_read + b.tokens.cache_write -
      (a.tokens.input + a.tokens.output + a.tokens.reasoning + a.tokens.cache_read + a.tokens.cache_write)
    ),
    unpriced: Array.from(unpriced.values()).sort((a, b) =>
      b.tokens.input + b.tokens.output + b.tokens.reasoning + b.tokens.cache_read + b.tokens.cache_write -
      (a.tokens.input + a.tokens.output + a.tokens.reasoning + a.tokens.cache_read + a.tokens.cache_write)
    ),
  };
}
