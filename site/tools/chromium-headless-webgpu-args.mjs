import { existsSync } from "node:fs";

/**
 * Mesa Lavapipe (software Vulkan). Prefer over SwiftShader for WebGPU: SwiftShader
 * + Dawn can throw bogus `createBuffer(..., mappedAtCreation)` RangeError ("size (4) is too large").
 *
 * @see https://github.com/mrdoob/three.js/pull/33346 (Lavapipe for WebGPU CI)
 */
const LAVAPIPE_ICD_X64 = "/usr/share/vulkan/icd.d/lvp_icd.x86_64.json";

/**
 * Extra Chromium flags so **headless** browsers can expose WebGPU on Linux CI
 * (Vulkan + software stack). Without these, Bevy wasm often panics with
 * "Unable to find a GPU".
 *
 * References:
 * - https://developer.chrome.com/blog/supercharge-web-ai-testing
 * - https://developer.chrome.com/docs/web-platform/webgpu/colab-headless
 */
export const CHROMIUM_HEADLESS_WEBGPU_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--use-angle=vulkan",
  "--enable-features=Vulkan",
  "--disable-vulkan-surface",
  "--enable-unsafe-webgpu",
];

/**
 * @param {{ headless?: boolean, channel?: string | null, args?: string[] }} base
 * @returns {Record<string, unknown>}
 */
export function mergeChromiumLaunchForWebGpu(base) {
  const headless = base.headless !== false;
  const env = { ...process.env, ...(base.env ?? {}) };
  if (
    process.platform === "linux" &&
    !env.VK_ICD_FILENAMES &&
    existsSync(LAVAPIPE_ICD_X64)
  ) {
    env.VK_ICD_FILENAMES = LAVAPIPE_ICD_X64;
  }

  const prev = base.args ?? [];
  // Headed Linux (e.g. `xvfb-run … --headed`) still needs ANGLE/Vulkan + unsafe WebGPU flags.
  // Headed Windows/macOS: keep default args so real desktop GPUs are not forced through ANGLE.
  const needsWebGpuChromeArgs = headless || process.platform === "linux";
  const args = needsWebGpuChromeArgs
    ? [...prev, ...CHROMIUM_HEADLESS_WEBGPU_ARGS]
    : [...prev];

  return {
    ...base,
    args,
    env,
  };
}
