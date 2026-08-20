import { escapeHtml } from "./auth.mjs";

/**
 * @param {object} options
 * @param {string} options.next
 * @param {string | null} options.error
 * @param {string} options.cookieName
 * @returns {string}
 */
export function loginPage({ next, error, cookieName }) {
  const action = `/_gw/login?next=${encodeURIComponent(next)}`;
  const message = error ? `<div class="error">${escapeHtml(error)}</div>` : "";
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>DSH Gateway</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
  <form class="card" method="post" action="${escapeHtml(action)}">
    <h1>DSH Gateway</h1>
    <p class="sub">此网关保护本机运行的 DSH Web UI，请输入访问密码。</p>
    ${message}
    <label for="password">Password / 访问密码</label>
    <input id="password" name="password" type="password" autocomplete="current-password" autofocus required>
    <button type="submit">Unlock / 解锁</button>
    <footer>${escapeHtml(cookieName)} session · dsh-gateway</footer>
  </form>
</body>
</html>`;
}

/** @returns {string} */
const PAGE_STYLE = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; }
  body {
    min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #0b0d12; color: #e7eaf0;
    font: 15px/1.6 ui-sans-serif, system-ui, "PingFang SC", "Microsoft YaHei", sans-serif;
  }
  .card {
    width: min(92vw, 360px); padding: 32px 28px; border-radius: 14px;
    background: #141822; border: 1px solid #262c3a;
    box-shadow: 0 12px 40px rgba(0, 0, 0, .45);
  }
  h1 { font-size: 17px; font-weight: 600; margin-bottom: 4px; }
  p.sub { color: #8b93a7; font-size: 13px; margin-bottom: 22px; }
  label { display: block; font-size: 13px; color: #8b93a7; margin-bottom: 6px; }
  input[type=password] {
    width: 100%; padding: 10px 12px; border-radius: 8px; margin-bottom: 16px;
    border: 1px solid #2c3344; background: #0e1119; color: #e7eaf0; outline: none;
  }
  input[type=password]:focus { border-color: #4d7cfe; }
  button {
    width: 100%; padding: 10px 0; border: 0; border-radius: 8px; cursor: pointer;
    background: linear-gradient(135deg, #4d6bfe, #3b5bfd); color: #fff; font-size: 14px; font-weight: 600;
  }
  button:hover { filter: brightness(1.08); }
  .error { color: #ff7d7d; font-size: 13px; margin-bottom: 14px; }
  footer { margin-top: 20px; text-align: center; color: #596074; font-size: 12px; }
`;

export const LOGOUT_PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>Bye · dsh-gateway</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0b0d12;color:#e7eaf0;font:15px/1.6 ui-sans-serif,system-ui,sans-serif}</style>
</head><body><div>已退出登录 · signed out</div></body></html>`;
