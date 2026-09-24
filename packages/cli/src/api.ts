/** Thin fetch wrapper for the project API (architecture section 12). */

export type ApiResult = {
  status: number;
  ok: boolean;
  body: unknown;
};

export type ApiRequestOptions = {
  body?: unknown;
  idempotencyKey?: string;
};

export function apiErrorMessage(result: ApiResult): string {
  const body = result.body as { error?: string; message?: string } | null;
  return body?.error ?? body?.message ?? JSON.stringify(result.body ?? {});
}

export async function apiRequest(
  baseUrl: string,
  token: string,
  method: string,
  apiPath: string,
  options: ApiRequestOptions = {}
): Promise<ApiResult> {
  const base = baseUrl.replace(/\/$/, "");
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey;
  let response: Response;
  try {
    response = await fetch(`${base}${apiPath}`, {
      method,
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
  } catch (error) {
    throw new Error(`API request failed (${method} ${apiPath}): ${(error as Error).message}`);
  }
  let body: unknown = null;
  const text = await response.text();
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: response.status, ok: response.ok, body };
}
