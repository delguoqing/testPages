#!/usr/bin/env node
/**
 * Headless Chromium: collect console + in-page ring buffers, write JSON for agents/CI.
 *
 * Usage (from repo root or `web/`):
 *   cd web && npm install
 *   npx playwright install chromium   # optional if using --channel msedge|chrome
 *   npm run capture-console
 *   npm run capture-console -- --url http://127.0.0.1:8765/ --wait-ms 12000
 *
 * Default: ephemeral http://127.0.0.1:<port>/ serving `web/` (ESM + wasm need http origin).
 */
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mergeChromiumLaunchForWebGpu } from "./chromium-headless-webgpu-args.mjs";
import { startWebRootServer } from "./static-web-root-server.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.join(__dirname, "..");

function parseArgs(argv) {
  const out = {
    url: null,
    urlExplicit: false,
    waitMs: 8000,
    outFile: path.join(WEB_ROOT, "artifacts", "console-capture.json"),
    headless: true,
    /** When set, use installed browser (e.g. `msedge`, `chrome`) and skip Playwright’s bundled Chromium download. */
    channel: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url" && argv[i + 1]) {
      out.url = argv[++i];
      out.urlExplicit = true;
    } else if (a === "--wait-ms" && argv[i + 1]) {
      out.waitMs = Number(argv[++i]) || out.waitMs;
    } else if (a === "--out" && argv[i + 1]) {
      out.outFile = argv[++i];
    } else if (a === "--channel" && argv[i + 1]) {
      out.channel = argv[++i];
    } else if (a === "--headed") {
      out.headless = false;
    } else if (a === "--help" || a === "-h") {
      out.help = true;
    }
  }
  return out;
}

function helpText() {
  return `capture-console.mjs

  --url <url>       Full page URL (default: temporary http server for web/)
  --wait-ms <n>     Stay on page after load (default: 8000)
  --out <path>      Output JSON (default: web/artifacts/console-capture.json)
  --headed          Show browser window
  --channel <name>  Use system browser: msedge | chrome | chromium (no bundled Chromium)
  -h, --help
`;
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    console.log(helpText());
    process.exit(0);
  }

  const events = [];

  let localServer = null;
  let pageUrl = opts.url;
  let servedFrom = null;
  if (!opts.urlExplicit) {
    localServer = await startWebRootServer(WEB_ROOT);
    servedFrom = localServer.base;
    pageUrl = `${localServer.base}/index.html`;
  }

  const launchOpts = mergeChromiumLaunchForWebGpu({
    headless: opts.headless,
    ...(opts.channel ? { channel: opts.channel } : {}),
  });
  const browser = await chromium.launch(launchOpts);
  const context = await browser.newContext();
  const page = await context.newPage();

  const push = (source, payload) => {
    events.push({
      t: new Date().toISOString(),
      monoMs: Math.round(performance.now()),
      source,
      ...payload,
    });
  };

  page.on("console", (msg) => {
    const loc = msg.location();
    push("playwright.console", {
      type: msg.type(),
      text: msg.text(),
      location: loc?.url
        ? { url: loc.url, line: loc.lineNumber, column: loc.columnNumber }
        : null,
    });
  });

  page.on("pageerror", (err) => {
    push("playwright.pageerror", {
      message: String(err?.message ?? err),
      stack: err?.stack ?? null,
    });
  });

  page.on("crash", () => {
    push("playwright.crash", { message: "page crashed" });
  });

  const started = performance.now();
  await page.goto(pageUrl, { waitUntil: "load", timeout: 120_000 });
  push("playwright.lifecycle", { phase: "load", url: pageUrl });

  await new Promise((r) => setTimeout(r, opts.waitMs));

  const userAgent = await page
    .evaluate(() => navigator.userAgent)
    .catch(() => null);

  let windowSnapshot = null;
  try {
    windowSnapshot = await page.evaluate(() => ({
      consoleTap: globalThis.__SPLASHPARTY_CONSOLE__ ?? null,
      boot: globalThis.__SPLASHPARTY_BOOT__ ?? null,
    }));
  } catch (e) {
    windowSnapshot = { error: String(e) };
  }

  await browser.close();
  if (localServer) {
    await localServer.close().catch(() => {});
  }

  const payload = {
    meta: {
      capturedAt: new Date().toISOString(),
      url: pageUrl,
      servedFrom,
      waitMs: opts.waitMs,
      channel: opts.channel,
      elapsedMs: Math.round(performance.now() - started),
      userAgent,
    },
    events,
    window: windowSnapshot,
  };

  await mkdir(path.dirname(opts.outFile), { recursive: true });
  await writeFile(opts.outFile, JSON.stringify(payload, null, 2), "utf8");

  console.log(`Wrote ${opts.outFile} (${events.length} events)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
