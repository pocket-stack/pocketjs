// site/verify.ts — headless-Chrome verifier over the DevTools Protocol.
//   bun site/verify.ts <url> [waitMs] [probeExpr]
// Loads <url> in headless Chrome, hooks page errors, waits, evaluates a probe
// expression (default: canvas non-black pixel ratio + status/error text), saves
// a screenshot, and prints a JSON report. Local verification only.

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const url = process.argv[2] ?? "http://127.0.0.1:8140/";
const waitMs = Number(process.argv[3] ?? 4000);
const probe =
  process.argv[4] ??
  `(() => {
     // FPS + memory are drawn IN the canvas now (host-web/hud.js), not in the
     // DOM — so they show up in the canvas pixel stats below, not a text probe.
     const out = { status: null, error: null, canvases: [] };
     const s = document.querySelector('#pg-status'); if (s) out.status = s.textContent;
     const e = document.querySelector('#pg-error'); if (e && !e.hidden) out.error = e.textContent;
     for (const c of document.querySelectorAll('canvas')) {
       try {
         const ctx = c.getContext('2d');
         const d = ctx.getImageData(0,0,c.width,c.height).data;
         let nonblack = 0, colored = 0;
         for (let i=0;i<d.length;i+=4){ const r=d[i],g=d[i+1],b=d[i+2];
           if (r+g+b>24) nonblack++; if (Math.abs(r-g)+Math.abs(g-b)>40) colored++; }
         const px = d.length/4;
         out.canvases.push({ id:c.id, w:c.width, h:c.height,
           nonblackPct:+(100*nonblack/px).toFixed(1), coloredPct:+(100*colored/px).toFixed(1) });
       } catch(err){ out.canvases.push({ id:c.id, err:String(err) }); }
     }
     return out;
   })()`;

const SHOT = process.env.SHOT ?? "/private/tmp/claude-501/-Users-evan-code-pocketjs/92a09046-b511-4ab3-a360-0de941219d40/scratchpad/shot.png";

// --- launch chrome with a debugging port -----------------------------------
const port = 9333;
const proc = Bun.spawn(
  [CHROME, "--headless=new", `--remote-debugging-port=${port}`, "--no-first-run", "--no-default-browser-check",
    "--disable-gpu", "--hide-scrollbars", "--window-size=1400,1600", "--force-device-scale-factor=1", "about:blank"],
  { stdout: "ignore", stderr: "ignore" },
);

async function waitFor(fn: () => Promise<any>, tries = 40, gap = 100) {
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch {
      await Bun.sleep(gap);
    }
  }
  throw new Error("timed out waiting for chrome");
}

const version = await waitFor(() => fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json()));
const wsUrl = version.webSocketDebuggerUrl as string;
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});

let msgId = 0;
const pending = new Map<number, (v: any) => void>();
const events: any[] = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data as string);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)!(m.error ? { __error: m.error } : (m.result ?? {}));
    pending.delete(m.id);
  } else if (m.method) events.push(m);
};
function send(method: string, params: any = {}, sessionId?: string): Promise<any> {
  const id = ++msgId;
  const payload: any = { id, method, params };
  if (sessionId) payload.sessionId = sessionId;
  ws.send(JSON.stringify(payload));
  return new Promise((res) => pending.set(id, res));
}

// attach to a page target
const { targetInfos } = await send("Target.getTargets");
let pageTarget = targetInfos.find((t: any) => t.type === "page");
const { sessionId } = await send("Target.attachToTarget", { targetId: pageTarget.targetId, flatten: true });
const S = (method: string, params?: any) => send(method, params, sessionId);

const pageErrors: string[] = [];
const consoleErrors: string[] = [];
ws.addEventListener("message", (ev: any) => {
  const m = JSON.parse(ev.data);
  if (m.sessionId !== sessionId) return;
  if (m.method === "Runtime.exceptionThrown") {
    const d = m.params.exceptionDetails;
    pageErrors.push(d.exception?.description || d.text || JSON.stringify(d));
  }
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
    consoleErrors.push(m.params.args.map((a: any) => a.value ?? a.description ?? "").join(" "));
  }
});

await S("Page.enable");
await S("Runtime.enable");
await S("Log.enable");
if (process.env.WIDTH) {
  await S("Emulation.setDeviceMetricsOverride", {
    width: Number(process.env.WIDTH), height: Number(process.env.HEIGHT ?? 800),
    deviceScaleFactor: 2, mobile: !!process.env.MOBILE,
  });
}
await S("Page.navigate", { url });
await Bun.sleep(waitMs);

const evalRes = await S("Runtime.evaluate", { expression: probe, returnByValue: true, awaitPromise: true });
const shotOpts: any = { format: "png", captureBeyondViewport: true };
if (process.env.CLIP) {
  const [x, y, w, h] = process.env.CLIP.split(",").map(Number);
  shotOpts.clip = { x, y, width: w, height: h, scale: 1 };
}
const shot = await S("Page.captureScreenshot", shotOpts);
if (shot.data) await Bun.write(SHOT, Buffer.from(shot.data, "base64"));

console.log(
  JSON.stringify(
    {
      url,
      probe: evalRes.result?.value ?? evalRes.result ?? evalRes,
      pageErrors: pageErrors.slice(0, 8),
      consoleErrors: consoleErrors.slice(0, 8),
      screenshot: SHOT,
    },
    null,
    2,
  ),
);

ws.close();
proc.kill();
