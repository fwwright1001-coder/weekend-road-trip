// ============================================================
// gta/onfoot-render.js — post-processing + lighting "realism" pipeline for the
// on-foot 3D scene (onfoot3d.js, canvas #gamefoot).
// ------------------------------------------------------------
// Goal: make the procedural box-town look far LESS blocky while staying 100%
// code-generated (no downloaded assets). The biggest de-blocking win is proper
// anti-aliasing (SMAA) on top of an EffectComposer chain; we also add ACES tone
// mapping, an image-based-lighting environment (RoomEnvironment via PMREM) for
// real reflections on metal/clearcoat materials, a SUBTLE bloom so emissive
// signs/lights glow, and (best-effort) SSAO for contact-shadow grounding.
//
// DEFENSIVE BY DESIGN: every dynamic import + setup step is wrapped so a single
// failure can never break rendering. If anything below fails, `enabled` goes
// false and render() falls back to plain renderer.render(scene, camera). The
// SSAO add is isolated in its OWN try/catch so its failure never takes down the
// rest of the composer chain.
//
// PUBLIC API:
//   import { installRealism } from './onfoot-render.js';
//   const fx = await installRealism(THREE, renderer, scene, camera, canvas, opts);
//   // per-frame: fx.render(dt);  on resize: fx.setSize(w, h);  flag: fx.enabled
// ============================================================

/**
 * Install the realism pipeline onto an existing renderer/scene/camera.
 *
 * NOTE: this function performs dynamic `import()` of the three/addons modules,
 * so it is async and returns a Promise<{ render, setSize, enabled }>. Calling
 * code can `await` it, or just use the returned object once it resolves — the
 * returned `render`/`setSize` are always safe to call regardless of outcome.
 *
 * @param {object} THREE      the three module namespace (host-provided)
 * @param {THREE.WebGLRenderer} renderer
 * @param {THREE.Scene} scene
 * @param {THREE.Camera} camera
 * @param {HTMLCanvasElement} canvas  the #gamefoot canvas
 * @param {object} [opts]
 * @returns {Promise<{ render:(dt:number)=>void, setSize:(w:number,h:number)=>void, enabled:boolean }>}
 */
export async function installRealism(THREE, renderer, scene, camera, canvas, opts = {}) {
  // ---- tunables (overridable via opts) -------------------------------------
  const EXPOSURE      = opts.exposure        ?? 1.05;
  const MAX_PIXEL_RATIO = opts.maxPixelRatio ?? 1.5;
  const BLOOM_STRENGTH  = opts.bloomStrength ?? 0.35;
  const BLOOM_RADIUS    = opts.bloomRadius   ?? 0.4;
  const BLOOM_THRESHOLD = opts.bloomThreshold ?? 0.85;
  const SSAO_KERNEL_RADIUS = opts.ssaoKernelRadius ?? 8;
  const SSAO_MIN_DISTANCE  = opts.ssaoMinDistance ?? 0.005;
  const SSAO_MAX_DISTANCE  = opts.ssaoMaxDistance ?? 0.1;
  const ENABLE_SSAO   = opts.ssao !== false;       // default on (best-effort)
  const ENABLE_BLOOM  = opts.bloom !== false;      // default on
  const ENABLE_SMAA   = opts.smaa !== false;       // default on
  const ENABLE_ENV    = opts.environment !== false; // default on (IBL)

  // ---- mutable pipeline handles --------------------------------------------
  let composer    = null;
  let renderPass  = null;
  let ssaoPass    = null;
  let bloomPass   = null;
  let smaaPass    = null;
  let outputPass  = null;
  let pmrem       = null;
  let envTexture  = null;
  let enabled     = false;     // true only once a working composer exists

  // The fallback renderer.render is ALWAYS safe to call. We start the public
  // object pointing at it; if the composer comes up, render() switches over.
  const api = {
    enabled: false,
    render(/* dt */) {
      // overwritten on success; default = direct render
      try { renderer.render(scene, camera); } catch (_) { /* never throw */ }
    },
    setSize(w, h) {
      try {
        renderer.setPixelRatio(clampPR());
        renderer.setSize(w, h, false);
      } catch (_) { /* never throw */ }
    },
  };

  // current backing-store size (CSS px); used to size passes + render targets
  const initSize = currentSize();
  let curW = initSize.w;
  let curH = initSize.h;

  function clampPR() {
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    return Math.min(dpr, MAX_PIXEL_RATIO);
  }

  function currentSize() {
    // Prefer the renderer's own drawing-buffer size; fall back to canvas, then
    // to a sane default. Returned in CSS pixels (pixel ratio applied separately).
    let w = 0, h = 0;
    try {
      const sz = renderer.getSize(new THREE.Vector2());
      w = sz.x; h = sz.y;
    } catch (_) { /* getSize may not exist on a stub */ }
    if (!(w > 0 && h > 0)) {
      w = (canvas && canvas.clientWidth)  || (canvas && canvas.width)  || 960;
      h = (canvas && canvas.clientHeight) || (canvas && canvas.height) || 540;
    }
    return { w: Math.max(1, Math.floor(w)), h: Math.max(1, Math.floor(h)) };
  }

  // ==========================================================================
  // PHASE 1 — renderer-level realism (tone mapping, shadows, IBL). These are
  // valuable on their own even if the composer fails, so they run first and
  // each is independently guarded.
  // ==========================================================================
  try {
    if (THREE.ACESFilmicToneMapping != null) {
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
    }
    renderer.toneMappingExposure = EXPOSURE;
  } catch (e) { warn('tone mapping setup failed', e); }

  try {
    if (renderer.shadowMap) {
      renderer.shadowMap.enabled = true;
      if (THREE.PCFSoftShadowMap != null) {
        renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      }
    }
  } catch (e) { warn('shadow map setup failed', e); }

  try {
    renderer.setPixelRatio(clampPR());
  } catch (e) { warn('pixel ratio clamp failed', e); }

  // ---- image-based lighting (real reflections on metal/clearcoat) ----------
  // RoomEnvironment is a procedural lightbox scene; PMREMGenerator (core THREE)
  // pre-filters it into an environment map. Wrapped: a failure just means no
  // env reflections, not a broken renderer.
  if (ENABLE_ENV) {
    try {
      const { RoomEnvironment } = await import('three/addons/environments/RoomEnvironment.js');
      pmrem = new THREE.PMREMGenerator(renderer);
      // r0.170: RoomEnvironment() takes no args; fromScene(scene, sigma).
      const roomScene = new RoomEnvironment();
      envTexture = pmrem.fromScene(roomScene, 0.04).texture;
      scene.environment = envTexture;
      // The lightbox geometry/materials are no longer needed once baked.
      try { roomScene.traverse?.((o) => { o.geometry?.dispose?.(); }); } catch (_) {}
    } catch (e) {
      warn('IBL environment setup failed (continuing without reflections)', e);
      try { pmrem?.dispose?.(); } catch (_) {}
      pmrem = null;
      envTexture = null;
    }
  }

  // ==========================================================================
  // PHASE 2 — the EffectComposer post-processing chain. The whole block is
  // guarded; on any failure we tear down what we built and leave the fallback
  // renderer.render path in place (enabled stays false).
  // ==========================================================================
  try {
    const [
      { EffectComposer },
      { RenderPass },
      { OutputPass },
    ] = await Promise.all([
      import('three/addons/postprocessing/EffectComposer.js'),
      import('three/addons/postprocessing/RenderPass.js'),
      import('three/addons/postprocessing/OutputPass.js'),
    ]);

    composer = new EffectComposer(renderer);
    // Keep the composer's internal render targets at the clamped ratio too.
    try { composer.setPixelRatio(clampPR()); } catch (_) {}
    composer.setSize(curW, curH);

    // 1) base scene render -------------------------------------------------
    renderPass = new RenderPass(scene, camera);
    composer.addPass(renderPass);

    // 2) SSAO (ambient-occlusion grounding) — ISOLATED try/catch so a failure
    //    here never takes out SMAA/bloom/output. Added right after the scene
    //    render so AO darkens contact areas before bloom/AA.
    if (ENABLE_SSAO) {
      try {
        const { SSAOPass } = await import('three/addons/postprocessing/SSAOPass.js');
        // r0.170: SSAOPass(scene, camera, width, height, kernelSize?)
        ssaoPass = new SSAOPass(scene, camera, curW, curH);
        ssaoPass.kernelRadius = SSAO_KERNEL_RADIUS;
        ssaoPass.minDistance  = SSAO_MIN_DISTANCE;
        ssaoPass.maxDistance  = SSAO_MAX_DISTANCE;
        // Default output blends AO into the beauty pass (NORMAL). Leave as-is.
        if (SSAOPass.OUTPUT && SSAOPass.OUTPUT.Default != null) {
          ssaoPass.output = SSAOPass.OUTPUT.Default;
        }
        composer.addPass(ssaoPass);
      } catch (e) {
        warn('SSAO pass failed (skipping AO, chain continues)', e);
        try { ssaoPass?.dispose?.(); } catch (_) {}
        ssaoPass = null;
      }
    }

    // 3) SMAA — the #1 de-blocking win (edge anti-aliasing). Procedural search/
    //    area textures are generated internally, no downloaded assets.
    if (ENABLE_SMAA) {
      try {
        const { SMAAPass } = await import('three/addons/postprocessing/SMAAPass.js');
        // r0.170: SMAAPass(width, height) — note these are device pixels.
        const pr = clampPR();
        smaaPass = new SMAAPass(curW * pr, curH * pr);
        composer.addPass(smaaPass);
      } catch (e) {
        warn('SMAA pass failed (no AA)', e);
        try { smaaPass?.dispose?.(); } catch (_) {}
        smaaPass = null;
      }
    }

    // 4) subtle bloom so emissive signs/lights glow (NOT a hazy blur) -------
    if (ENABLE_BLOOM) {
      try {
        const { UnrealBloomPass } = await import('three/addons/postprocessing/UnrealBloomPass.js');
        // r0.170: UnrealBloomPass(resolution: Vector2, strength, radius, threshold)
        bloomPass = new UnrealBloomPass(
          new THREE.Vector2(curW, curH),
          BLOOM_STRENGTH,
          BLOOM_RADIUS,
          BLOOM_THRESHOLD,
        );
        composer.addPass(bloomPass);
      } catch (e) {
        warn('bloom pass failed (no glow)', e);
        try { bloomPass?.dispose?.(); } catch (_) {}
        bloomPass = null;
      }
    }

    // 5) output pass — tone mapping + sRGB conversion / gamma for the final
    //    framebuffer. Must be LAST in the chain.
    outputPass = new OutputPass();
    composer.addPass(outputPass);

    // If we got here, the composer chain is live. Switch render() onto it.
    enabled = true;
    api.enabled = true;
    api.render = function renderComposed(/* dt */) {
      try {
        composer.render();
      } catch (e) {
        // First failure: log once, then permanently fall back so we don't spam
        // and don't leave a black frame on screen.
        warn('composer.render() threw — falling back to direct render', e);
        api.render = function renderDirect() {
          try { renderer.render(scene, camera); } catch (_) {}
        };
        api.enabled = false;
        enabled = false;
        try { renderer.render(scene, camera); } catch (_) {}
      }
    };

    // Resize: renderer + composer + every size-sensitive pass.
    api.setSize = function setSizeComposed(w, h) {
      try {
        w = Math.max(1, Math.floor(w));
        h = Math.max(1, Math.floor(h));
        curW = w; curH = h;
        const pr = clampPR();
        renderer.setPixelRatio(pr);
        renderer.setSize(w, h, false);
        if (composer) {
          try { composer.setPixelRatio(pr); } catch (_) {}
          composer.setSize(w, h);
        }
        // SSAO / Bloom take CSS-pixel sizes via setSize(w, h).
        try { ssaoPass?.setSize?.(w, h); } catch (_) {}
        try { bloomPass?.setSize?.(w, h); } catch (_) {}
        // SMAA expects device pixels.
        try { smaaPass?.setSize?.(w * pr, h * pr); } catch (_) {}
      } catch (e) {
        warn('setSize failed', e);
      }
    };
  } catch (e) {
    // Composer chain failed entirely — tear down, keep fallback render path.
    warn('EffectComposer setup failed — using direct renderer.render', e);
    try { composer?.dispose?.(); } catch (_) {}
    composer = null;
    renderPass = ssaoPass = bloomPass = smaaPass = outputPass = null;
    enabled = false;
    api.enabled = false;
    // api.render / api.setSize remain the safe direct-render defaults set above.
  }

  return api;

  // ---- tiny logger (never throws, easy to silence via opts.quiet) ----------
  function warn(msg, err) {
    if (opts.quiet) return;
    try { console.warn('[onfoot-render] ' + msg, err || ''); } catch (_) {}
  }
}
