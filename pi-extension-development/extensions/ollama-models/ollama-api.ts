/**
 * Local daemon API client for the ollama-models extension.
 *
 * POST /api/show needs no auth — the daemon attaches the cloud sign-in when
 * it proxies. Every request here is fail-soft: any failure resolves to
 * { ok: false } and the caller drops the model. Nothing throws.
 */

/** Nothing in the extension aborts a fetch batch early; this is the only bound. */
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
type ShowResult = { ok: true; data: ShowResponse } | { ok: false };

/** Host dependencies, injected so tests pass fakes and no unit test touches the real network. */
export interface OllamaModelsDeps {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
}

/** Fetch one model's /api/show document; a hanging request is aborted at the timeout. */
export const fetchShow = async (
  modelId: string,
  baseUrl: string,
  deps: OllamaModelsDeps,
  timeoutMs: number,
): Promise<ShowResult> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const request = async (): Promise<ShowResult> => {
    const response = await deps.fetch(`${baseUrl}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: modelId }),
      signal: controller.signal,
    });
    return response.ok
      ? { ok: true, data: JSON.parse(await response.text()) as ShowResponse }
      : { ok: false };
  };
  const result = await request().catch((): ShowResult => ({ ok: false }));
  clearTimeout(timeout);
  return result;
};

/**
 * Find `<arch>.context_length` in a /api/show model_info block; 0 when none
 * matches. The caller drops non-positive lengths.
 */
export const getContextLength = (modelInfo: Record<string, unknown>): number =>
  Object.entries(modelInfo).flatMap(([key, value]) =>
    key.endsWith(".context_length") && typeof value === "number" ? [value] : [],
  )[0] ?? 0;
