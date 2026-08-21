import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

/** @typedef {import("node:http").IncomingMessage} IncomingMessage */
/** @typedef {import("node:http").ServerResponse} ServerResponse */
/** @typedef {import("node:stream").Duplex} Duplex */

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/**
 * @param {URL} target
 * @returns {string}
 */
export function targetAuthority(target) {
  const { hostname, port, protocol } = target;
  const defaultPort = protocol === "https:" ? 443 : 80;
  const portNum = Number(port) || defaultPort;
  const needsPort = portNum !== defaultPort;
  if (hostname.includes(":")) {
    return needsPort ? `[${hostname}]:${portNum}` : `[${hostname}]`;
  }
  return needsPort ? `${hostname}:${portNum}` : hostname;
}

/**
 * @param {string | string[] | undefined} value
 * @returns {string | undefined}
 */
function joinValue(value) {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value.join(", ") : String(value);
}

/**
 * @param {string | undefined} header
 * @param {string} value
 * @returns {string}
 */
function appendList(header, value) {
  return header === undefined ? value : `${header}, ${value}`;
}

/**
 * @param {string | undefined} header
 * @param {string} dropName
 * @returns {string | undefined}
 */
function splitCookieWithout(header, dropName) {
  if (typeof header !== "string") return undefined;
  const kept = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && !(part.startsWith(dropName + "=") || part === dropName));
  return kept.length > 0 ? kept.join("; ") : undefined;
}

/**
 * @param {IncomingMessage} req
 * @param {object} options
 * @param {URL} options.target
 * @param {string} options.cookieName
 * @param {string} options.proto
 * @returns {import("node:http").OutgoingHttpHeaders}
 */
export function forwardRequestHeaders(req, { target, cookieName, proto }) {
  /** @type {import("node:http").OutgoingHttpHeaders} */
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(name)) continue;
    if (name === "host" || name === "origin" || name === "expect") continue;
    if (name === "cookie" && cookieName) {
      const kept = splitCookieWithout(typeof value === "string" ? value : undefined, cookieName);
      if (kept !== undefined) headers.cookie = kept;
      continue;
    }
    const joined = joinValue(value);
    if (joined !== undefined) headers[name] = joined;
  }
  headers.host = targetAuthority(target);
  headers["x-forwarded-host"] = joinValue(req.headers.host) ?? targetAuthority(target);
  headers["x-forwarded-for"] = appendList(joinValue(req.headers["x-forwarded-for"]), String(req.socket.remoteAddress));
  headers["x-forwarded-proto"] = proto;
  return headers;
}

/**
 * @param {IncomingMessage} req
 * @param {object} options
 * @param {URL} options.target
 * @param {string} options.cookieName
 * @returns {Record<string, string>}
 */
export function forwardUpgradeHeaders(req, { target, cookieName }) {
  /** @type {Record<string, string>} */
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(name)) continue;
    if (name === "host" || name === "origin") continue;
    if (name === "cookie" && cookieName) {
      const kept = splitCookieWithout(typeof value === "string" ? value : undefined, cookieName);
      if (kept !== undefined) headers.cookie = kept;
      continue;
    }
    const joined = joinValue(value);
    if (joined !== undefined) headers[name] = joined;
  }
  headers.host = targetAuthority(target);
  headers.connection = "Upgrade";
  const upgrade = joinValue(req.headers.upgrade);
  if (upgrade !== undefined) headers.upgrade = upgrade;
  headers["x-forwarded-for"] = appendList(joinValue(req.headers["x-forwarded-for"]), String(req.socket.remoteAddress));
  return headers;
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function errnoOf(err) {
  if (err instanceof Error) {
    const code = /** @type {NodeJS.ErrnoException} */ (err).code;
    return String(code ?? err.message);
  }
  return "error";
}

/** Directories whose filenames carry a content hash and are safe to cache forever. */
const IMMUTABLE_PATH_PREFIXES = ["/assets/", "/dist/", "/static/", "/vendor/", "/favicon"];

/** Query parameter names whose values look like content hashes (e.g. `?rev=7eb52632`). */
const HASH_QUERY_PARAMS = new Set(["rev", "v", "hash", "h", "checksum"]);
const HASH_QUERY_VALUE = /^[0-9a-f]{8,}$/i;

/**
 * Does the request URL carry a content-hash query parameter (e.g. `?rev=<hash>`)?
 * The full URL — query included — is the cache key, so a changed hash yields a
 * new URL and the old immutable entry can never shadow the new content.
 *
 * @param {IncomingMessage} req
 * @returns {boolean}
 */
function hasHashQueryParam(req) {
  const query = (req.url ?? "").split("?")[1];
  if (query === undefined) return false;
  for (const pair of query.split("&")) {
    const eq = pair.indexOf("=");
    const name = eq === -1 ? pair : pair.slice(0, eq);
    const value = eq === -1 ? "" : pair.slice(eq + 1);
    if (HASH_QUERY_PARAMS.has(name.toLowerCase()) && HASH_QUERY_VALUE.test(value)) return true;
  }
  return false;
}

/**
 * Decide the Cache-Control policy a proxied response should carry.
 *
 * The upstream DSH web server sends no cache headers at all, so browsers
 * re-fetch every JS/CSS asset on each visit. HTML and anything dynamic stays
 * no-store; hash-addressed static assets (hash-named paths or `?rev=<hash>`
 * query params) become immutable — the hash is part of the cache key, so an
 * upstream update ships a new URL and takes effect immediately; other static
 * files get a short revalidation window. Upstream policies are overridden only
 * for hash-addressed assets (to defeat pointless `no-cache` on `?rev=` URLs);
 * otherwise they pass through untouched.
 *
 * @param {IncomingMessage} req
 * @param {string} contentType
 * @returns {string | undefined}
 */
function cacheControlFor(req, contentType) {
  if (req.method !== "GET" && req.method !== "HEAD") return undefined;
  if (contentType.includes("text/html")) return "no-store";
  const ct = contentType.split(";")[0].trim().toLowerCase();
  const staticLike = /^(?:text\/css|application\/javascript|text\/javascript|image\/|font\/|audio\/|video\/|application\/wasm|application\/manifest\+json)/.test(ct)
    || ct === "application/json"
    || /\.(?:css|js|mjs|json|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|eot|map|wasm|webmanifest)$/i.test(req.url ?? "");
  if (!staticLike) return undefined;
  if (IMMUTABLE_PATH_PREFIXES.some((prefix) => (req.url ?? "/").startsWith(prefix)) || hasHashQueryParam(req)) {
    return "public, max-age=31536000, immutable";
  }
  return "public, max-age=300";
}

/**
 * @param {URL} target
 * @param {object} options
 * @param {string} options.cookieName
 * @param {((req: IncomingMessage, err: unknown) => void) | undefined} [options.onError]
 * @returns {(req: IncomingMessage, res: ServerResponse) => void}
 */
export function createHttpForwarder(target, { cookieName, onError }) {
  const transport = target.protocol === "https:" ? https : http;
  const agent = new transport.Agent({ keepAlive: true, maxSockets: 64 });
  return function forward(req, res) {
    const proto = req.socket instanceof tls.TLSSocket ? "https" : "http";
    const headers = forwardRequestHeaders(req, { target, cookieName, proto });
    const upstream = transport.request(
      {
        hostname: target.hostname,
        port: target.port || (target.protocol === "https:" ? 443 : 80),
        method: req.method,
        path: req.url,
        headers,
        agent,
      },
      (up) => {
        /** @type {import("node:http").OutgoingHttpHeaders} */
        const outHeaders = {};
        for (const [name, value] of Object.entries(up.headers)) {
          if (HOP_BY_HOP.has(name)) continue;
          outHeaders[name] = value;
        }
        const hashAddressed = hasHashQueryParam(req)
          || IMMUTABLE_PATH_PREFIXES.some((prefix) => (req.url ?? "/").startsWith(prefix));
        if ((outHeaders["cache-control"] === undefined && outHeaders.etag === undefined) || hashAddressed) {
          const cacheControl = cacheControlFor(req, String(up.headers["content-type"] ?? ""));
          if (cacheControl !== undefined && (up.statusCode ?? 502) < 400) outHeaders["cache-control"] = cacheControl;
        }
        res.writeHead(up.statusCode ?? 502, outHeaders);
        up.pipe(res);
        res.on("close", () => up.destroy());
      },
    );
    upstream.on("error", (err) => {
      if (res.headersSent) {
        res.destroy(err instanceof Error ? err : undefined);
      } else {
        onError?.(req, err);
        res.writeHead(502, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
        res.end(`dsh-gateway: upstream unreachable (${errnoOf(err)})`);
      }
    });
    req.on("aborted", () => upstream.destroy());
    req.pipe(upstream);
  };
}

/**
 * @param {URL} target
 * @returns {net.Socket}
 */
function openUpstreamSocket(target) {
  const port = Number(target.port) || (target.protocol === "https:" ? 443 : 80);
  if (target.protocol === "https:") {
    return tls.connect({ host: target.hostname, port, servername: target.hostname });
  }
  return net.connect({ host: target.hostname, port });
}

/**
 * @param {URL} target
 * @param {object} options
 * @param {string} options.cookieName
 * @param {((req: IncomingMessage, err: unknown) => void) | undefined} [options.onError]
 * @returns {(req: IncomingMessage, socket: net.Socket, head: Buffer) => void}
 */
export function createUpgradeTunneler(target, { cookieName, onError }) {
  return function tunnel(req, socket, head) {
    socket.setNoDelay(true);
    const upstream = openUpstreamSocket(target);
    let established = false;
    const fail = (/** @type {unknown} */ err) => {
      if (established) {
        socket.destroy();
        upstream.destroy();
        return;
      }
      onError?.(req, err);
      const reason = errnoOf(err).replace(/[\r\n]/g, " ");
      socket.end(`HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\nX-Gateway-Error: ${reason}\r\n\r\n`);
      upstream.destroy();
    };
    upstream.on("error", fail);
    socket.on("error", () => upstream.destroy());
    upstream.on("close", () => socket.destroy());
    socket.on("close", () => upstream.destroy());
    upstream.on("connect", () => {
      const headers = forwardUpgradeHeaders(req, { target, cookieName });
      let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
      for (const [name, value] of Object.entries(headers)) {
        raw += `${name}: ${value}\r\n`;
      }
      raw += "\r\n";
      upstream.write(raw, () => {
        if (head.length > 0) upstream.write(head);
      });
      established = true;
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
  };
}
