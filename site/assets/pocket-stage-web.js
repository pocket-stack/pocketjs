// Browser adapter for a Pocket Stage package. The native pocket-stage process
// owns the macOS/wgpu shell; this adapter deliberately reuses the package data
// and contracts while mapping them onto DOM input + demand-rendered WebGL.

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { BTN, PocketHost } from "../playground/host.js";
import {
  POCKET_SECTION,
  decodePocketPackage,
  findSection,
  findVariant,
} from "../../spec/pocket-package.ts";

// Re-exported for the local/CI browser verifier (site/verify.ts): the
// app-switch protocol is testable headlessly through PocketHost alone,
// where WebGL (the 3D shell) may be unavailable, and the .pocket decode
// path is exercised with the same helpers the adapter uses.
export { BTN, PocketHost, POCKET_SECTION, decodePocketPackage, findSection, findVariant };

const STAGE_ROOT = "/stage/";
const FRONT_SNAP_RADIANS = THREE.MathUtils.degToRad(2);
const ORBIT_YAW_LIMIT = 0.85;
const ORBIT_PITCH_LIMIT = 0.5;

const BUTTON_BITS = {
  up: BTN.UP,
  right: BTN.RIGHT,
  down: BTN.DOWN,
  left: BTN.LEFT,
  l: BTN.LTRIGGER,
  r: BTN.RTRIGGER,
  triangle: BTN.TRIANGLE,
  circle: BTN.CIRCLE,
  cross: BTN.CROSS,
  square: BTN.SQUARE,
  select: BTN.SELECT,
  start: BTN.START,
};

function failResponse(response) {
  if (!response.ok) throw new Error(`${response.url}: HTTP ${response.status}`);
  return response;
}

function semantic(material, key) {
  return material?.userData?.[key];
}

function applyMonochrome(material) {
  if (semantic(material, "pocket3d_base_color_mode") !== "monochrome") return material;
  const copy = material.clone();
  copy.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      "diffuseColor *= sampledDiffuseColor;",
      `diffuseColor *= sampledDiffuseColor;
       float pocketMonochrome = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
       diffuseColor.rgb = vec3(pocketMonochrome);`,
    );
  };
  copy.customProgramCacheKey = () => "pocket-stage-monochrome-v1";
  copy.needsUpdate = true;
  return copy;
}

function canonicalizeModel(rawScene, profile) {
  const degrees = profile.rotation_degrees ?? [0, 0, 0];
  rawScene.rotation.set(...degrees.map(THREE.MathUtils.degToRad));
  rawScene.updateMatrixWorld(true);

  const oriented = new THREE.Box3().setFromObject(rawScene);
  const size = oriented.getSize(new THREE.Vector3());
  const center = oriented.getCenter(new THREE.Vector3());
  if (!(size.x > 0)) throw new Error("stage model has a degenerate canonical width");

  // Matches the native package transform: orient, center, then scale to the
  // profile's canonical millimetre width. Interaction proxies are already in
  // this resulting coordinate system.
  rawScene.position.copy(center).multiplyScalar(-1);
  const canonical = new THREE.Group();
  canonical.name = "pocket-stage-canonical-model";
  canonical.scale.setScalar(profile.target_width_mm / size.x);
  canonical.add(rawScene);
  canonical.updateMatrixWorld(true);
  return canonical;
}

function bindPackageMaterials(model, profile, screenTexture) {
  let screens = 0;
  const suppressedProfiles = profile.suppressed_materials ?? [];
  const suppressedCounts = new Map(suppressedProfiles.map((entry) => [entry, 0]));

  const configure = (material) => {
    const role = semantic(material, "pocket3d_role");
    const screenMatch = role === profile.screen.material_role ||
      material.name?.startsWith(profile.screen.material_name_prefix);
    if (screenMatch) {
      screens++;
      const screen = new THREE.MeshBasicMaterial({
        name: material.name,
        map: screenTexture,
        color: 0xffffff,
        side: THREE.DoubleSide,
        toneMapped: false,
        transparent: false,
        depthWrite: true,
      });
      screen.userData = { ...material.userData };
      return screen;
    }

    const suppressedMatch = suppressedProfiles.find((entry) =>
      role === entry.material_role || material.name?.startsWith(entry.material_name_prefix),
    );
    if (suppressedMatch) {
      suppressedCounts.set(suppressedMatch, suppressedCounts.get(suppressedMatch) + 1);
      return new THREE.MeshBasicMaterial({
        name: material.name,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        colorWrite: false,
      });
    }
    return applyMonochrome(material);
  };

  model.traverse((object) => {
    if (!object.isMesh) return;
    object.material = Array.isArray(object.material)
      ? object.material.map(configure)
      : configure(object.material);
  });

  if (screens !== profile.screen.expected_primitives) {
    throw new Error(`stage screen matched ${screens} primitives; expected ${profile.screen.expected_primitives}`);
  }
  for (const entry of suppressedProfiles) {
    const matches = suppressedCounts.get(entry);
    if (matches !== entry.expected_primitives) {
      throw new Error(`stage suppressed material matched ${matches} primitives; expected ${entry.expected_primitives}`);
    }
  }
}

function buildPickProxies(profile) {
  const group = new THREE.Group();
  group.name = "pocket-stage-interaction-proxies";
  for (const part of profile.parts ?? []) {
    if (!part.button && part.name !== "screen" && part.name !== "nub") continue;
    const [hx, hy, hz] = part.half_extents_mm;
    const geometry = new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2);
    // Layer 2 is raycast-only: the camera never draws these proxy boxes.
    const proxy = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
    proxy.layers.set(2);
    proxy.position.fromArray(part.center_mm);
    proxy.userData.stagePart = part;
    group.add(proxy);
  }
  return group;
}

function pose(camera, controls) {
  return {
    position: camera.position.clone(),
    target: controls.target.clone(),
  };
}

function easeInOut(t) {
  return t * t * (3 - 2 * t);
}

export async function mountPocketStage(root) {
  const viewport = root.querySelector("[data-stage-viewport]");
  const canvas = root.querySelector("[data-stage-canvas]");
  const screenCanvas = root.querySelector("[data-stage-screen]");
  const status = root.querySelector("[data-stage-status]");
  if (!viewport || !canvas || !screenCanvas || !status) return;

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      powerPreference: "low-power",
      premultipliedAlpha: true,
    });
  } catch (error) {
    root.classList.add("has-error");
    status.textContent = "Interactive 3D is unavailable in this browser.";
    console.error("Pocket Stage WebGL startup failed", error);
    return;
  }

  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;

  const scene = new THREE.Scene();
  // Placeholder framing until the package's authored view block loads; the
  // scene stays empty until then, so nothing renders from this pose.
  const camera = new THREE.PerspectiveCamera(30, 1, 1, 2000);
  camera.position.set(0, 46, 190);
  let focusDistanceMm = 98;
  scene.add(new THREE.HemisphereLight(0xe8f1ff, 0x151922, 2.4));
  const key = new THREE.DirectionalLight(0xffffff, 3.2);
  key.position.set(-90, 120, 180);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x8cc8ff, 1.1);
  rim.position.set(130, 20, -80);
  scene.add(rim);

  const controls = new OrbitControls(camera, canvas);
  controls.target.set(0, 0, 0);
  controls.enablePan = false;
  controls.enableZoom = false;
  controls.enableDamping = false;
  controls.rotateSpeed = 0.55;
  controls.minAzimuthAngle = -ORBIT_YAW_LIMIT;
  controls.maxAzimuthAngle = ORBIT_YAW_LIMIT;
  controls.minPolarAngle = Math.PI / 2 - ORBIT_PITCH_LIMIT;
  controls.maxPolarAngle = Math.PI / 2 + ORBIT_PITCH_LIMIT;
  controls.update();

  let host = null;
  let screenTexture = null;
  let proxyGroup = null;
  let inViewport = true;
  let renderRaf = 0;
  let cameraRaf = 0;
  let renderCount = 0;
  let focused = false;
  let savedDeskPose = null;
  let pressed = null;
  let cancelRelease = null;
  let wheelSnapTimer = 0;
  let ready = false;

  const renderNow = () => {
    renderRaf = 0;
    if (!inViewport || document.hidden) return;
    renderer.render(scene, camera);
    renderCount++;
    root.dataset.stageFrames = String(renderCount);
    if (host) {
      root.dataset.guestTicks = String(host.tickCount);
      root.dataset.screenFrames = String(host.blitCount);
    }
  };

  const invalidate = () => {
    if (!inViewport || document.hidden || renderRaf) return;
    renderRaf = requestAnimationFrame(renderNow);
  };

  const resize = () => {
    const width = Math.max(1, viewport.clientWidth);
    const height = Math.max(1, viewport.clientHeight);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    invalidate();
  };
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(viewport);
  resize();

  const raycaster = new THREE.Raycaster();
  raycaster.layers.set(2);
  const pointer = new THREE.Vector2();
  const pick = (event) => {
    if (!proxyGroup) return null;
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    return raycaster.intersectObjects(proxyGroup.children, false)[0]?.object.userData.stagePart ?? null;
  };

  const tweenPose = (destination, duration = 360) => {
    if (cameraRaf) cancelAnimationFrame(cameraRaf);
    const source = pose(camera, controls);
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const start = performance.now();
    const span = reduced ? 0 : duration;
    controls.enabled = false;
    const step = (now) => {
      const t = span === 0 ? 1 : Math.min(1, (now - start) / span);
      const eased = easeInOut(t);
      camera.position.lerpVectors(source.position, destination.position, eased);
      controls.target.lerpVectors(source.target, destination.target, eased);
      camera.lookAt(controls.target);
      renderNow();
      if (t < 1 && inViewport && !document.hidden) {
        cameraRaf = requestAnimationFrame(step);
      } else {
        cameraRaf = 0;
        controls.enabled = !focused;
        controls.update();
      }
    };
    cameraRaf = requestAnimationFrame(step);
  };

  const snapFrontIfClose = () => {
    if (focused) return;
    const offset = camera.position.clone().sub(controls.target);
    const spherical = new THREE.Spherical().setFromVector3(offset);
    const pitch = spherical.phi - Math.PI / 2;
    if (Math.hypot(spherical.theta, pitch) > FRONT_SNAP_RADIANS) return;
    tweenPose({
      position: controls.target.clone().add(new THREE.Vector3(0, 0, spherical.radius)),
      target: controls.target.clone(),
    }, 180);
  };

  controls.addEventListener("change", invalidate);
  controls.addEventListener("end", snapFrontIfClose);

  // macOS trackpads deliver precise two-axis wheel deltas. Reserve that gesture
  // for a horizontal turn, but let ordinary vertical scrolling and browser
  // pinch-to-zoom pass through so the large hero never traps the page.
  canvas.addEventListener("wheel", (event) => {
    if (!ready || focused || event.ctrlKey) return;
    const horizontalOrbit = Math.abs(event.deltaX) > Math.abs(event.deltaY) * 1.15;
    const modifiedOrbit = event.altKey;
    if (!horizontalOrbit && !modifiedOrbit) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const offset = camera.position.clone().sub(controls.target);
    const spherical = new THREE.Spherical().setFromVector3(offset);
    spherical.theta = THREE.MathUtils.clamp(
      spherical.theta + event.deltaX * 0.0024,
      -ORBIT_YAW_LIMIT,
      ORBIT_YAW_LIMIT,
    );
    spherical.phi = THREE.MathUtils.clamp(
      spherical.phi + (modifiedOrbit ? event.deltaY : 0) * 0.0024,
      Math.PI / 2 - ORBIT_PITCH_LIMIT,
      Math.PI / 2 + ORBIT_PITCH_LIMIT,
    );
    camera.position.copy(controls.target).add(new THREE.Vector3().setFromSpherical(spherical));
    camera.lookAt(controls.target);
    controls.update();
    invalidate();
    window.clearTimeout(wheelSnapTimer);
    wheelSnapTimer = window.setTimeout(snapFrontIfClose, 120);
  }, { passive: false, capture: true });

  const releaseButton = () => {
    if (!pressed || !host) return;
    cancelRelease?.();
    cancelRelease = null;
    const active = pressed;
    pressed = null;
    host.press(active.bit, false);
    root.dataset.pressedPart = "";
  };

  canvas.addEventListener("pointerdown", (event) => {
    if (!ready || pressed || event.button !== 0) return;
    const part = pick(event);
    const bit = BUTTON_BITS[part?.button];
    if (!bit) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    pressed = { bit, pointerId: event.pointerId, tickAtPress: host.tickCount };
    root.dataset.pressedPart = part.name;
    canvas.setPointerCapture(event.pointerId);
    host.press(bit, true);
  }, true);

  const finishPointer = (event) => {
    if (!pressed || pressed.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    // Wall-clock delays can fire before a throttled rAF. Hold the bit until
    // the guest has demonstrably consumed at least one fixed-timestep turn.
    if (host.tickCount > pressed.tickAtPress) releaseButton();
    else if (!cancelRelease) cancelRelease = host.afterNextTick(releaseButton);
  };
  canvas.addEventListener("pointerup", finishPointer, true);
  canvas.addEventListener("pointercancel", finishPointer, true);
  window.addEventListener("blur", releaseButton);

  canvas.addEventListener("pointermove", (event) => {
    if (!ready || pressed) return;
    const part = pick(event);
    canvas.style.cursor = part?.button || part?.name === "screen" ? "pointer" : "grab";
  });

  canvas.addEventListener("dblclick", (event) => {
    if (!ready || pick(event)?.name !== "screen") return;
    event.preventDefault();
    if (!focused) {
      savedDeskPose = pose(camera, controls);
      focused = true;
      root.dataset.focused = "true";
      const screenPart = proxyGroup.children.find((child) => child.userData.stagePart.name === "screen")
        ?.userData.stagePart;
      const target = new THREE.Vector3().fromArray(screenPart.center_mm);
      tweenPose({ position: target.clone().add(new THREE.Vector3(0, 0, focusDistanceMm)), target });
    } else if (savedDeskPose) {
      focused = false;
      root.dataset.focused = "false";
      tweenPose(savedDeskPose);
    }
  });

  const setVisible = (visible) => {
    inViewport = visible;
    if (!visible || document.hidden) {
      releaseButton();
      host?.stop();
      if (renderRaf) cancelAnimationFrame(renderRaf);
      renderRaf = 0;
      if (cameraRaf) cancelAnimationFrame(cameraRaf);
      cameraRaf = 0;
      controls.enabled = !focused;
      return;
    }
    host?.wake();
    invalidate();
  };

  const visibilityObserver = new IntersectionObserver(
    ([entry]) => setVisible(entry.isIntersecting),
    { threshold: 0.05 },
  );
  visibilityObserver.observe(root);
  document.addEventListener("visibilitychange", () => setVisible(inViewport));

  try {
    const stageHost = new PocketHost();
    host = stageHost;
    let textureReady = false;
    const hostReady = stageHost.mount(screenCanvas, {
      wasmUrl: "/pg/pocketjs.wasm",
      keyboardTarget: canvas,
      showHud: false,
      idleAfterMs: 1200,
      onBlit: () => {
        if (!textureReady || !screenTexture) return;
        screenTexture.needsUpdate = true;
        invalidate();
      },
      onError: (error) => {
        releaseButton();
        root.classList.add("has-error");
        status.textContent = "The Pocket app stopped unexpectedly.";
        console.error("Pocket Stage guest failed", error);
      },
    });

    const profileResponse = await fetch(STAGE_ROOT + "psp-profile.json").then(failResponse);
    const profile = await profileResponse.json();
    // The package's view block is the same camera authority the native
    // pocket-stage runtime reads; the adapter carries no model facts.
    const view = profile.view ?? {};
    camera.fov = view.fov_y_degrees ?? camera.fov;
    camera.updateProjectionMatrix();
    camera.position.fromArray(view.desk_position_mm ?? [0, 46, 190]);
    controls.target.fromArray(view.desk_target_mm ?? [0, 0, 0]);
    controls.update();
    focusDistanceMm = view.focus_distance_mm ?? focusDistanceMm;
    // The stage boots the Pocket Launcher (LAUNCHER.md) — the same
    // multi-app deck the PSP EBOOT ships, on the wasm core. Each app
    // arrives as a `.pocket` package (spec/pocket-package.ts, footer-hash
    // verified on decode); the wasm host renders the psp variant, exactly
    // like the handheld. apps.json is the registry twin next to them.
    const bundleCache = new Map();
    const fetchBundle = async (output) => {
      if (!bundleCache.has(output)) {
        bundleCache.set(
          output,
          fetch(STAGE_ROOT + "apps/" + output + ".pocket")
            .then(failResponse)
            .then((r) => r.arrayBuffer())
            .then((buffer) => {
              const pkg = decodePocketPackage(new Uint8Array(buffer));
              const variant = findVariant(pkg, "psp");
              if (!variant) throw new Error(output + ".pocket has no psp variant");
              const js = findSection(variant, POCKET_SECTION.js);
              const pak = findSection(variant, POCKET_SECTION.pak) ?? new Uint8Array(0);
              // The js section carries its QuickJS NUL — strip it for eval-
              // by-source; copy the pak out of the shared package buffer.
              return {
                js: new TextDecoder().decode(js.subarray(0, js.length - 1)),
                pak: pak.slice().buffer,
              };
            }),
        );
      }
      return bundleCache.get(output);
    };
    const loader = new GLTFLoader();
    const [model, registryResponse, launcherBundle] = await Promise.all([
      loader.loadAsync(STAGE_ROOT + profile.lods.orbit),
      fetch(STAGE_ROOT + "apps/apps.json").then(failResponse),
      fetchBundle("launcher-main"),
      hostReady,
    ]);
    const registry = await registryResponse.json();
    stageHost.enableAppSwitching({
      launcher: "launcher-main",
      apps: registry.apps,
      fetchBundle,
      onSwitch: () => invalidate(),
    });
    const { js: appSource, pak } = launcherBundle;

    screenTexture = new THREE.CanvasTexture(screenCanvas);
    screenTexture.colorSpace = THREE.SRGBColorSpace;
    screenTexture.flipY = false;
    screenTexture.generateMipmaps = false;
    screenTexture.minFilter = THREE.LinearFilter;
    screenTexture.magFilter = THREE.LinearFilter;
    textureReady = true;

    const canonical = canonicalizeModel(model.scene, profile);
    bindPackageMaterials(canonical, profile, screenTexture);
    scene.add(canonical);
    proxyGroup = buildPickProxies(profile);
    scene.add(proxyGroup);

    stageHost.runIIFE(appSource, pak);
    screenTexture.needsUpdate = true;
    ready = true;
    root.dataset.ready = "true";
    root.classList.add("is-ready");
    status.textContent = "Pocket Stage ready";
    if (!inViewport || document.hidden) stageHost.stop();
    invalidate();

    // Warm the deck's apps once the hero is up: sequential, idle-priority —
    // a launch then swaps instantly instead of showing a fetch hold.
    const prefetch = async () => {
      for (const app of registry.apps) {
        try {
          await fetchBundle(app.output);
        } catch {
          // offline or trimmed deploy — the launch path will surface it
        }
      }
    };
    ("requestIdleCallback" in window ? requestIdleCallback : setTimeout)(prefetch);

    // Exposed only as a receipt for the local/CI browser verifier.
    globalThis.__pocketStageReceipt = () => ({
      ready,
      stageFrames: renderCount,
      guestTicks: stageHost.tickCount,
      screenFrames: stageHost.blitCount,
      focused,
      pressedPart: root.dataset.pressedPart || null,
    });
  } catch (error) {
    root.classList.add("has-error");
    status.textContent = "Pocket Stage could not be loaded.";
    console.error("Pocket Stage load failed", error);
  }
}
