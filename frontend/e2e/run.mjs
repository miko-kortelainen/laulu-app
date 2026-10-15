import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const frontend = fileURLToPath(new URL("../", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "musical-auth-e2e-"));
const target = process.argv[2];
if (!["auth", "chat", "audio-player", "songs", "operations", "pricing", "all"].includes(target)) throw new Error("unknown E2E target");
const wav = Buffer.alloc(44 + 16000);
wav.write("RIFF", 0);
wav.writeUInt32LE(wav.length - 8, 4);
wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24);
wav.writeUInt32LE(16000, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write("data", 36);
wav.writeUInt32LE(16000, 40);
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  if (req.method === "GET" && pathname === "/api/operations") {
    res.setHeader("Content-Type", "application/json");
    return res.end('{"operations":[]}');
  }
  if (req.method === "POST" && pathname === "/api/session/end") {
    res.writeHead(204);
    return res.end();
  }
  if (req.method === "GET" && /^\/api\/(audio|music)\/.+\.(wav|mp3)$/.test(pathname)) {
    res.setHeader("Content-Type", "audio/wav");
    return res.end(wav);
  }
  const path = resolve(directory, pathname === "/" ? "index.html" : `.${pathname}`);
  if (!path.startsWith(`${directory}/`)) { res.writeHead(404); return res.end(); }
  let content = await readFile(path).catch(() => undefined);
  if (!content && req.method === "GET" && !extname(pathname) && !/^\/(api|auth)\//.test(pathname)) {
    content = await readFile(join(directory, "index.html"));
  }
  if (!content) { res.writeHead(404); return res.end(); }
  if ((target === "pricing" || target === "all") && (pathname === "/pricing" || pathname === "/")) {
    content = Buffer.from(content.toString().replace("</head>", `<script>
      window.checkoutRequests = [];
      window.previewRequests = [];
      window.billingRequests = [];
      const originalFetch = window.fetch;
      window.fetch = (...args) => {
        if (String(args[0]).includes('/api/billing/') && args[1]?.body) window.billingRequests.push(JSON.parse(args[1].body));
        return originalFetch(...args);
      };
      window.PaddleBillingV1 = {
        Initialized: false, Environment: { set() {} },
        Initialize(options) { this.Initialized = true; this.callback = options.eventCallback; },
        Update(options) { this.callback = options.eventCallback; },
        PricePreview({ items, currencyCode }) { window.previewRequests.push({ currencyCode }); return Promise.resolve({ data: { details: { lineItems: items.map(item => ({
          price: { id: item.priceId, status: 'active', billingCycle: {
            interval: ['pri_01m50px1szmdvk7ytv5sejdzgr', 'pri_01m50pzdw9pfn9c5ss1kehnv9n', 'pri_01m50q3rnc8na58rv1s4n9yay9'].includes(item.priceId) ? 'year' : 'month', frequency: 1 }, trialPeriod: null },
          product: { status: 'active' }, formattedTotals: { total: item.priceId.startsWith('pri_01m50') ? '$90.00' : '$9.00' }
        })) } } }); },
        Checkout: { open(options) { window.checkoutRequests.push(options); }, close() {} }
      };
    </script></head>`));
  }
  res.setHeader("Content-Type", { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" }[extname(path) || ".html"] ?? "application/octet-stream");
  res.end(content);
});

try {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const build = await exec(process.execPath, [join(frontend, "node_modules/vite/bin/vite.js"), "build", "--outDir", directory], {
    cwd: frontend, env: { ...process.env, VITE_SUPABASE_URL: url, VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_offline",
      VITE_TURNSTILE_SITE_KEY: target === "auth" ? "offline-site-key" : "",
      VITE_PADDLE_CLIENT_TOKEN: "test_offline",
      VITE_PADDLE_STARTER_PRICE_ID: "pri_01m4tvkjam9nptz0f1ngrbr9mj",
      VITE_PADDLE_PRO_PRICE_ID: "pri_01m4tvmm85j15s4vjd9ykmsa0d",
      VITE_PADDLE_ULTRA_PRICE_ID: "pri_01m4tvnr6xfnyk1nwtyt5vma9e",
      VITE_PADDLE_STARTER_ANNUAL_PRICE_ID: "pri_01m50px1szmdvk7ytv5sejdzgr",
      VITE_PADDLE_PRO_ANNUAL_PRICE_ID: "pri_01m50pzdw9pfn9c5ss1kehnv9n",
      VITE_PADDLE_ULTRA_ANNUAL_PRICE_ID: "pri_01m50q3rnc8na58rv1s4n9yay9" },
  });
  process.stdout.write(build.stdout);
  for (const name of target === "all" ? ["auth", "chat", "audio-player", "songs", "operations", "pricing"] : [target]) {
    const result = await exec(process.execPath, [join(frontend, `e2e/${name}.mjs`)], {
      cwd: frontend, env: { ...process.env, E2E_URL: url, E2E_AUTH_ORIGIN: url, E2E_DIST: directory,
        E2E_CAPTCHA: target === "auth" ? "1" : "" }, timeout: 240000, maxBuffer: 2 * 1024 * 1024,
    });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
  }
} finally {
  server.closeAllConnections();
  if (server.listening) await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
