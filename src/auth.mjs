import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/** @typedef {import("node:http").IncomingMessage} IncomingMessage */

const KEY_INFO = "dsh-gateway-session-v1";

/**
 * @param {string} password
 * @returns {Buffer}
 */
export function sessionKey(password) {
  return scryptSync(password, KEY_INFO, 32);
}

/**
 * @param {Buffer} key
 * @param {number} ttlMs
 * @param {number} [now]
 * @returns {string}
 */
export function signSession(key, ttlMs, now = Date.now()) {
  const exp = now + ttlMs;
  const mac = createHmac("sha256", key).update(String(exp)).digest("base64url");
  return `${exp}.${mac}`;
}

/**
 * @param {Buffer} key
 * @param {string | undefined} token
 * @param {number} [now]
 * @returns {boolean}
 */
export function verifySession(key, token, now = Date.now()) {
  if (typeof token !== "string") return false;
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const expStr = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  if (!/^\d{1,15}$/.test(expStr)) return false;
  const exp = Number(expStr);
  if (exp < now) return false;
  const expect = createHmac("sha256", key).update(expStr).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expect);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * @param {IncomingMessage} req
 * @param {string} password
 * @returns {boolean}
 */
export function bearerPassword(req, password) {
  const header = req.headers.authorization;
  if (typeof header !== "string") return false;
  const space = header.indexOf(" ");
  if (space < 0) return false;
  const scheme = header.slice(0, space).toLowerCase();
  if (scheme !== "bearer") return false;
  return safeEqual(header.slice(space + 1).trim(), password);
}

/**
 * @param {string | undefined} header
 * @returns {Record<string, string>}
 */
export function parseCookies(header) {
  /** @type {Record<string, string>} */
  const out = {};
  if (typeof header !== "string") return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

/**
 * @param {number} max
 * @param {number} windowMs
 * @returns {(id: string) => boolean}
 */
export function createRateLimiter(max, windowMs) {
  /** @type {Map<string, { count: number, resetAt: number }>} */
  const buckets = new Map();
  return (id) => {
    const now = Date.now();
    const bucket = buckets.get(id);
    if (bucket === undefined || now > bucket.resetAt) {
      buckets.set(id, { count: 1, resetAt: now + windowMs });
      return true;
    }
    bucket.count += 1;
    return bucket.count <= max;
  };
}

/**
 * @param {unknown} raw
 * @returns {string}
 */
export function validNextPath(raw) {
  if (typeof raw !== "string" || raw.length === 0) return "/";
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  if (/[\r\n]/.test(raw)) return "/";
  return raw;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

/** @returns {string} */
export function randomPassword() {
  return randomBytes(18).toString("base64url");
}
