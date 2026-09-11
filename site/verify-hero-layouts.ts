// Capture the review gallery from the live homepage, using isolated Chrome.
// Start site/preview.ts, then run: bun site/verify-hero-layouts.ts [base URL]
import { mkdirSync } from "node:fs";
const base = process.argv[2] ?? "http://127.0.0.1:4173/";
const images = new URL("./assets/hero-layouts/", import.meta.url).pathname;
const receipts = new URL("../dist/handheld-models/", import.meta.url).pathname;
mkdirSync(images, { recursive: true });
mkdirSync(receipts, { recursive: true });
const probe = `(async () => {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const roots = [...document.querySelectorAll('.hero [data-handheld]')];
  for (let i=0; i<300 && roots.some(root=>!root.dataset.demo); i++) await sleep(100);
  if (roots.length!==2 || roots.some(root=>!root.dataset.demo)) throw Error('Both hero devices must boot');
  await sleep(1600);
  const order = [...document.querySelectorAll('.hero .pe-entry')].map(link=>link.dataset.openApp);
  if (order.join(',')!=='pspman,pocket-shell,openstrike,pocket-voxel') throw Error('Unexpected hero case order');
  if (document.querySelectorAll('#motion [data-pocket-stage]').length!==1 || !document.querySelector('#motion [data-motion-stage]')) throw Error('Keep the original PSP in Motion');
  function reachable(element) {
    const r=element.getBoundingClientRect();
    if (r.height<44 || r.width<44) throw Error('Control target is too small');
    // Direct .click() bypasses overlapping canvases; check actual hit targets.
    for (const x of [.15,.5,.85]) for (const y of [.15,.5,.85]) {
      const hit=document.elementFromPoint(r.left+r.width*x,r.top+r.height*y);
      if (hit!==element && !element.contains(hit)) throw Error('Control target is covered: '+element.textContent);
    }
  }
  for (const [index,root] of roots.entries()) {
    const canvas = root.querySelector('[data-stage-canvas]'), rect=canvas.getBoundingClientRect();
    if (rect.left<0 || rect.right>document.documentElement.clientWidth+1) throw Error('Device viewport extends outside page');
    if (root.querySelector('figcaption>span')) throw Error('Remove the demo subtitle below the model');
    const name=['Nintendo 3DS','PS Vita'][index];
    if (root.querySelector('h3').textContent!==name || canvas.getAttribute('aria-label')!==name) throw Error('Use the short device name');
    if (root.querySelector('details,summary,input,[data-device-view]')) throw Error('Remove the device control menus');
  }
  const toggle=roots[0].querySelector('[data-lid-toggle]');
  reachable(toggle);
  const waitForLid=async angle=>{
    for (let i=0; i<100 && roots[0].dataset.lidAngle!==angle; i++) await sleep(50);
    if (roots[0].dataset.lidAngle!==angle) throw Error('Lid did not reach '+angle+' degrees');
  };
  toggle.click();
  await waitForLid('0');
  if (toggle.getAttribute('aria-label')!=='Open Nintendo 3DS') throw Error('Lid toggle did not update its label');
  toggle.click();
  await waitForLid('155');
  if (toggle.getAttribute('aria-label')!=='Close Nintendo 3DS') throw Error('Lid toggle did not restore its label');
  document.querySelector('.hero .pe-entry').click();
  if (!document.querySelector('#try-pspman').open) throw Error('First case must open PSPMAN');
  document.querySelector('#try-pspman').close();
  document.activeElement?.blur();
  // Use one video frame in all screenshots so only the composition changes.
  const video=document.querySelector('.hero video');video.pause();video.currentTime=0;
  await sleep(250);
  const rect=selector=>document.querySelector(selector).getBoundingClientRect().toJSON();
  return {layout:document.documentElement.dataset.heroLayout,order,hero:rect('.hero'),text:rect('.hero .col'),pair:rect('.hero-handhelds'),
    devices:roots.map(root=>({id:root.dataset.handheld,ready:root.dataset.ready,rect:root.getBoundingClientRect().toJSON()})),
    loadedModels:performance.getEntriesByType('resource').filter(e=>e.decodedBodySize>0 && new URL(e.name).pathname.endsWith('.glb')).map(e=>e.name)};
})()`;
for (const size of ["desktop", "mobile"]) {
  for (const layout of ["cascade", "duet", "stack"]) {
    const mobile = size === "mobile";
    const url = new URL(base); url.searchParams.set("hero", layout);
    const screenshot = `${images}${layout}-${size}.png`;
    const child = Bun.spawn(["bun", new URL("./verify.ts", import.meta.url).pathname, url.href, "1000", probe], {
      env: { ...process.env, WIDTH: mobile ? "390" : "1440", HEIGHT: mobile ? "844" : "960", MOBILE: mobile ? "1" : "",
        SHOT: screenshot, POCKETJS_VERIFY_SELECTOR: ".hero", POCKETJS_VERIFY_CDP_TIMEOUT: "60000" },
      stdout: "pipe", stderr: "inherit",
    });
    const result = await new Response(child.stdout).text();
    if (await child.exited !== 0) throw Error(`${layout} ${size} verification failed`);
    const report = JSON.parse(result);
    await Bun.write(`${receipts}hero-${layout}-${size}-receipt.json`, result);
    const completed = new Set(report.probe.loadedModels.map((url: string) => `net::ERR_ABORTED: ${url} (type=Fetch, canceled=true)`));
    if (report.pageErrors.length || report.consoleErrors.length || report.networkErrors.some((error: string) => !completed.has(error))) {
      throw Error(`${layout} ${size} reported browser errors: ${result}`);
    }
    console.log(`${layout} ${size}: passed → ${screenshot}`);
  }
}
