#!/usr/bin/env node
/**
 * CI smoke: load wasm index over HTTP, wait, fail on console errors / pageerror / crash.
 * Uses a mobile-like browser context so wasm touch UI path is exercised (see is_mobile_wasm_runtime).
 *
 *   cd web && npm ci && npx playwright install --with-deps chromium
 *   npm run test:wasm-smoke
 *   npm run test:wasm-smoke -- --url http://127.0.0.1:8765/ --wait-ms 15000
 *   npm run test:wasm-smoke -- --desktop --wait-ms 12000   # Linux CI: Lavapipe + headless WebGPU flags
 *   npm run test:wasm-smoke -- --desktop --force-buffer-shim   # Exercise mappedAtCreation fallback
 *   npm run test:wasm-smoke -- --channel msedge   # Windows: system Edge, no bundled Chromium
 */
import { chromium } from "playwright";
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
    waitMs: 12_000,
    headless: true,
    channel: null,
    /** When true, use default desktop context (skip mobile emulation). */
    desktop: false,
    forceBufferShim: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url" && argv[i + 1]) {
      out.url = argv[++i];
      out.urlExplicit = true;
    } else if (a === "--wait-ms" && argv[i + 1]) {
      out.waitMs = Number(argv[++i]) || out.waitMs;
    } else if (a === "--channel" && argv[i + 1]) {
      out.channel = argv[++i];
    } else if (a === "--headed") {
      out.headless = false;
    } else if (a === "--desktop") {
      out.desktop = true;
    } else if (a === "--force-buffer-shim") {
      out.forceBufferShim = true;
    } else if (a === "--help" || a === "-h") {
      out.help = true;
    }
  }
  return out;
}

function helpText() {
  return `wasm-smoke.mjs

  --url <url>       Full page URL (default: ephemeral server for web/)
  --wait-ms <n>     Milliseconds to keep page open after load (default: 12000)
  --channel <name>  msedge | chrome | chromium (system browser; no download)
  --desktop         Do not emulate mobile (default: mobile-like context for touch UI)
  --force-buffer-shim
                    Add ?splashparty-force-buffer-shim=1 to exercise the mappedAtCreation fallback
  --headed          Non-headless browser
  -h, --help
`;
}

function withSearchParam(url, key, value) {
  const u = new URL(url);
  u.searchParams.set(key, value);
  return u.toString();
}

/** DevTools network errors for missing favicon only. */
function isBenignConsoleError(text, locationUrl) {
  const u = (locationUrl || "").toLowerCase();
  if (u.includes("favicon")) return true;
  const t = String(text).toLowerCase();
  if (t.includes("favicon") && (t.includes("404") || t.includes("not found"))) return true;
  if ((u.endsWith(".meta") || t.includes(".meta")) && (t.includes("404") || t.includes("not found"))) {
    return true;
  }
  return false;
}

function tapHasHardError(entries) {
  if (!Array.isArray(entries)) return null;
  const bad = [];
  for (const e of entries) {
    if (e?.level !== "error") continue;
    if (isBenignConsoleError(e.text, null)) continue;
    bad.push(e);
  }
  return bad.length ? bad : null;
}

async function readMobileWasmRuntimeSnapshot(page) {
  return page.evaluate(() => {
    const ua = navigator.userAgent.toLowerCase();
    const hasTouch = navigator.maxTouchPoints > 0;
    const mobileUa =
      ua.includes("mobi") ||
      ua.includes("android") ||
      ua.includes("iphone") ||
      ua.includes("ipad") ||
      ua.includes("ipod");
    const coarsePointer = matchMedia("(pointer: coarse)").matches;
    const noHover = matchMedia("(hover: none)").matches;

    return {
      hasTouch,
      mobileUa,
      coarsePointer,
      noHover,
      userAgent: navigator.userAgent,
      detected: hasTouch && (mobileUa || (coarsePointer && noHover)),
    };
  });
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    console.log(helpText());
    process.exit(0);
  }

  const failures = [];
  const record = (kind, detail) => failures.push({ kind, ...detail });

  let localServer = null;
  let pageUrl = opts.url;
  if (!opts.urlExplicit) {
    localServer = await startWebRootServer(WEB_ROOT);
    pageUrl = `${localServer.base}/index.html`;
  }
  if (opts.forceBufferShim) {
    pageUrl = withSearchParam(pageUrl, "splashparty-force-buffer-shim", "1");
  }

  const launchOpts = mergeChromiumLaunchForWebGpu({
    headless: opts.headless,
    ...(opts.channel ? { channel: opts.channel } : {}),
  });
  const browser = await chromium.launch(launchOpts);
  let closed = false;
  const safeCloseBrowser = async () => {
    if (closed) return;
    closed = true;
    await browser.close().catch(() => {});
  };

  const context = await browser.newContext(
    opts.desktop
      ? {}
      : {
          viewport: { width: 412, height: 915 },
          hasTouch: true,
          isMobile: true,
          // Keep the app on its touch UI path without spoofing Android. Recent Chromium/Dawn
          // applies Android WebGPU constraints from Android UAs, which can make Bevy panic on
          // tiny mappedAtCreation buffers in desktop CI.
          userAgent:
            "Mozilla/5.0 (X11; Linux x86_64; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
        },
  );

  const page = await context.newPage();

  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const loc = msg.location();
    const url = loc?.url ?? "";
    if (isBenignConsoleError(msg.text(), url)) return;
    record("console", { text: msg.text(), url });
  });

  page.on("pageerror", (err) => {
    record("pageerror", { message: String(err?.message ?? err), stack: err?.stack });
  });

  page.on("crash", () => {
    record("crash", { message: "page crashed" });
  });

  const started = performance.now();
  try {
    await page.goto(pageUrl, { waitUntil: "load", timeout: 120_000 });
    if (!opts.desktop) {
      const mobileRuntime = await readMobileWasmRuntimeSnapshot(page);
      if (!mobileRuntime.detected) {
        record("mobile-runtime", {
          message: "smoke context does not satisfy wasm mobile touch detection",
          mobileRuntime,
        });
      }
    }
    await new Promise((r) => setTimeout(r, opts.waitMs));

    try {
      const tap = await page.evaluate(() => globalThis.__SPLASHPARTY_CONSOLE__ ?? []);
      const tapCheck = tapHasHardError(tap);
      if (tapCheck) {
        for (const e of tapCheck) {
          record("consoleTap.error", { text: e.text, t: e.t });
        }
      }
    } catch (e) {
      record("evaluate", { message: String(e) });
    }
  } finally {
    await safeCloseBrowser();
    if (localServer) await localServer.close().catch(() => {});
  }

  const elapsed = Math.round(performance.now() - started);
  if (failures.length) {
    console.error(`wasm-smoke FAILED after ${elapsed}ms (${failures.length} issue(s)):`);
    for (const f of failures) console.error(JSON.stringify(f));
    process.exit(1);
  }

  console.log(`wasm-smoke OK (${elapsed}ms, wait ${opts.waitMs}ms) — ${pageUrl}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
