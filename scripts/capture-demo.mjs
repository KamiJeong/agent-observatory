import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";

const repositoryRoot = resolve(import.meta.dirname, "..");
const assetsDirectory = join(repositoryRoot, "docs", "assets");
const temporaryDirectory = mkdtempSync(join(tmpdir(), "agent-observatory-demo-"));
const token = "deterministic-demo-capture";

async function freePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return port;
}

async function waitForServer(baseUrl, child) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Demo server exited with code ${child.exitCode}`);
    try {
      if ((await fetch(`${baseUrl}/api/health`)).ok) return;
    } catch {
      // The local server may still be binding its port.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error("Timed out waiting for the demo server");
}

async function capture(baseUrl) {
  mkdirSync(assetsDirectory, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const screenshotContext = await browser.newContext({ viewport: { width: 1200, height: 750 } });
    await screenshotContext.addCookies([{
      name: "observatory_session",
      value: token,
      url: baseUrl,
      httpOnly: true,
      sameSite: "Strict",
    }]);
    const screenshotPage = await screenshotContext.newPage();
    await screenshotPage.goto(baseUrl);
    await screenshotPage.getByRole("heading", { name: "Agent Observatory" }).waitFor();
    await screenshotPage.getByRole("button", { name: /^Status: Working Release Orchestrator/ }).click();
    await screenshotPage.getByRole("tab", { name: "History", exact: true }).click();
    await screenshotPage.screenshot({
      path: join(assetsDirectory, "agent-observatory-demo.png"),
      animations: "disabled",
    });
    await screenshotContext.close();

    const videoDirectory = join(temporaryDirectory, "video");
    mkdirSync(videoDirectory, { recursive: true });
    const videoContext = await browser.newContext({
      viewport: { width: 1200, height: 750 },
      recordVideo: { dir: videoDirectory, size: { width: 1200, height: 750 } },
    });
    await videoContext.addCookies([{
      name: "observatory_session",
      value: token,
      url: baseUrl,
      httpOnly: true,
      sameSite: "Strict",
    }]);
    const page = await videoContext.newPage();
    await page.goto(baseUrl);
    await page.getByRole("heading", { name: "Agent Observatory" }).waitFor();
    const video = page.video();

    await page.waitForTimeout(800);
    await page.getByRole("button", { name: /^Status: Working Release Orchestrator/ }).click();
    await page.getByRole("tab", { name: "History", exact: true }).click();
    await page.waitForTimeout(1_600);
    await page.getByRole("button", { name: "Show all 3 secondary relations" }).click();
    await page.waitForTimeout(1_200);
    await page.getByRole("button", { name: "Claude 3", exact: true }).click();
    await page.waitForTimeout(1_200);
    await page.getByRole("button", { name: /^Status: Idle Privacy Reviewer/ }).click();
    await page.waitForTimeout(1_200);
    await page.getByRole("group", { name: "Agent visualization" }).getByRole("button", { name: "Workflows" }).click();
    await page.waitForTimeout(1_800);

    await videoContext.close();
    const videoPath = await video.path();
    const gifPath = join(assetsDirectory, "agent-observatory-demo.gif");
    const ffmpeg = spawnSync("ffmpeg", [
      "-y",
      "-ss", "0.35",
      "-i", videoPath,
      "-filter_complex",
      "fps=8,scale=1200:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=96:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle",
      "-loop", "0",
      gifPath,
    ], { cwd: repositoryRoot, stdio: "inherit" });
    if (ffmpeg.error) throw ffmpeg.error;
    if (ffmpeg.status !== 0) throw new Error(`ffmpeg exited with code ${ffmpeg.status}`);
  } finally {
    await browser.close();
  }
}

const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, [join(repositoryRoot, "apps", "server", "dist", "index.js")], {
  cwd: repositoryRoot,
  env: {
    ...process.env,
    OBSERVATORY_ACCESS_TOKEN: token,
    OBSERVATORY_ADAPTER: "mock",
    OBSERVATORY_PORT: String(port),
    OBSERVATORY_SCENARIO: "demo",
  },
  stdio: ["ignore", "ignore", "inherit"],
});

try {
  await waitForServer(baseUrl, child);
  await capture(baseUrl);
} finally {
  child.kill("SIGTERM");
  rmSync(temporaryDirectory, { recursive: true, force: true });
}

console.log("Updated docs/assets/agent-observatory-demo.png and agent-observatory-demo.gif");
