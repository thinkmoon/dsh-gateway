import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { createGateway } from "./server.mjs";
import { sessionKey } from "./auth.mjs";
import { resolveStoredPassword } from "./password.mjs";

const VERSION = "0.1.0";

const USAGE = `dsh-gateway ${VERSION} — authenticated reverse proxy for the DSH web GUI

Usage:
  dsh-gateway --target <127.0.0.1:PORT> [options]

Every request (HTTP streams and WebSocket upgrades) is forwarded to the local
DSH server with Host rewritten to the target and Origin stripped, so DSH's
loopback trust fence sees plain local traffic — remote sessions behave
exactly like local ones. A password gate sits in front of everything.

Options:
  --target <url|host:port|port>  local DSH address (default env DSH_GATEWAY_TARGET)
                                 e.g. 7777, 127.0.0.1:7777, http://127.0.0.1:7777
  --port <n>                     gateway listen port (default 8642)
  --host <addr>                  gateway bind address (default 0.0.0.0)
  --password <secret>            access password (default env DSH_GATEWAY_PASSWORD,
                                 then --password-file, then ~/.dsh-gateway/secret
                                 which is auto-generated on first run)
  --password-file <path>         read password from this file
  --session-ttl <dur>            login session lifetime, e.g. 12h / 7d (default 7d)
  --cert <path> --key <path>     serve HTTPS directly (otherwise run behind a
                                 TLS terminator such as cloudflared or caddy)
  -q, --quiet                    suppress access log
  -h, --help                     show this help
  -V, --version                  show version

Examples:
  dsh web --port 7777 &                # DSH stays on loopback, as it insists
  dsh-gateway --target 7777            # gateway on 0.0.0.0:8642 with password auth
  dsh-gateway --target 7777 --port 443 --cert c.pem --key k.pem
`;

/**
 * @param {string} raw
 * @returns {number}
 */
function parseDuration(raw) {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/i.exec(raw.trim());
  if (match === null) throw new Error(`invalid duration: ${raw}`);
  const value = Number(match[1]);
  const unit = (match[2] ?? "ms").toLowerCase();
  const factors = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  const factor = factors[/** @type {keyof typeof factors} */ (unit)];
  return Math.round(value * factor);
}

/**
 * @param {string} raw
 * @returns {URL}
 */
function normalizeTarget(raw) {
  let candidate = raw.trim();
  if (/^\d+$/.test(candidate)) candidate = `127.0.0.1:${candidate}`;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) candidate = `http://${candidate}`;
  const url = new URL(candidate);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`target must be http(s), got ${url.protocol}`);
  if (!url.port && url.protocol === "http:") throw new Error("target needs an explicit port");
  return url;
}

/**
 * @typedef {Record<string, string | boolean | undefined>} ArgValues
 */

/**
 * @param {ArgValues} args
 * @returns {{ password: string, generated: boolean, file?: string }}
 */
function resolvePassword(args) {
  if (typeof args.password === "string" && args.password.length > 0) return { password: args.password, generated: false };
  const env = process.env.DSH_GATEWAY_PASSWORD;
  if (env !== undefined && env !== "") return { password: env, generated: false };
  if (typeof args["password-file"] === "string") {
    const secret = readFileSync(args["password-file"], "utf8").replace(/\r?\n$/, "");
    if (secret.length === 0) throw new Error(`password file is empty: ${args["password-file"]}`);
    return { password: secret, generated: false };
  }
  return resolveStoredPassword(undefined);
}

/**
 * @param {string[]} argv
 * @returns {Promise<void>}
 */
export async function main(argv) {
  /** @type {ArgValues} */
  let args;
  try {
    const parsed = parseArgs({
      args: argv,
      options: {
        target: { type: "string" },
        host: { type: "string" },
        port: { type: "string" },
        password: { type: "string" },
        "password-file": { type: "string" },
        "session-ttl": { type: "string" },
        cert: { type: "string" },
        key: { type: "string" },
        quiet: { type: "boolean", short: "q" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "V" },
      },
    });
    args = /** @type {ArgValues} */ (parsed.values);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  if (args.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (args.version) {
    process.stdout.write(VERSION + "\n");
    return;
  }
  const rawTarget = typeof args.target === "string" ? args.target : process.env.DSH_GATEWAY_TARGET;
  if (rawTarget === undefined) {
    process.stderr.write(`error: --target is required (e.g. --target 7777 for your "dsh web --port 7777")\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  /** @type {URL} */
  let target;
  try {
    target = normalizeTarget(rawTarget);
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 2;
    return;
  }
  let sessionTtlMs = 7 * 86_400_000;
  if (typeof args["session-ttl"] === "string") {
    try {
      sessionTtlMs = parseDuration(args["session-ttl"]);
    } catch (err) {
      process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 2;
      return;
    }
    if (sessionTtlMs < 30_000) {
      process.stderr.write("error: --session-ttl must be at least 30s\n");
      process.exitCode = 2;
      return;
    }
  }
  const listenPort = typeof args.port === "string" ? Number(args.port) : 8642;
  if (!Number.isInteger(listenPort) || listenPort < 0 || listenPort > 65535) {
    process.stderr.write(`error: --port must be an integer in [0, 65535], got ${String(args.port)}\n`);
    process.exitCode = 2;
    return;
  }
  const listenHost = typeof args.host === "string" ? args.host : "0.0.0.0";
  /** @type {{ password: string, generated: boolean, file?: string }} */
  let passwordInfo;
  try {
    passwordInfo = resolvePassword(args);
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 2;
    return;
  }
  /** @param {string | undefined} p @returns {Buffer | undefined} */
  const readOptionally = (p) => (p === undefined ? undefined : readFileSync(p));
  const log = args.quiet === true ? () => {} : (/** @type {string} */ level, /** @type {string} */ message) => process.stderr.write(`[${new Date().toISOString()}] ${level} ${message}\n`);

  const server = createGateway({
    target,
    password: passwordInfo.password,
    sessionKey: sessionKey(passwordInfo.password),
    sessionTtlMs,
    tlsCert: readOptionally(typeof args.cert === "string" ? args.cert : undefined),
    tlsKey: readOptionally(typeof args.key === "string" ? args.key : undefined),
    log,
  });
  server.listen(listenPort, listenHost, () => {
    const address = server.address();
    const tls = Boolean(args.cert && args.key);
    const shown = typeof address === "object" && address !== null ? address.port : listenPort;
    process.stderr.write(`dsh-gateway ${VERSION} listening on ${listenHost}:${shown} (${tls ? "https" : "http"}) -> ${target.origin}\n`);
    if (passwordInfo.generated) {
      process.stderr.write(`generated password: ${passwordInfo.password}\n(stored at ${passwordInfo.file}; pass --password or DSH_GATEWAY_PASSWORD to override)\n`);
    }
    process.stderr.write(`DSH must be running on ${target.origin} (e.g. "dsh web --port ${target.port}")\n`);
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
