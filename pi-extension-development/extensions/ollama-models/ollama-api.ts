/**
 * Local daemon API client for the ollama-models extension.
 *
 * POST /api/show needs no auth: the daemon attaches the cloud sign-in when it
 * proxies (plan Decision #2). Everything here is fail-soft — a failed request
 * resolves to { ok: false } and the caller keeps that model's fallback entry.
 * Nothing in this module throws.
 */

/** Daemon root; the OpenAI provider endpoint is `${DEFAULT_DAEMON_BASE_URL}/v1`. */
export const DEFAULT_DAEMON_BASE_URL = "http://127.0.0.1:11434";

/** Per-request timeout; nothing in the extension aborts a fetch batch early. */
export const FETCH_TIMEOUT_MS = 10000;

/** The slice of a POST /api/show response the extension reads. */
export interface ShowResponse {
  model_info: Record<string, unknown>;
  capabilities?: string[];
}

/**
 * Fail-soft result. ok:false covers a non-ok status, a network error, and a
 * timeout — callers never need to distinguish them.
 */
export type ShowResult = { ok: true; data: ShowResponse } | { ok: false };

/**
 * Host dependencies, injected per the PlanModeDeps rule (plan Decision #13):
 * tests pass fakes, so no unit test touches the real network. The fake clock
 * died with the cooldown; only fetch remains.
 */
export interface OllamaModelsDeps {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
}

/**
 * Fetch one model's /api/show document. The timeout aborts a hanging request;
 * any failure resolves to { ok: false }.
 */
export async function fetchShow(
  modelId: string,
  baseUrl: string,
  deps: OllamaModelsDeps,
  timeoutMs: number,
): Promise<ShowResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let result: ShowResult;
  try {
    const res = await deps.fetch(`${baseUrl}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: modelId }),
      signal: controller.signal,
    });
    result = res.ok
      ? { ok: true, data: JSON.parse(await res.text()) as ShowResponse }
      : { ok: false };
  } catch {
    result = { ok: false };
  }
  clearTimeout(timeout);
  return result;
}

/**
 * Find `<arch>.context_length` in a /api/show model_info block. Returns
 * undefined when no numeric key matches, so the caller keeps its seed value
 * (deliberate divergence from upstream, which falls back to 128000).
 */
export function getContextLength(modelInfo: Record<string, unknown>): number | undefined {
  for (const [key, value] of Object.entries(modelInfo)) {
    if (key.endsWith(".context_length") && typeof value === "number") {
      return value;
    }
  }
  return undefined;
}
