import { getAgentDir, readStoredCredential, type ExtensionAPI, type ExtensionContext, type Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";

type DataPath = "balance" | "usage" | "subscriptionModels" | "paidModels";
type Route = {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: unknown;
  allowedHosts?: string[];
  response?: Record<string, string>;
};
type Provider = {
  match?: { prefixes?: string[]; modelsFrom?: Array<"subscriptionModels" | "paidModels"> };
  modelAliases?: Record<string, string>;
  balanceUnit?: string;
  displayName?: string;
  routes: Partial<Record<DataPath, Route>>;
};
type ProviderFile = { providers?: Record<string, Provider> };
type MetricsConfig = { refreshMinutes: number; routesFile?: string; token?: string; language?: string };
type StatusIssue = "not-configured" | "unavailable" | "unsupported";
type Status = {
  usdBalance?: number;
  nanoBalance?: number;
  usage?: unknown;
  subscriptionModels: Set<string>;
  paidModels: Set<string>;
  balanceStatus?: StatusIssue;
  usageStatus?: StatusIssue;
  billingUnavailable?: boolean;
  unavailable: boolean;
  updatedAt?: number;
};
type Labels = {
  languageName: string;
  metricsPrefix: string;
  weekly: string;
  daily: string;
  images: string;
  remaining: string;
  renewal: string;
  tomorrow: string;
  inDays: string;
  usageUnavailable: string;
  balanceNotConfigured: string;
  balanceUnavailable: string;
  balanceUnsupported: string;
  balanceMissing: string;
  loading: string;
  noProviderMatch: string;
  selectModel: string;
  routesFileNotSet: string;
  routeFileInvalid: string;
  menuTitle: string;
  menuRefresh: string;
  menuSetToken: string;
  menuUseLitellm: string;
  menuRemoveToken: string;
  menuLanguage: string;
  menuClose: string;
  tokenPromptTitle: string;
  tokenPromptPlaceholder: string;
  notifyTokenSaved: string;
  notifyTokenRemoved: string;
  notifyLitellmSaved: string;
  notifyNoLitellm: string;
};
type LabelOverrides = Partial<Labels>;
type DiscoveredLanguage = { name?: string; overrides: LabelOverrides };

const EN_LABELS: Labels = {
  languageName: "English",
  metricsPrefix: "Provider metrics",
  weekly: "Wk",
  daily: "Today",
  images: "Img",
  remaining: "left",
  renewal: "resets",
  tomorrow: "tomorrow",
  inDays: "in {n}d",
  usageUnavailable: "usage n/a",
  balanceNotConfigured: "balance not configured",
  balanceUnavailable: "balance unavailable",
  balanceUnsupported: "unsupported balance data",
  balanceMissing: "—",
  loading: "loading…",
  noProviderMatch: "no provider matches this model",
  selectModel: "select a model",
  routesFileNotSet: "routesFile not set in statusbar-config.json",
  routeFileInvalid: "route file missing or invalid",
  menuTitle: "Provider metrics",
  menuRefresh: "Refresh now",
  menuSetToken: "Set token…",
  menuUseLitellm: "Use LiteLLM key",
  menuRemoveToken: "Remove stored token",
  menuLanguage: "Language…",
  menuClose: "Close",
  tokenPromptTitle: "Provider metrics token",
  tokenPromptPlaceholder: "Paste the token (stored in statusbar-config.json, chmod 600)",
  notifyTokenSaved: "Token saved to ~/.pi/statusbar-config.json",
  notifyTokenRemoved: "Token removed",
  notifyLitellmSaved: "LiteLLM key saved as provider metrics token",
  notifyNoLitellm: "No LiteLLM key found (log in first with /login litellm, or set LITELLM_API_KEY)",
};
const IT_LABELS: Labels = {
  languageName: "Italiano",
  metricsPrefix: "Metriche provider",
  weekly: "Sett.",
  daily: "Oggi",
  images: "Img",
  remaining: "rim.",
  renewal: "rinn.",
  tomorrow: "domani",
  inDays: "tra {n}g",
  usageUnavailable: "uso n/d",
  balanceNotConfigured: "saldo non configurato",
  balanceUnavailable: "saldo non disp.",
  balanceUnsupported: "dati saldo non supportati",
  balanceMissing: "—",
  loading: "caricamento…",
  noProviderMatch: "nessun provider corrisponde a questo modello",
  selectModel: "seleziona un modello",
  routesFileNotSet: "file route non impostato in statusbar-config.json",
  routeFileInvalid: "file route mancante o non valido",
  menuTitle: "Metriche provider",
  menuRefresh: "Aggiorna ora",
  menuSetToken: "Imposta token…",
  menuUseLitellm: "Usa chiave LiteLLM",
  menuRemoveToken: "Rimuovi token salvato",
  menuLanguage: "Lingua…",
  menuClose: "Chiudi",
  tokenPromptTitle: "Token metriche provider",
  tokenPromptPlaceholder: "Incolla il token (salvato in statusbar-config.json, chmod 600)",
  notifyTokenSaved: "Token salvato in ~/.pi/statusbar-config.json",
  notifyTokenRemoved: "Token rimosso",
  notifyLitellmSaved: "Chiave LiteLLM salvata come token delle metriche",
  notifyNoLitellm: "Nessuna chiave LiteLLM trovata (fai prima il login con /login litellm o imposta LITELLM_API_KEY)",
};
const BUILTIN_LANGUAGES: Record<string, Labels> = { it: IT_LABELS, en: EN_LABELS };
const LABEL_KEYS: ReadonlySet<string> = new Set(Object.keys(EN_LABELS));
const LANGUAGE_FILE_PATTERN = /^status-bar[-_.]([A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})?)\.(yaml|yml)$/i;

const STATUS_KEY = "pi-nanogpt-metrics";
/** Pretty provider names shown in the status line; override per provider with `displayName` in the routes file. */
const PROVIDER_DISPLAY: Record<string, string> = { nanogpt: "NanoGPT", openrouter: "OpenRouter" };
const STATUS_CONFIG = path.join(process.env.HOME || ".", ".pi", "statusbar-config.json");
const EMPTY_STATUS = (): Status => ({ subscriptionModels: new Set(), paidModels: new Set(), unavailable: true });

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function readMetricsConfig(): MetricsConfig {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(STATUS_CONFIG, "utf8"));
    const raw = isRecord(parsed) && isRecord(parsed.nanogpt) ? parsed.nanogpt : {};
    const refresh = typeof raw.refreshMinutes === "number" && Number.isFinite(raw.refreshMinutes)
      ? Math.max(1, Math.min(60, Math.floor(raw.refreshMinutes))) : 5;
    return {
      refreshMinutes: refresh,
      ...(typeof raw.routesFile === "string" ? { routesFile: raw.routesFile } : {}),
      ...(typeof raw.token === "string" && raw.token.trim() ? { token: raw.token } : {}),
      ...(typeof raw.language === "string" && raw.language.trim() ? { language: raw.language.trim().toLowerCase() } : {}),
    };
  } catch {
    return { refreshMinutes: 5 };
  }
}
/** Scan the routes-file directory (or ~/.pi) for status-bar-<lang>.yaml label files. */
function discoverLanguages(routesDir?: string): Record<string, DiscoveredLanguage> {
  const dir = routesDir || path.join(process.env.HOME || ".", ".pi");
  const found: Record<string, DiscoveredLanguage> = {};
  let entries: string[];
  try { entries = fs.readdirSync(dir); } catch { return found; }
  for (const entry of entries) {
    const match = LANGUAGE_FILE_PATTERN.exec(entry);
    if (!match) continue;
    try {
      const parsed: unknown = parseYaml(fs.readFileSync(path.join(dir, entry), "utf8"));
      if (!isRecord(parsed)) continue;
      const source = isRecord(parsed.labels) ? parsed.labels : parsed;
      const overrides: LabelOverrides = {};
      for (const [key, value] of Object.entries(source)) {
        if (LABEL_KEYS.has(key) && typeof value === "string") (overrides as Record<string, string>)[key] = value;
      }
      found[match[1].toLowerCase()] = {
        ...(typeof parsed.name === "string" && parsed.name.trim() ? { name: parsed.name.trim() } : {}),
        overrides,
      };
    } catch { /* skip unreadable files */ }
  }
  return found;
}
function resolveLabels(language: string | undefined, discovered: Record<string, DiscoveredLanguage>): Labels {
  const code = language?.trim().toLowerCase() || "it";
  const base = BUILTIN_LANGUAGES[code] ? { ...BUILTIN_LANGUAGES[code] } : { ...EN_LABELS };
  return { ...base, ...discovered[code]?.overrides };
}
function languageName(code: string, discovered: Record<string, DiscoveredLanguage>): string {
  return discovered[code]?.name || BUILTIN_LANGUAGES[code]?.languageName || code;
}
function expandHome(value: string): string {
  return value.replace(/^~(?=\/|$)/, process.env.HOME || ".");
}
function normalizeModelId(value: string): string {
  return value.trim().toLowerCase();
}
function finiteNumber(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}
function compactNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  if (value < 1_000) return String(value);
  if (value < 10_000) return `${(value / 1_000).toFixed(1)}k`;
  if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}
function collectModelIds(root: unknown): Set<string> {
  const ids = new Set<string>();
  const modelKeys = new Set(["id", "model", "model_id", "model_name", "slug"]);
  const listKeys = new Set(["data", "models", "results", "subscription_models", "paid_models"]);
  const visit = (value: unknown, depth: number, modelList = false): void => {
    if (depth > 8 || ids.size >= 20_000 || value == null) return;
    if (typeof value === "string") {
      if (modelList && value.trim()) ids.add(normalizeModelId(value));
      return;
    }
    if (Array.isArray(value)) { for (const item of value) visit(item, depth + 1, modelList); return; }
    if (!isRecord(value)) return;
    for (const [key, item] of Object.entries(value)) {
      if (modelKeys.has(key.toLowerCase()) && typeof item === "string" && item.trim()) ids.add(normalizeModelId(item));
      else visit(item, depth + 1, modelList || listKeys.has(key.toLowerCase()));
    }
  };
  visit(root, 0);
  return ids;
}
function matchesModelSet(models: Set<string>, modelId: string): boolean {
  return models.has(normalizeModelId(modelId));
}
function findField(root: unknown, names: string[]): unknown {
  const wanted = new Set(names.map((name) => name.toLowerCase().replace(/[^a-z0-9]/g, "")));
  const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  while (stack.length) {
    const { value, depth } = stack.pop()!;
    if (!isRecord(value) && !Array.isArray(value) || depth > 8) continue;
    if (Array.isArray(value)) {
      for (const item of value) stack.push({ value: item, depth: depth + 1 });
      continue;
    }
    for (const [key, item] of Object.entries(value)) {
      if (wanted.has(key.toLowerCase().replace(/[^a-z0-9]/g, "")) && item != null && typeof item !== "object") return item;
      if (item && typeof item === "object") stack.push({ value: item, depth: depth + 1 });
    }
  }
  return undefined;
}
function mapResponse(value: unknown, mapping?: Record<string, string>): unknown {
  if (!mapping) return value;
  const output: Record<string, unknown> = {};
  for (const [target, source] of Object.entries(mapping)) {
    const found = source.split(".").reduce<unknown>((current, key) => {
      if (current == null || typeof current !== "object") return undefined;
      if (Array.isArray(current) && /^\d+$/.test(key)) return current[Number(key)];
      return (current as Record<string, unknown>)[key];
    }, value);
    if (found !== undefined) output[target] = found;
  }
  return output;
}
function readProviderFile(file?: string): { providers: Record<string, Provider>; issue?: "notSet" | "invalid" } {
  if (!file) return { providers: {}, issue: "notSet" };
  try {
    const parsed = parseYaml(fs.readFileSync(expandHome(file), "utf8")) as ProviderFile | null;
    const providers = parsed?.providers;
    if (!isRecord(providers) || !Object.keys(providers).length) throw new Error("providers missing");
    const validPaths = new Set<DataPath>(["balance", "usage", "subscriptionModels", "paidModels"]);
    const aliases = new Set<string>();
    for (const provider of Object.values(providers)) {
      if (!isRecord(provider) || !isRecord(provider.routes)) throw new Error("invalid provider");
      if (provider.match !== undefined) {
        if (!isRecord(provider.match)) throw new Error("invalid match");
        const { prefixes, modelsFrom } = provider.match;
        if (prefixes !== undefined && (!Array.isArray(prefixes) || prefixes.some((item) => typeof item !== "string" || !item.trim()))) throw new Error("invalid prefixes");
        if (modelsFrom !== undefined && (!Array.isArray(modelsFrom) || modelsFrom.some((item) => item !== "subscriptionModels" && item !== "paidModels"))) throw new Error("invalid model-list source");
      }
      if (provider.modelAliases !== undefined) {
        if (!isRecord(provider.modelAliases)) throw new Error("invalid aliases");
        for (const [alias, target] of Object.entries(provider.modelAliases)) {
          const normalized = normalizeModelId(alias);
          if (!alias.trim() || typeof target !== "string" || !target.trim() || aliases.has(normalized)) throw new Error("invalid or duplicate alias");
          aliases.add(normalized);
        }
      }
      if (provider.balanceUnit !== undefined && (typeof provider.balanceUnit !== "string" || !provider.balanceUnit.trim())) throw new Error("invalid balance unit");
      if (provider.displayName !== undefined && (typeof provider.displayName !== "string" || !provider.displayName.trim())) throw new Error("invalid displayName");
      for (const [name, rawRoute] of Object.entries(provider.routes)) {
        if (!validPaths.has(name as DataPath) || !isRecord(rawRoute) || typeof rawRoute.url !== "string" || !rawRoute.url.trim()) throw new Error("invalid route");
        if (rawRoute.method !== undefined && rawRoute.method !== "GET" && rawRoute.method !== "POST") throw new Error("invalid method");
        if (rawRoute.headers !== undefined && (!isRecord(rawRoute.headers) || Object.values(rawRoute.headers).some((value) => typeof value !== "string"))) throw new Error("invalid headers");
        if (rawRoute.allowedHosts !== undefined && (!Array.isArray(rawRoute.allowedHosts) || rawRoute.allowedHosts.some((host) => typeof host !== "string" || !host.trim()))) throw new Error("invalid allowedHosts");
        if (rawRoute.response !== undefined && (!isRecord(rawRoute.response) || Object.values(rawRoute.response).some((value) => typeof value !== "string" || !value.trim()))) throw new Error("invalid response mapping");
        const url = new URL(rawRoute.url);
        if (!(url.protocol === "https:" || url.protocol === "http:") || url.username || url.password) throw new Error("invalid URL");
      }
    }
    return { providers: providers as Record<string, Provider> };
  } catch {
    return { providers: {}, issue: "invalid" };
  }
}
function selectProvider(providers: Record<string, Provider>, states: Map<string, Status>, modelId?: string): { key: string; provider: Provider; apiModelId: string; display: string } | undefined {
  if (!modelId?.trim()) return undefined;
  const entries = Object.entries(providers).sort(([a], [b]) => a.localeCompare(b));
  const normalized = normalizeModelId(modelId);
  const aliasMatch = entries.find(([, provider]) => Object.keys(provider.modelAliases || {}).some((alias) => normalizeModelId(alias) === normalized));
  const prefixMatch = entries.flatMap((entry) => entry[1].match?.prefixes?.filter((prefix) => normalized.startsWith(prefix.trim().toLowerCase())).map((prefix) => ({ entry, prefix })) || [])
    .sort((a, b) => b.prefix.length - a.prefix.length || a.entry[0].localeCompare(b.entry[0]))[0]?.entry;
  const explicit = aliasMatch || prefixMatch;
  const match = explicit || entries.find(([key, provider]) => {
    const state = states.get(key) || EMPTY_STATUS();
    const apiId = provider.modelAliases?.[modelId] || modelId;
    return provider.match?.modelsFrom?.some((list) => matchesModelSet(list === "subscriptionModels" ? state.subscriptionModels : state.paidModels, apiId));
  });
  if (!match) return undefined;
  const aliases = match[1].modelAliases || {};
  const target = aliases[modelId] || Object.entries(aliases).find(([alias]) => normalizeModelId(alias) === normalized)?.[1] || modelId;
  const display = (typeof match[1].displayName === "string" && match[1].displayName.trim()) || PROVIDER_DISPLAY[match[0].toLowerCase()] || match[0];
  return { key: match[0], provider: match[1], apiModelId: target, display };
}
function resolveEnv(value: unknown, resolve: (name: string) => string): unknown {
  if (typeof value === "string") return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => resolve(name));
  if (Array.isArray(value)) return value.map((item) => resolveEnv(item, resolve));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveEnv(item, resolve)]));
  return value;
}
function readStoredLitellmKey(): string | undefined {
  try {
    const credential = readStoredCredential("litellm", path.join(getAgentDir(), "auth.json"));
    if (credential?.type === "api_key") {
      const key = credential.key?.trim();
      if (key && !key.startsWith("!")) return key;
    }
  } catch { /* auth.json missing or unreadable */ }
  return undefined;
}
function updateNanoConfig(mutate: (nanogpt: Record<string, unknown>) => void): void {
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(fs.readFileSync(STATUS_CONFIG, "utf8")) as Record<string, unknown>; } catch { /* start fresh */ }
  const nanogpt = isRecord(parsed.nanogpt) ? { ...parsed.nanogpt } : {};
  mutate(nanogpt);
  parsed.nanogpt = nanogpt;
  fs.mkdirSync(path.dirname(STATUS_CONFIG), { recursive: true });
  const temp = `${STATUS_CONFIG}.tmp-${process.pid}`;
  fs.writeFileSync(temp, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(temp, 0o600);
  fs.renameSync(temp, STATUS_CONFIG);
}
function saveToken(value: string | undefined): void {
  updateNanoConfig((nanogpt) => {
    if (value) nanogpt.token = value;
    else delete nanogpt.token;
  });
}
function saveLanguage(value: string): void {
  updateNanoConfig((nanogpt) => { nanogpt.language = value; });
}
function formatBalance(state: Status, unit: string, labels: Labels): string[] {
  const parts: string[] = [];
  if (state.usdBalance != null) parts.push(`$${state.usdBalance < 1 ? state.usdBalance.toFixed(3) : state.usdBalance.toFixed(2)}`);
  if (state.nanoBalance != null) parts.push(`${compactNumber(state.nanoBalance)} ${unit}`);
  if (parts.length) return parts;
  const issue = state.balanceStatus === "not-configured" ? labels.balanceNotConfigured
    : state.balanceStatus === "unsupported" ? labels.balanceUnsupported : labels.balanceUnavailable;
  return [state.balanceStatus ? issue : labels.balanceMissing];
}
interface UsagePart { text: string; ratio: number | undefined }
function usageParts(usage: unknown, labels: Labels): UsagePart[] {
  if (!isRecord(usage)) return [];
  const limits = isRecord(usage.limits) ? usage.limits : {};
  const result: UsagePart[] = [];
  const quota = (label: string, value: unknown, limit: unknown): void => {
    if (!isRecord(value)) return;
    const used = finiteNumber(value.used);
    const remaining = finiteNumber(value.remaining);
    const total = finiteNumber(limit) ?? (used != null && remaining != null ? used + remaining : undefined);
    if (used != null && total != null && total > 0) {
      result.push({ text: `${label} ${compactNumber(used)}/${compactNumber(total)}`, ratio: used / total });
    } else if (remaining != null && total != null && total > 0) {
      result.push({ text: `${label} ${compactNumber(total - remaining)}/${compactNumber(total)}`, ratio: (total - remaining) / total });
    } else if (remaining != null) {
      result.push({ text: `${label} ${labels.remaining} ${compactNumber(remaining)}`, ratio: undefined });
    }
  };
  quota(labels.weekly, usage.weeklyInputTokens, limits.weeklyInputTokens);
  quota(labels.daily, usage.dailyInputTokens, limits.dailyInputTokens);
  quota(labels.images, usage.dailyImages, limits.dailyImages);
  return result;
}
/** Renewal date with a relative countdown when it is close ("rinn. 30 nov · tra 3g"). */
function renewalText(usage: unknown, labels: Labels): { text: string; days: number | undefined } | undefined {
  if (!isRecord(usage)) return undefined;
  const period = isRecord(usage.period) ? usage.period : {};
  const reset = (isRecord(usage.weeklyInputTokens) ? usage.weeklyInputTokens.resetAt : undefined)
    ?? (isRecord(usage.dailyImages) ? usage.dailyImages.resetAt : undefined)
    ?? period.currentPeriodEnd;
  if (typeof reset !== "string" && typeof reset !== "number") return undefined;
  const date = new Date(reset);
  if (Number.isNaN(date.getTime())) return undefined;
  const label = date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  const days = Math.ceil((date.getTime() - Date.now()) / 86_400_000);
  const suffix = days > 1 ? labels.inDays.replace("{n}", String(days)) : days === 1 ? labels.tomorrow : "";
  return { text: suffix ? `${labels.renewal} ${label} · ${suffix}` : `${labels.renewal} ${label}`, days };
}
const paint = (code: number, text: string): string => `\x1b[${code}m${text}\x1b[0m`;
const dim = (text: string): string => paint(2, text);
const SEP = dim(" · ");
/** Style with the active Pi theme token; fall back to a plain SGR code when no theme is available. */
function paintColor(theme: Theme | undefined, token: ThemeColor, fallbackCode: number, text: string): string {
  if (theme) {
    try { return theme.fg(token, text); } catch { /* fall through */ }
  }
  return paint(fallbackCode, text);
}

function balanceSegment(state: Status, unit: string, theme: Theme | undefined, labels: Labels): string {
  const text = formatBalance(state, unit, labels);
  const bs = state.balanceStatus;
  const color = bs === "unavailable" || state.unavailable
    ? (t: string) => paintColor(theme, "error", 31, t)
    : bs ? (t: string) => paintColor(theme, "warning", 33, t)
    : state.usdBalance != null && state.usdBalance < 1 ? (t: string) => paintColor(theme, "error", 31, t)
    : state.usdBalance != null && state.usdBalance < 5 ? (t: string) => paintColor(theme, "warning", 33, t)
    : (t: string) => paintColor(theme, "success", 32, t);
  return text.map((part) => color(part)).join(SEP);
}
function renderStatus(key: string, provider: Provider, state: Status, theme: Theme | undefined, labels: Labels): string {
  const parts: string[] = [paintColor(theme, "accent", 1, key), balanceSegment(state, provider.balanceUnit || "NGPT", theme, labels)];
  for (const part of usageParts(state.usage, labels)) {
    const color = part.ratio == null
      ? (t: string) => paintColor(theme, "text", 36, t)
      : part.ratio > 0.9 ? (t: string) => paintColor(theme, "error", 31, t)
      : part.ratio > 0.7 ? (t: string) => paintColor(theme, "warning", 33, t)
      : (t: string) => paintColor(theme, "success", 32, t);
    parts.push(color(part.text));
  }
  const renewal = renewalText(state.usage, labels);
  if (renewal) {
    parts.push(renewal.days != null && renewal.days <= 1
      ? paintColor(theme, "warning", 33, renewal.text)
      : paintColor(theme, "dim", 2, renewal.text));
  }
  if (state.usageStatus === "unavailable") {
    parts.push(paintColor(theme, "warning", 33, labels.usageUnavailable));
  }
  return parts.join(SEP);
}

export default function providerMetrics(pi: ExtensionAPI): void {
  let config = readMetricsConfig();
  let routeFile = readProviderFile(config.routesFile);
  const routesDir = config.routesFile ? path.dirname(expandHome(config.routesFile)) : undefined;
  let discovered = discoverLanguages(routesDir);
  let labels = resolveLabels(config.language, discovered);
  const states = new Map<string, Status>();
  const loadedLists = new Map<string, Set<DataPath>>();
  const listUpdatedAt = new Map<string, number>();
  let currentModel = "";
  let currentProvider: string | undefined;
  let pending = false;
  let generation = 0;
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let theme: Theme | undefined;

  const getState = (key: string): Status => {
    let state = states.get(key);
    if (!state) { state = EMPTY_STATUS(); states.set(key, state); }
    return state;
  };
  const statusText = (): string => {
    if (routeFile.issue) {
      return paintColor(theme, "error", 31, `${labels.metricsPrefix}: ${routeFile.issue === "notSet" ? labels.routesFileNotSet : labels.routeFileInvalid}`);
    }
    const selected = selectProvider(routeFile.providers, states, currentModel);
    if (!selected) {
      return paintColor(theme, "warning", 33, `${labels.metricsPrefix}: ${currentModel ? labels.noProviderMatch : labels.selectModel}`);
    }
    const state = getState(selected.key);
    if (pending && !state.updatedAt) return paintColor(theme, "muted", 2, `${selected.display}: ${labels.loading}`);
    return renderStatus(selected.display, selected.provider, state, theme, labels);
  };
  const publish = (ctx: ExtensionContext): void => {
    try { theme = ctx.ui.theme; } catch { theme = undefined; }
    ctx.ui.setStatus(STATUS_KEY, statusText());
  };
  const stopTimer = (): void => { if (timer) clearTimeout(timer); timer = undefined; };

  const resolveSecret = (name: string): string => {
    const stored = config.token?.trim();
    if (stored) return stored;
    const fromEnv = process.env[name] || "";
    if (fromEnv.trim()) return fromEnv;
    return readStoredLitellmKey() || process.env.LITELLM_API_KEY?.trim() || "";
  };

  const requestJson = async (route: Route, signal: AbortSignal): Promise<unknown> => {
    const target = new URL(route.url);
    const isLocal = ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname);
    const isDirectNanoGpt = target.protocol === "https:" && ["api.nano-gpt.com", "nano-gpt.com"].includes(target.hostname.toLowerCase());
    const allowed = route.allowedHosts?.some((host) => host.toLowerCase() === target.hostname.toLowerCase()) ?? (isLocal || isDirectNanoGpt);
    if (!allowed || (!isLocal && target.protocol !== "https:")) throw new Error("untrusted endpoint");
    const method = route.method || "GET";
    const headers = route.headers ? resolveEnv(route.headers, resolveSecret) as Record<string, string> : {};
    if (Object.values(headers).some((value) => typeof value !== "string" || !value.trim() || /^Bearer\s*$/i.test(value))) throw new Error("credential unavailable");
    const response = await fetch(target, {
      method,
      headers: { Accept: "application/json", ...(method === "POST" ? { "Content-Type": "application/json" } : {}), ...headers },
      ...(route.body !== undefined ? { body: JSON.stringify(resolveEnv(route.body, resolveSecret)) } : method === "POST" ? { body: "{}" } : {}),
      signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]),
      redirect: "error",
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    if (text.length > 1_000_000) throw new Error("response too large");
    return JSON.parse(text) as unknown;
  };

  const refresh = async (ctx: ExtensionContext, force = false): Promise<void> => {
    const selected = selectProvider(routeFile.providers, states, currentModel);
    currentProvider = selected?.key;
    if (!selected) { publish(ctx); return; }
    if (pending && currentProvider === selected.key) return;
    const state = getState(selected.key);
    const due = config.refreshMinutes * 60_000 - (Date.now() - (state.updatedAt || 0));
    if (!force && due > 0) {
      stopTimer();
      timer = setTimeout(() => { timer = undefined; void refresh(ctx, true); }, due);
      timer.unref?.();
      return;
    }
    stopTimer();
    controller?.abort();
    controller = new AbortController();
    const signal = controller.signal;
    const thisGeneration = ++generation;
    pending = true;
    publish(ctx);
    const { key, provider } = selected;
    const loaded = loadedLists.get(key) || new Set<DataPath>();
    const listFresh = Date.now() - (listUpdatedAt.get(key) || 0) < 30 * 60_000;
    const entries: Array<[DataPath, Route]> = [];
    if (provider.routes.balance) entries.push(["balance", provider.routes.balance]);
    if (provider.routes.usage) entries.push(["usage", provider.routes.usage]);
    for (const name of ["subscriptionModels", "paidModels"] as const) {
      if (provider.routes[name] && (!listFresh || !loaded.has(name))) entries.push([name, provider.routes[name]!]);
    }
    const results = await Promise.all(entries.map(async ([name, route]) => ({ name, route, result: await Promise.allSettled([requestJson(route, signal)]).then(([item]) => item) })));
    if (thisGeneration !== generation || signal.aborted || currentProvider !== key) return;
    let successes = 0;
    let failures = 0;
    const next: Status = { ...state, subscriptionModels: new Set(state.subscriptionModels), paidModels: new Set(state.paidModels) };
    if (!provider.routes.balance) next.balanceStatus = "not-configured";
    if (!provider.routes.usage) next.usageStatus = "not-configured";
    for (const { name, route, result } of results) {
      if (result.status === "rejected") {
        failures++;
        if (name === "balance") next.balanceStatus = "unavailable";
        if (name === "usage") next.usageStatus = "unavailable";
        if (name === "subscriptionModels" || name === "paidModels") next.billingUnavailable = true;
        continue;
      }
      successes++;
      const data = mapResponse(result.value, route.response);
      if (name === "balance") {
        const usd = finiteNumber(findField(data, ["usdBalance", "usd_balance", "balance_usd", "total_credits"]));
        const units = finiteNumber(findField(data, ["nanoBalance", "nano_balance"]));
        if (usd !== undefined) next.usdBalance = usd;
        if (units !== undefined) next.nanoBalance = units;
        next.balanceStatus = usd !== undefined || units !== undefined ? undefined : "unsupported";
      } else if (name === "usage") {
        next.usage = data;
        next.usageStatus = usageParts(data, labels).length ? undefined : "unsupported";
      } else {
        next[name] = collectModelIds(data);
        loaded.add(name);
        next.billingUnavailable = false;
      }
    }
    if (entries.some(([name]) => name === "subscriptionModels" || name === "paidModels")) listUpdatedAt.set(key, Date.now());
    loadedLists.set(key, loaded);
    next.unavailable = successes === 0;
    next.updatedAt = Date.now();
    states.set(key, next);
    pending = false;
    controller = undefined;
    publish(ctx);
    const delay = failures ? 15_000 : config.refreshMinutes * 60_000;
    timer = setTimeout(() => { timer = undefined; void refresh(ctx, true); }, delay);
    timer.unref?.();
  };

  const reload = (ctx: ExtensionContext, force = true): void => {
    config = readMetricsConfig();
    routeFile = readProviderFile(config.routesFile);
    const dir = config.routesFile ? path.dirname(expandHome(config.routesFile)) : undefined;
    discovered = discoverLanguages(dir);
    labels = resolveLabels(config.language, discovered);
    states.clear(); loadedLists.clear(); listUpdatedAt.clear();
    controller?.abort(); controller = undefined; pending = false; generation++;
    stopTimer();
    void refresh(ctx, force);
  };

  pi.on("session_start", async (_event, ctx) => {
    currentModel = ctx.model?.id || "";
    reload(ctx, true);
  });
  pi.on("model_select", async (event, ctx) => {
    currentModel = event.model.id;
    stopTimer();
    controller?.abort(); controller = undefined; pending = false; generation++;
    void refresh(ctx, true);
  });
  pi.on("session_shutdown", async () => {
    generation++;
    controller?.abort(); controller = undefined; pending = false;
    stopTimer();
  });
  pi.registerCommand("metrics", {
    description: "Provider metrics: refresh, manage token",
    handler: async (_args, ctx) => openMenu(ctx),
  });

  async function openMenu(ctx: ExtensionContext): Promise<void> {
    for (;;) {
      const action = await ctx.ui.select(labels.menuTitle, [
        labels.menuRefresh,
        labels.menuSetToken,
        labels.menuUseLitellm,
        labels.menuRemoveToken,
        labels.menuLanguage,
        labels.menuClose,
      ]);
      if (!action || action === labels.menuClose) return;
      if (action === labels.menuRefresh) {
        reload(ctx, true);
      } else if (action === labels.menuSetToken) {
        const entered = await ctx.ui.input(labels.tokenPromptTitle, labels.tokenPromptPlaceholder);
        const value = entered?.trim();
        if (!value) continue;
        saveToken(value);
        reload(ctx, true);
        ctx.ui.notify(labels.notifyTokenSaved, "info");
      } else if (action === labels.menuUseLitellm) {
        const key = readStoredLitellmKey() || process.env.LITELLM_API_KEY?.trim() || undefined;
        if (key) {
          saveToken(key);
          reload(ctx, true);
          ctx.ui.notify(labels.notifyLitellmSaved, "info");
        } else {
          ctx.ui.notify(labels.notifyNoLitellm, "warning");
        }
      } else if (action === labels.menuRemoveToken) {
        saveToken(undefined);
        reload(ctx, true);
        ctx.ui.notify(labels.notifyTokenRemoved, "info");
      } else if (action === labels.menuLanguage) {
        const dir = config.routesFile ? path.dirname(expandHome(config.routesFile)) : undefined;
        const now = discoverLanguages(dir);
        const codes = [...new Set([...Object.keys(BUILTIN_LANGUAGES), ...Object.keys(now)])].sort();
        const current = config.language?.trim().toLowerCase() || "it";
        const options = codes.map((code) => `${code === current ? "✓ " : "  "}${languageName(code, now)}`);
        const chosen = await ctx.ui.select(labels.menuLanguage, options);
        if (!chosen) continue;
        const code = codes[options.indexOf(chosen)];
        if (code && code !== current) {
          saveLanguage(code);
          reload(ctx, true);
        }
      }
    }
  }
}
