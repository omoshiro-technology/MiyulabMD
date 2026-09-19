export const OG_USER_AGENT =
  "Mozilla/5.0 (compatible; MiyulabMD-OGP/1.0; +https://md.miyulab.dev)";

export const OG_ACCEPT = "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8";

/** Service bindings rewrite request.url to this Worker; pass the page URL here. */
export const OG_TARGET_HEADER = "x-og-target";

export const OG_MAX_REDIRECTS = 5;
export const OG_MAX_BYTES = 512_000;

export type OgOutbound = {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
};

export function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, "");
}

function ipv4IntFromLiteral(host: string): number | null {
  if (/^0x[0-9a-f]+$/i.test(host)) {
    const value = Number.parseInt(host, 16);
    return Number.isInteger(value) && value >= 0 && value <= 0xffffffff
      ? value
      : null;
  }
  if (/^\d+$/.test(host)) {
    const value = Number.parseInt(host, 10);
    return Number.isInteger(value) && value <= 0xffffffff ? value : null;
  }
  return null;
}

function ipv4IntIsBlocked(value: number): boolean {
  const first = (value >>> 24) & 255;
  const second = (value >>> 16) & 255;
  if (first === 0 || first === 10 || first === 127) {
    return true;
  }
  if (first === 169 && second === 254) {
    return true;
  }
  if (first === 192 && second === 168) {
    return true;
  }
  return first === 172 && second >= 16 && second <= 31;
}

/** IPv4-mapped tail after ::ffff: — dotted-quad or two URL-canonical hextets. */
function ipv4IntFromMappedTail(tail: string): number | null {
  const dotted = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(tail);
  if (dotted?.[1] && dotted[2] && dotted[3] && dotted[4]) {
    const o1 = Number.parseInt(dotted[1], 10);
    const o2 = Number.parseInt(dotted[2], 10);
    const o3 = Number.parseInt(dotted[3], 10);
    const o4 = Number.parseInt(dotted[4], 10);
    if (o1 > 255 || o2 > 255 || o3 > 255 || o4 > 255) {
      return null;
    }
    return ((o1 << 24) | (o2 << 16) | (o3 << 8) | o4) >>> 0;
  }
  const hextets = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(tail);
  if (!(hextets?.[1] && hextets[2])) {
    return null;
  }
  const high = Number.parseInt(hextets[1], 16);
  const low = Number.parseInt(hextets[2], 16);
  return ((high << 16) | low) >>> 0;
}

function ipv4IntFromIpv6Mapped(host: string): number | null {
  const mapped = /^(?:0:0:0:0:0:|::)ffff:(.+)$/.exec(host);
  if (!mapped?.[1]) {
    return null;
  }
  const tail = mapped[1];
  return (
    ipv4IntFromMappedTail(tail) ??
    (tail.startsWith("0:") ? ipv4IntFromMappedTail(tail.slice(2)) : null)
  );
}

function isBlockedIpv6(host: string): boolean {
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") {
    return true;
  }
  if (
    host.startsWith("fe80:") ||
    host.startsWith("fc") ||
    host.startsWith("fd")
  ) {
    return true;
  }
  const mapped = ipv4IntFromIpv6Mapped(host);
  return mapped !== null && ipv4IntIsBlocked(mapped);
}

export function isBlockedHost(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal") ||
    host.endsWith(".local") ||
    host === "0" ||
    host.startsWith("127.") ||
    host.startsWith("0.")
  ) {
    return true;
  }
  if (
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host) ||
    /^169\.254\./.test(host)
  ) {
    return true;
  }
  if (host.includes(":")) {
    return isBlockedIpv6(host);
  }
  const literal = ipv4IntFromLiteral(host);
  return literal !== null && ipv4IntIsBlocked(literal);
}

export function isBlockedOgUrl(url: URL): boolean {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return true;
  }
  const host = normalizeHostname(url.hostname);
  if (host === "workers.dev" || host.endsWith(".workers.dev")) {
    return true;
  }
  return isBlockedHost(url.hostname);
}

export function parseOgTargetUrl(request: Request): URL | null {
  const raw = request.headers.get(OG_TARGET_HEADER);
  if (!raw) {
    return null;
  }
  try {
    const target = new URL(raw);
    if (isBlockedOgUrl(target)) {
      return null;
    }
    return target;
  } catch {
    return null;
  }
}

export function ogRequestInit(
  signal?: AbortSignal,
  redirect: RequestRedirect = "manual",
): RequestInit {
  return {
    headers: {
      Accept: OG_ACCEPT,
      "Accept-Language": "ja,en;q=0.8",
      "User-Agent": OG_USER_AGENT,
    },
    method: "GET",
    redirect,
    signal,
  };
}

function isRedirectStatus(status: number): boolean {
  return (
    status === 301 ||
    status === 302 ||
    status === 303 ||
    status === 307 ||
    status === 308
  );
}

async function readLimitedBody(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const body = response.body;
  if (!body) {
    return new Uint8Array();
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done || !value) {
        break;
      }
      const remain = maxBytes - total;
      if (value.byteLength > remain) {
        chunks.push(value.subarray(0, remain));
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
  }
  const out = new Uint8Array(
    chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function cappedOgResponse(response: Response): Promise<Response> {
  const body = await readLimitedBody(response, OG_MAX_BYTES);
  const headers = new Headers();
  const contentType = response.headers.get("Content-Type");
  if (contentType) {
    headers.set("Content-Type", contentType);
  }
  return new Response(new TextDecoder().decode(body), {
    headers,
    status: response.status,
  });
}

export async function fetchOgTarget(
  start: URL,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<Response> {
  let current = start;
  for (let hop = 0; hop <= OG_MAX_REDIRECTS; hop += 1) {
    if (isBlockedOgUrl(current)) {
      return new Response("blocked host", { status: 400 });
    }
    const response = await fetchImpl(current.toString(), ogRequestInit(signal));
    if (!isRedirectStatus(response.status)) {
      return cappedOgResponse(response);
    }
    const location = response.headers.get("Location");
    if (!location) {
      return new Response("fetch failed", { status: 502 });
    }
    try {
      current = new URL(location, current);
    } catch {
      return new Response("invalid url", { status: 400 });
    }
  }
  return new Response("too many redirects", { status: 400 });
}
