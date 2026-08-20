import http from "node:http";
import https from "node:https";
import net from "node:net";
import {
  bearerPassword,
  createRateLimiter,
  parseCookies,
  safeEqual,
  signSession,
  validNextPath,
  verifySession,
} from "./auth.mjs";
import { LOGOUT_PAGE, loginPage } from "./login-page.mjs";
import { createHttpForwarder, createUpgradeTunneler } from "./proxy.mjs";

/** @typedef {import("node:http").IncomingMessage} IncomingMessage */
/** @typedef {import("node:http").ServerResponse} ServerResponse */
/** @typedef {import("node:stream").Duplex} Duplex */

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

/**
 * @typedef {object} GatewayOptions
 * @property {URL} target
 * @property {string} password
 * @property {Buffer} sessionKey
 * @property {number} sessionTtlMs
 * @property {string} [cookieName]
 * @property {Buffer} [tlsCert]
 * @property {Buffer} [tlsKey]
 * @property {(level: string, message: string) => void} [log]
 */

const LOGIN_PATH = "/_gw/login";
const LOGOUT_PATH = "/_gw/logout";
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;
const LOGIN_BODY_LIMIT = 8 * 1024;

export const DEFAULT_COOKIE_NAME = "__dshgw";

/**
 * @param {IncomingMessage} req
 * @param {number} limit
 * @returns {Promise<Buffer>}
 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    /** @type {Buffer[]} */
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * @param {IncomingMessage} req
 * @returns {string}
 */
function clientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) return forwarded.split(",")[0].trim();
  return String(req.socket.remoteAddress ?? "unknown");
}

/**
 * @param {IncomingMessage} req
 * @returns {boolean}
 */
function wantsHtml(req) {
  const accept = req.headers.accept ?? "";
  return typeof accept === "string" && accept.includes("text/html");
}

/**
 * @param {GatewayOptions} options
 * @returns {http.Server | https.Server}
 */
export function createGateway(options) {
  const { target, password, sessionTtlMs, log = () => {} } = options;
  const cookieName = options.cookieName ?? DEFAULT_COOKIE_NAME;
  const secureCookie = Boolean(options.tlsCert && options.tlsKey);
  const key = options.sessionKey;
  const allowLogin = createRateLimiter(LOGIN_MAX_ATTEMPTS, LOGIN_WINDOW_MS);
  const forward = createHttpForwarder(target, {
    cookieName,
    onError: (req, err) => log("warn", `upstream ${req.method} ${req.url} -> ${errnoOf(err)}`),
  });
  const tunnel = createUpgradeTunneler(target, {
    cookieName,
    onError: (req, err) => log("warn", `upstream upgrade ${req.url} -> ${errnoOf(err)}`),
  });

  /**
   * @param {string} token
   * @param {number} maxAgeSeconds
   * @returns {string}
   */
  const sessionCookie = (token, maxAgeSeconds) => {
    const parts = [`${cookieName}=${token}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAgeSeconds}`];
    if (secureCookie) parts.push("Secure");
    return parts.join("; ");
  };

  /** @param {IncomingMessage} req @returns {boolean} */
  const isAuthed = (req) => {
    const cookies = parseCookies(typeof req.headers.cookie === "string" ? req.headers.cookie : undefined);
    if (verifySession(key, cookies[cookieName])) return true;
    return bearerPassword(req, password);
  };

  /**
   * @param {IncomingMessage} req
   * @param {ServerResponse} res
   */
  const unauthorized = (req, res) => {
    if (req.method === "GET" && wantsHtml(req)) {
      res.writeHead(302, { location: `${LOGIN_PATH}?next=${encodeURIComponent(req.url ?? "/")}`, "cache-control": "no-store" });
      res.end();
      return;
    }
    res.writeHead(401, { "www-authenticate": 'Bearer realm="dsh-gateway"', "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify({ error: "unauthorized" }));
  };

  /**
   * @param {IncomingMessage} req
   * @param {ServerResponse} res
   * @param {URL} url
   */
  const handleLogin = async (req, res, url) => {
    const next = validNextPath(url.searchParams.get("next"));
    if (req.method === "GET") {
      if (isAuthed(req)) {
        res.writeHead(303, { location: next });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(loginPage({ next, error: null, cookieName }));
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "GET, POST" });
      res.end();
      return;
    }
    if (!allowLogin(clientIp(req))) {
      res.writeHead(429, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "retry-after": "600" });
      res.end(loginPage({ next, error: "尝试次数过多，请 10 分钟后再试 / too many attempts, retry later", cookieName }));
      return;
    }
    let submitted = "";
    try {
      const body = await readBody(req, LOGIN_BODY_LIMIT);
      submitted = new URLSearchParams(body.toString("utf8")).get("password") ?? "";
    } catch {
      res.writeHead(413, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(loginPage({ next, error: "请求体过大 / body too large", cookieName }));
      return;
    }
    if (!safeEqual(submitted, password)) {
      res.writeHead(401, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(loginPage({ next, error: "密码错误 / wrong password", cookieName }));
      return;
    }
    const token = signSession(key, sessionTtlMs);
    log("info", `login ok from ${clientIp(req)}`);
    res.writeHead(303, { location: next, "set-cookie": sessionCookie(token, Math.floor(sessionTtlMs / 1000)), "cache-control": "no-store" });
    res.end();
  };

  /**
   * @param {IncomingMessage} req
   * @param {ServerResponse} res
   */
  const handleLogout = (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST" });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "set-cookie": sessionCookie("", 0) });
    res.end(LOGOUT_PAGE);
  };

  /**
   * @param {IncomingMessage} req
   * @param {ServerResponse} res
   */
  const handler = async (req, res) => {
    let url;
    try {
      url = new URL(req.url ?? "/", "http://gateway.invalid");
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    if (url.pathname === LOGIN_PATH) {
      await handleLogin(req, res, url);
      return;
    }
    if (url.pathname === LOGOUT_PATH) {
      handleLogout(req, res);
      return;
    }
    if (url.pathname === "/_gw" || url.pathname === "/_gw/") {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("dsh-gateway: reserved namespace\n");
      return;
    }
    if (!isAuthed(req)) {
      log("info", `deny ${req.method} ${req.url} from ${clientIp(req)}`);
      unauthorized(req, res);
      return;
    }
    res.on("close", () => log("info", `${req.method} ${req.url} ${res.statusCode} ${clientIp(req)}`));
    forward(req, res);
  };

  /**
   * @param {IncomingMessage} req
   * @param {Duplex} socket
   * @param {Buffer} head
   */
  const onUpgrade = (req, socket, head) => {
    if (!isAuthed(req)) {
      log("info", `deny upgrade ${req.url} from ${clientIp(req)}`);
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    log("info", `upgrade ${req.url} ${clientIp(req)}`);
    tunnel(req, /** @type {net.Socket} */ (socket), head);
  };

  /** @type {import("node:http").RequestListener} */
  const listener = (req, res) => {
    handler(req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        res.end("dsh-gateway: internal error");
      } else {
        res.destroy();
      }
    });
  };

  const server = options.tlsCert && options.tlsKey
    ? https.createServer({ cert: options.tlsCert, key: options.tlsKey }, listener)
    : http.createServer(listener);
  server.on("upgrade", onUpgrade);
  server.keepAliveTimeout = 75_000;
  server.requestTimeout = 1_800_000;
  return server;
}
