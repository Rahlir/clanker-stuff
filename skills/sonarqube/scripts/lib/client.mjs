// HTTP access to one SonarQube instance. Failures become SonarError with an
// actionable message (missing token, wrong token type, VPN, corporate CA)
// instead of a raw fetch error; nothing here prints or exits.

export class SonarError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "SonarError";
    this.status = status;
  }
}

const TLS_CODES = new Set([
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

const UNREACHABLE_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);

// Classified by SonarQube's documented prefixes so the token value itself
// never has to be shown to explain a 401.
export function tokenKind(token) {
  if (token.startsWith("squ_")) return "user";
  if (token.startsWith("sqa_")) return "global analysis";
  if (token.startsWith("sqp_")) return "project analysis";
  return "unknown";
}

// Arrays become comma-separated lists, Sonar's convention for multi-value
// params; null/undefined params are dropped so callers can pass optionals.
export function encodeParams(params = {}) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    sp.set(k, Array.isArray(v) ? v.join(",") : String(v));
  }
  return sp;
}

// HTTP statuses that mean "not there for you" (unsupported, forbidden,
// absent). Only these turn into null for optional lookups; throttling and
// server errors must surface, or a flaky endpoint would read as "no data".
const ABSENT_STATUSES = new Set([400, 403, 404]);

export function createClient(instance, { env = process.env, timeoutMs = 30_000 } = {}) {
  const token = env[instance.tokenEnv];
  const host = new URL(instance.url).host;
  const prefix = `${instance.name} (${host})`;
  const tokenPage = `${instance.url}/account/security`;

  // Defense in depth: no message leaving this module may contain the token,
  // whatever a runtime or server error chose to echo.
  const redact = (msg) => (token && msg ? String(msg).split(token).join("<redacted token>") : msg);

  function networkError(e) {
    const code = e.cause?.code ?? e.code;
    if (TLS_CODES.has(code))
      return new SonarError(
        `${prefix}: TLS certificate error (${code}). If the instance uses a corporate CA, export NODE_EXTRA_CA_CERTS=/path/to/ca.pem`,
      );
    if (e.name === "TimeoutError")
      return new SonarError(`${prefix}: no response within ${timeoutMs / 1000}s. Is the VPN up?`);
    if (UNREACHABLE_CODES.has(code))
      return new SonarError(`${prefix}: cannot reach the server (${code}). Is the VPN up?`);
    return new SonarError(redact(`${prefix}: request failed: ${e.cause?.message ?? e.message}`));
  }

  async function httpError(res, path) {
    let detail = "";
    try {
      // Redacted before any truncation: a cut token would no longer match.
      const body = redact(await res.text());
      try {
        detail = (JSON.parse(body).errors ?? []).map((e) => e.msg).join("; ");
      } catch {
        detail = body.slice(0, 200);
      }
    } catch {}
    const tail = detail ? `: ${detail}` : "";
    switch (res.status) {
      case 401: {
        const kind = tokenKind(token);
        const why = kind.endsWith("analysis")
          ? `it is a ${kind} token, which can only submit scans`
          : "expired or revoked?";
        return new SonarError(
          `${prefix}: 401 Unauthorized, ${instance.tokenEnv} was rejected (${why}). Create a User token at ${tokenPage}`,
          401,
        );
      }
      case 403:
        return new SonarError(`${prefix}: 403 Forbidden on ${path}, your user lacks permission${tail}`, 403);
      case 404:
        return new SonarError(`${prefix}: 404 Not Found on ${path}${tail}`, 404);
      case 503:
        return new SonarError(
          `${prefix}: 503, the server is busy (often issue indexing after an upgrade). Try again in a few minutes`,
          503,
        );
      default:
        return new SonarError(`${prefix}: ${res.status} on ${path}${tail || `: ${res.statusText}`}`, res.status);
    }
  }

  // POST bodies are form-encoded: that is what Sonar's api/* write endpoints
  // accept, not JSON.
  async function request(method, path, params, { optional = false, text: asText = false } = {}) {
    if (!token)
      throw new SonarError(
        `${prefix}: ${instance.tokenEnv} is not set. Create a User token at ${tokenPage} and export it in your shell profile`,
      );
    // Checked up front because fetch rejects such a header with an error
    // message that quotes the whole value.
    if (!/^[\x21-\x7e]+$/.test(token))
      throw new SonarError(
        `${prefix}: ${instance.tokenEnv} contains whitespace, control or non-ASCII characters; re-export it without them`,
      );
    const url = new URL(instance.url + path);
    const init = {
      method,
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    };
    if (method === "GET") url.search = encodeParams(params).toString();
    else init.body = encodeParams(params);

    let res;
    try {
      res = await fetch(url, init);
    } catch (e) {
      throw networkError(e);
    }
    if (!res.ok) {
      if (optional && ABSENT_STATUSES.has(res.status)) return null;
      throw await httpError(res, path);
    }
    const text = await res.text();
    // A 200 with HTML is typically an SSO proxy's login page. Reading it as
    // "no results", or as a source file, would hide or misplace findings.
    const proxyPage = `${prefix}: ${path} answered with an unexpected page (an SSO proxy or login page?)`;
    if (asText) {
      if ((res.headers.get("content-type") ?? "").includes("text/html")) throw new SonarError(proxyPage);
      return text;
    }
    if (!text) return null;
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new SonarError(proxyPage);
    }
    // Sonar reports failures with an `errors` array; on a 2xx (a proxy
    // rewriting the status) it must still not pass as an empty result.
    if (Array.isArray(body?.errors) && body.errors.length)
      throw new SonarError(redact(`${prefix}: ${path}: ${body.errors.map((e) => e.msg).join("; ")}`));
    return body;
  }

  return {
    instance,
    // `optional: true` turns 400/403/404 into null, for lookups whose
    // absence is informative (e.g. admin-only or edition-specific endpoints).
    // Everything else still throws. `text: true` returns the body unparsed,
    // for source files that may happen to be valid JSON.
    get: (path, params, opts) => request("GET", path, params, opts),
    post: (path, params) => request("POST", path, params),
  };
}
