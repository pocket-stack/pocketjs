// Real-browser smoke for the Playground's shared Pocket Stage shell.
// Serve site/dist first, then run:
//   bun site/verify-playground-stage.ts 'http://127.0.0.1:8140/playground/?demo=hero&framework=solid'

const url = process.argv[2]
  ?? "http://127.0.0.1:8140/playground/?demo=hero&framework=solid";
const verify = new URL("./verify.ts", import.meta.url).pathname;

const probe = `(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const stage = document.querySelector("[data-playground-stage]");
  const webgl = document.querySelector("canvas[data-stage-canvas]");
  const framebuffer = document.querySelector("#pg-canvas");
  const credit = document.querySelector(".pg-stage__credit a");
  const run = document.querySelector("#pg-run");
  const status = document.querySelector("#pg-status");
  const receipt = () => globalThis.__playgroundStageReceipt?.();
  const readyDeadline = performance.now() + 12000;
  while (performance.now() < readyDeadline) {
    if (stage.dataset.ready === "true" && status.dataset.kind === "ok") break;
    await sleep(100);
  }
  // Let the post-load ResizeObserver and the first Stage render settle so the
  // authored hit proxies and their normalized viewport coordinates agree.
  await sleep(750);
  const lowerScreenHash = () => {
    const context = framebuffer.getContext("2d");
    const top = Math.floor(framebuffer.height * 0.68);
    const data = context.getImageData(0, top, framebuffer.width, framebuffer.height - top).data;
    let value = 2166136261;
    for (let i = 0; i < data.length; i += 4) {
      value ^= data[i] | (data[i + 1] << 8) | (data[i + 2] << 16);
      value = Math.imul(value, 16777619);
    }
    return value >>> 0;
  };

  credit.focus();
  const enter = new KeyboardEvent("keydown", {
    key: "Enter",
    code: "Enter",
    bubbles: true,
    cancelable: true,
  });
  credit.dispatchEvent(enter);
  const creditEnterPrevented = enter.defaultPrevented;

  webgl.setPointerCapture = () => {};
  webgl.releasePointerCapture = () => {};
  const rect = webgl.getBoundingClientRect();
  let pointerId = 100;
  const pointer = (type, point, id) => new PointerEvent(type, {
    pointerId: id,
    pointerType: "mouse",
    isPrimary: true,
    button: 0,
    buttons: type === "pointerup" ? 0 : 1,
    clientX: rect.left + rect.width * point.x,
    clientY: rect.top + rect.height * point.y,
    bubbles: true,
    cancelable: true,
  });
  const candidates = [
    { x: 0.95, y: 0.455 },
    { x: 0.95, y: 0.49 },
    { x: 0.925, y: 0.455 },
    { x: 0.975, y: 0.455 },
  ];
  let circlePoint = null;
  let firstPointerId = null;
  for (const point of candidates) {
    const id = pointerId++;
    webgl.dispatchEvent(pointer("pointerdown", point, id));
    await sleep(20);
    if (receipt()?.pressedPart === "btn_circle") {
      circlePoint = point;
      firstPointerId = id;
      break;
    }
    webgl.dispatchEvent(pointer("pointerup", point, id));
    const releaseDeadline = performance.now() + 800;
    while (performance.now() < releaseDeadline && receipt()?.pressedPart) await sleep(20);
  }
  const firstDownPart = receipt()?.pressedPart ?? null;

  // Do not send pointerup: Run must release both the host bit and the Stage
  // pointer latch before PocketHost.reset() discards afterNextTick callbacks.
  run.click();
  let sawBusy = status.dataset.kind === "busy";
  const deadline = performance.now() + 12000;
  while (performance.now() < deadline) {
    sawBusy ||= status.dataset.kind === "busy";
    if (sawBusy && status.dataset.kind === "ok") break;
    await sleep(50);
  }
  await sleep(100);
  const afterReset = receipt();
  const hashBefore = lowerScreenHash();

  const dpadPoint = { x: 0.17, y: 0.44 };
  const dpadPointerId = pointerId++;
  webgl.dispatchEvent(pointer("pointerdown", dpadPoint, dpadPointerId));
  await sleep(30);
  const navigationPart = receipt()?.pressedPart ?? null;
  await sleep(50);
  webgl.dispatchEvent(pointer("pointerup", dpadPoint, dpadPointerId));
  await sleep(120);

  let secondDownPart = null;
  let hashAfter = hashBefore;
  let afterSecond = afterReset;
  if (circlePoint) {
    const secondPointerId = pointerId++;
    webgl.dispatchEvent(pointer("pointerdown", circlePoint, secondPointerId));
    await sleep(20);
    secondDownPart = receipt()?.pressedPart ?? null;
    await sleep(60);
    webgl.dispatchEvent(pointer("pointerup", circlePoint, secondPointerId));
    await sleep(180);
    hashAfter = lowerScreenHash();
    afterSecond = receipt();
  }

  const resources = performance.getEntriesByType("resource").map((entry) => new URL(entry.name).pathname);
  return {
    stageReady: stage.dataset.ready,
    hasError: stage.classList.contains("has-error"),
    creditEnterPrevented,
    sawBusy,
    statusKind: status.dataset.kind,
    status: status.textContent,
    firstDownPart,
    firstPointerId,
    releasedAcrossReset: afterReset?.pressedPart == null,
    navigationPart,
    secondDownPart,
    releasedAfterSecond: afterSecond?.pressedPart == null,
    lowerFramebufferChanged: hashBefore !== hashAfter,
    wasmLoads: resources.filter((path) => path.endsWith("/pg/pocketjs.wasm")).length,
    launcherLoads: resources.filter((path) => path.startsWith("/stage/apps/")),
    receipt: afterSecond,
  };
})()`;

const child = Bun.spawn(
  [process.execPath, verify, url, "1000", probe],
  {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      SHOT: process.env.SHOT ?? "/tmp/pocketjs-playground-stage.png",
    },
  },
);
const [stdout, stderr, exitCode] = await Promise.all([
  new Response(child.stdout).text(),
  new Response(child.stderr).text(),
  child.exited,
]);
if (exitCode !== 0) throw new Error(stderr || stdout || `site verifier exited ${exitCode}`);

const report = JSON.parse(stdout);
const result = report.probe;
const checks = {
  stageReady:
    result.stageReady === "true"
    && result.hasError === false
    && result.statusKind === "ok",
  sharedPackage:
    result.receipt?.profileUrl === "/stage/psp-profile.json"
    && result.receipt?.modelUrl === "/stage/psp_lod3_eco.glb"
    && result.receipt?.screenCanvasId === "pg-canvas",
  onePlaygroundRuntime: result.wasmLoads === 1 && result.launcherLoads.length === 0,
  creditKeepsEnter: result.creditEnterPrevented === false,
  resetReleasesModelInput:
    result.sawBusy
    && result.firstDownPart === "btn_circle"
    && result.releasedAcrossReset
    && result.navigationPart === "dpad_right"
    && result.secondDownPart === "btn_circle"
    && result.releasedAfterSecond,
  liveFramebuffer: result.lowerFramebufferChanged && result.receipt?.screenUploads > 1,
  noBrowserErrors: report.pageErrors.length === 0 && report.consoleErrors.length === 0,
};
const failures = Object.entries(checks)
  .filter(([, passed]) => !passed)
  .map(([name]) => name);

console.log(JSON.stringify({ ...report, checks }, null, 2));
if (failures.length) {
  throw new Error(`Playground Stage smoke failed: ${failures.join(", ")}`);
}
