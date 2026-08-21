import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import net from "node:net";
import { createGateway } from "../src/server.mjs";
import { sessionKey } from "../src/auth.mjs";

const PASSWORD = "test-password-123";
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
let lastUpgradeHeaders = null;

function serverTextFrame(text) {
  const payload = Buffer.from(text, "utf8");
  return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
}

function clientTextFrame(text) {
  const payload = Buffer.from(text, "utf8");
  const mask = randomBytes(4);
  const masked = Buffer.allocUnsafe(payload.length);
  for (let i = 0; i < payload.length; i += 1) masked[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked]);
}

function parseFrame(buffer, expectMasked) {
  assert.ok(buffer.length >= 2, "frame too short");
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    length = Number(buffer.readBigUInt64BE(offset));
    offset += 8;
  }
  assert.equal(masked, expectMasked, "mask flag mismatch");
  let payload;
  if (masked) {
    const mask = buffer.subarray(offset, offset + 4);
    offset += 4;
    payload = Buffer.allocUnsafe(length);
    for (let i = 0; i < length; i += 1) payload[i] = buffer[offset + i] ^ mask[i % 4];
  } else {
    payload = buffer.subarray(offset, offset + length);
  }
  return { opcode, payload };
}

const upstream = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/echo") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        host: req.headers.host,
        origin: req.headers.origin ?? null,
        cookie: req.headers.cookie ?? null,
        xff: req.headers["x-forwarded-for"] ?? null,
        url: req.url,
      }),
    );
    return;
  }
  if (req.method === "GET" && req.url === "/api/stream") {
    res.writeHead(200, { "content-type": "text/plain" });
    let i = 0;
    const timer = setInterval(() => {
      i += 1;
      res.write(`chunk-${i}\n`);
      if (i === 3) {
        res.end();
        clearInterval(timer);
      }
    }, 30);
    return;
  }
  if (req.method === "GET" && req.url === "/asset.js") {
    res.writeHead(200, { "content-type": "application/javascript" });
    res.end("console.log(1)");
    return;
  }
  if (req.method === "GET" && req.url === "/assets/app.abc123.js") {
    res.writeHead(200, { "content-type": "application/javascript" });
    res.end("console.log(2)");
    return;
  }
  if (req.method === "GET" && req.url === "/page.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<html></html>");
    return;
  }
  if (req.method === "GET" && req.url === "/_last-upgrade") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(lastUpgradeHeaders ?? {}));
    return;
  }
  res.writeHead(404);
  res.end();
});

upstream.on("upgrade", (req, socket) => {
  lastUpgradeHeaders = {
    host: req.headers.host,
    origin: req.headers.origin ?? null,
    cookie: req.headers.cookie ?? null,
    path: req.url,
  };
  const accept = createHash("sha1").update(String(req.headers["sec-websocket-key"]) + GUID).digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.write(serverTextFrame("welcome"));
  socket.on("data", (buf) => {
    try {
      const { opcode, payload } = parseFrame(buf, true);
      if (opcode === 1) socket.write(serverTextFrame(payload.toString("utf8")));
    } catch {
      socket.destroy();
    }
  });
});

function rawUpgrade(port, pathname, { cookie } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    const chunks = [];
    let head = null;
    socket.on("error", reject);
    socket.on("data", (buf) => {
      if (head === null) {
        chunks.push(buf);
        const joined = Buffer.concat(chunks);
        const marker = joined.indexOf("\r\n\r\n");
        if (marker >= 0) {
          head = joined.subarray(0, marker).toString("utf8");
          const rest = joined.subarray(marker + 4);
          socket.removeAllListeners("data");
          resolve({ socket, head, pending: rest });
        }
        return;
      }
    });
    socket.on("connect", () => {
      const key = randomBytes(16).toString("base64");
      let raw = `GET ${pathname} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nOrigin: http://127.0.0.1:${port}\r\n`;
      if (cookie) raw += `Cookie: ${cookie}\r\n`;
      raw += "\r\n";
      socket.write(raw);
    });
  });
}

function readFrame(socket, pending) {
  return new Promise((resolve, reject) => {
    const buffers = [pending];
    const tryParse = () => {
      const buf = Buffer.concat(buffers);
      if (buf.length < 2) return false;
      let length = buf[1] & 0x7f;
      let need = 2;
      if (length === 126) need += 2;
      else if (length === 127) need += 8;
      length = length < 126 ? length : length === 126 ? buf.readUInt16BE(2) : Number(buf.readBigUInt64BE(2));
      need += length;
      if (buf.length < need) return false;
      socket.removeAllListeners("data");
      resolve({ frame: parseFrame(buf.subarray(0, need), false), rest: buf.subarray(need) });
      return true;
    };
    if (tryParse()) return;
    socket.on("data", (buf) => {
      buffers.push(buf);
      tryParse();
    });
    socket.on("error", reject);
    socket.on("close", () => reject(new Error("socket closed while waiting for frame")));
  });
}

async function main() {
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = upstream.address().port;
  const target = new URL(`http://127.0.0.1:${upstreamPort}`);
  const gateway = createGateway({
    target,
    password: PASSWORD,
    sessionKey: sessionKey(PASSWORD),
    sessionTtlMs: 3_600_000,
    log: () => {},
  });
  await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const port = gateway.address().port;
  const base = `http://127.0.0.1:${port}`;

  let step = 0;
  const ok = (name) => console.log(`ok ${++step} - ${name}`);

  const unauth = await fetch(base + "/", { redirect: "manual", headers: { accept: "text/html" } });
  assert.equal(unauth.status, 302);
  assert.match(unauth.headers.get("location") ?? "", /^\/_gw\/login\?next=/);
  ok("unauthenticated GET redirects to login");

  const loginPageResponse = await fetch(base + "/_gw/login?next=/");
  assert.equal(loginPageResponse.status, 200);
  assert.match(await loginPageResponse.text(), /<form/);
  ok("login page renders");

  const badLogin = await fetch(base + "/_gw/login?next=/", {
    method: "POST",
    body: new URLSearchParams({ password: "wrong" }),
    redirect: "manual",
  });
  assert.equal(badLogin.status, 401);
  ok("wrong password rejected with 401");

  const login = await fetch(base + "/_gw/login?next=/echo", {
    method: "POST",
    body: new URLSearchParams({ password: PASSWORD }),
    redirect: "manual",
  });
  assert.equal(login.status, 303);
  assert.equal(login.headers.get("location"), "/echo");
  const setCookie = login.headers.getSetCookie()[0];
  assert.match(setCookie, /__dshgw=\d+\./);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  const cookie = setCookie.split(";")[0];
  ok("login sets signed HttpOnly cookie and redirects to next");

  const evilLogin = await fetch(base + "/_gw/login?next=https%3A%2F%2Fevil.example", {
    method: "POST",
    body: new URLSearchParams({ password: PASSWORD }),
    redirect: "manual",
  });
  assert.equal(evilLogin.headers.get("location"), "/");
  ok("open-redirect guard on next parameter");

  const echoed = await fetch(base + "/echo", { headers: { cookie: `${cookie}; x=1` } });
  assert.equal(echoed.status, 200);
  const echo = await echoed.json();
  assert.equal(echo.host, `127.0.0.1:${upstreamPort}`);
  assert.equal(echo.origin, null);
  assert.equal(echo.cookie, "x=1");
  assert.match(echo.xff ?? "", /127\.0\.0\.1/);
  ok("proxied request looks local: Host rewritten, Origin stripped, gateway cookie withheld");

  const bearer = await fetch(base + "/echo", { headers: { authorization: `Bearer ${PASSWORD}` } });
  assert.equal(bearer.status, 200);
  ok("Bearer password accepted for programmatic access");

  const denied = await fetch(base + "/echo", { headers: { accept: "application/json" } });
  assert.equal(denied.status, 401);
  assert.match(denied.headers.get("www-authenticate") ?? "", /Bearer/);
  ok("non-browser unauthenticated request gets 401 + WWW-Authenticate");

  const stream = await fetch(base + "/api/stream", { headers: { cookie } });
  const streamText = await stream.text();
  assert.equal(streamText, "chunk-1\nchunk-2\nchunk-3\n");
  ok("streaming response passes through unbuffered");

  const hashedAsset = await fetch(base + "/assets/app.abc123.js", { headers: { cookie } });
  assert.equal(hashedAsset.headers.get("cache-control"), "public, max-age=31536000, immutable");
  ok("hash-path static asset gets immutable cache policy");

  const plainAsset = await fetch(base + "/asset.js", { headers: { cookie } });
  assert.equal(plainAsset.headers.get("cache-control"), "public, max-age=300");
  ok("other static files get short revalidate window");

  const htmlPage = await fetch(base + "/page.html", { headers: { cookie } });
  assert.equal(htmlPage.headers.get("cache-control"), "no-store");
  ok("HTML responses stay no-store");

  const logout = await fetch(base + "/_gw/logout", { method: "POST", headers: { cookie }, redirect: "manual" });
  const clearCookie = logout.headers.getSetCookie()[0];
  assert.match(clearCookie, /Max-Age=0/);
  ok("logout clears the session cookie");

  const wsDenied = await rawUpgrade(port, "/api/events.mux", {});
  assert.match(wsDenied.head, /^HTTP\/1\.1 401/);
  wsDenied.socket.destroy();
  ok("WebSocket upgrade without session rejected");

  const ws = await rawUpgrade(port, "/api/events.mux", { cookie });
  assert.match(ws.head, /^HTTP\/1\.1 101/);
  assert.match(ws.head, /sec-websocket-accept:/i);
  const hello = await readFrame(ws.socket, ws.pending);
  assert.equal(hello.frame.payload.toString("utf8"), "welcome");
  ok("WebSocket tunnel completes handshake and relays server frame");

  ws.socket.write(clientTextFrame("hello gateway"));
  const echoedFrame = await readFrame(ws.socket, hello.rest);
  assert.equal(echoedFrame.frame.payload.toString("utf8"), "hello gateway");
  ok("WebSocket client frames tunnel back (echo round-trip)");

  const upstreamSaw = await (await fetch(`http://127.0.0.1:${upstreamPort}/_last-upgrade`)).json();
  assert.equal(upstreamSaw.host, `127.0.0.1:${upstreamPort}`);
  assert.equal(upstreamSaw.origin, null);
  assert.equal(upstreamSaw.path, "/api/events.mux");
  ok("upgrade request reaches DSH-looking local: Host rewritten, Origin stripped");

  ws.socket.destroy();
  gateway.close();
  upstream.close();
  console.log(`\nall ${step} smoke tests passed`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
