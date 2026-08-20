import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { randomPassword } from "./auth.mjs";

/**
 * @returns {string}
 */
export function secretFilePath() {
  return path.join(homedir(), ".dsh-gateway", "secret");
}

/**
 * Resolve the gateway password: explicit value, then DSH_GATEWAY_PASSWORD,
 * then the persisted secret file (auto-generated on first run, mode 0600).
 * @param {string | undefined} explicit
 * @returns {{ password: string, generated: boolean, file: string }}
 */
export function resolveStoredPassword(explicit) {
  if (typeof explicit === "string" && explicit.length > 0) return { password: explicit, generated: false, file: secretFilePath() };
  const env = process.env.DSH_GATEWAY_PASSWORD;
  if (env !== undefined && env !== "") return { password: env, generated: false, file: secretFilePath() };
  const file = secretFilePath();
  if (existsSync(file) && statSync(file).isFile()) {
    const secret = readFileSync(file, "utf8").replace(/\r?\n$/, "");
    if (secret.length > 0) return { password: secret, generated: false, file };
  }
  const secret = randomPassword();
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, secret + "\n", { mode: 0o600 });
  chmodSync(file, 0o600);
  return { password: secret, generated: true, file };
}
