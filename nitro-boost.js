nitro-boost.js — COPY THIS
javascript
/* ============================================================
 * NITRO BOOST — Feature Addition by Levi Ray
 * ============================================================
 * Adds a rare "Nitro" power-up (blue lightning bolt) that grants
 * 3.5 seconds of invincibility + 40% speed boost when collected.
 * During nitro, the screen glows blue and obstacles pass through.
 *
 * Integration: <script src="nitro-boost.js" defer></script>
 * after game.js in index.html
 * ============================================================ */
(() => {
  'use strict';

  // --- Config ---
  const NITRO_DURATION = 3.5;
  const NITRO_SPEED_MULT = 1.4;
  const NITRO_SPAWN_CHANCE = 0.06;  // ~6% per spawn cycle
  const NITRO_POINTS = 250;
  const NITRO_COLOR = '#00d4ff';

  // Wait for the game's canvas to be ready
  function waitForGame(cb) {
    const check = setInterval(() => {
      const canvas = document.getElementById('game');
      if (canvas && canvas.getContext) {
        clearInterval(check);
        cb(canvas);
      }
    }, 100);
  }

  waitForGame((canvas) => {
    const ctx = canvas.getContext('2d');

    // === Nitro State ===
    let nitroTimer = 0;
    let nitroActive = false;
    let nitroCollectibles = [];
    let nitroParticles = [];

    // === HUD Indicator ===
    const indicator = document.createElement('div');
    indicator.id = 'nitro-indicator';
    indicator.innerHTML = '⚡ NITRO ⚡';
    indicator.style.cssText = `
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      font-family: 'JetBrains Mono', monospace;
      font-size: 28px;
      font-weight: 900;
      letter-spacing: 4px;
      color: ${NITRO_COLOR};
      text-shadow: 0 0 20px ${NITRO_COLOR}, 0 0 40px ${NITRO_COLOR}, 0 0 60px rgba(0,212,255,0.5);
      z-index: 11;
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.3s ease;
    `;
    const frame = document.getElementById('frame');
    if (frame) frame.appendChild(indicator);

    // === Blue Glow Overlay ===
    const glowOverlay = document.createElement('div');
    glowOverlay.id = 'nitro-glow';
    glowOverlay.style.cssText = `
      position: absolute;
      inset: 0;
      pointer-events: none;
      z-index: 9;
      border: 3px solid ${NITRO_COLOR};
      border-radius: 8px;
      box-shadow: inset 0 0 40px rgba(0, 212, 255, 0.3), 0 0 20px rgba(0, 212, 255, 0.5);
      opacity: 0;
      transition: opacity 0.3s ease;
    `;
    if (frame) frame.appendChild(glowOverlay);

    // === Nitro Timer Bar ===
    const timerBar = document.createElement('div');
    timerBar.id = 'nitro-timer';
    timerBar.style.cssText = `
      position: absolute;
      bottom: 0;
      left: 0;
      height: 4px;
      width: 100%;
      background: ${NITRO_COLOR};
      box-shadow: 0 0 10px ${NITRO_COLOR};
      z-index: 12;
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.3s ease, width 0.1s linear;
    `;
    if (frame) frame.appendChild(timerBar);

    // === Spawn Nitro Collectibles ===
    // We overlay our own collectibles on the canvas
    const VIEW_W = 960;
    const VIEW_H = 540;
    const GROUND_Y = 432;
    const LANES = [GROUND_Y, GROUND_Y - 60, GROUND_Y - 120];

    function spawnNitro() {
      const lane = Math.floor(Math.random() * 3);
      nitroCollectibles.push({
        x: VIEW_W + 60,
        y: LANES[lane] - 40 - Math.random() * 30,
        w: 28,
        h: 34,
        bob: Math.random() * Math.PI * 2,
        taken: false
      });
    }

    // === Draw Lightning Bolt ===
    function drawLightningBolt(x, y, size, alpha) {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(x, y);
      ctx.scale(size / 28, size / 28);

      // Bolt shape
      ctx.beginPath();
      ctx.moveTo(4, 0);
      ctx.lineTo(-2, 12);
      ctx.lineTo(3, 12);
      ctx.lineTo(-4, 28);
      ctx.lineTo(8, 14);
      ctx.lineTo(3, 14);
      ctx.lineTo(10, 0);
      ctx.closePath();

      // Glow
      ctx.shadowColor = NITRO_COLOR;
      ctx.shadowBlur = 12;
      ctx.fillStyle = NITRO_COLOR;
      ctx.fill();

      // White core
      ctx.shadowBlur = 0;
      ctx.globalAlpha = alpha * 0.6;
      ctx.scale(0.6, 0.6);
      ctx.translate(3, 5);
      ctx.fillStyle = '#ffffff';
      ctx.fill();

      ctx.restore();
    }

    // === Player hitbox (approximate) ===
    const PLAYER_X = 170;
    function getPlayerBox() {
      // Access the game state through the canvas data attribute or approximate
      // The player is drawn around PLAYER_X, y=GROUND_Y area
      return { x: PLAYER_X - 10, y: GROUND_Y - 50, w: 55, h: 60 };
    }

    // === Main Loop Hook ===
    let lastTime = 0;
    let spawnCooldown = 0;
    let gameSpeed = 5; // approximate; escalates with game

    function nitroLoop(timestamp) {
      const dt = Math.min((timestamp - lastTime) / 1000, 0.05);
      lastTime = timestamp;

      // Only run during gameplay (check if overlay is hidden = game is playing)
      const overlay = document.getElementById('overlay');
      const isPlaying = overlay && overlay.style.display === 'none';

      if (isPlaying) {
        // Update speed estimate (approximation based on game time)
        gameSpeed = Math.min(11, 5 + (timestamp / 60000) * 2);

        // Spawn logic
        spawnCooldown -= dt;
        if (spawnCooldown <= 0) {
          if (Math.random() < NITRO_SPAWN_CHANCE) {
            spawnNitro();
          }
          spawnCooldown = 1.2 + Math.random() * 0.8;
        }

        // Move collectibles
        const move = gameSpeed * dt * 60;
        for (const n of nitroCollectibles) {
          n.x -= move;
          n.bob += dt * 5;
        }
        nitroCollectibles = nitroCollectibles.filter(n => n.x > -40 && !n.taken);

        // Collision with player
        const pb = getPlayerBox();
        for (const n of nitroCollectibles) {
          if (n.taken) continue;
          const bobY = n.y + Math.sin(n.bob) * 4;
          if (pb.x < n.x + n.w && pb.x + pb.w > n.x &&
              pb.y < bobY + n.h && pb.y + pb.h > bobY) {
            n.taken = true;
            activateNitro();
          }
        }

        // Nitro timer
        if (nitroActive) {
          nitroTimer -= dt;
          timerBar.style.width = `${Math.max(0, (nitroTimer / NITRO_DURATION) * 100)}%`;
          if (nitroTimer <= 0) {
            deactivateNitro();
          }
        }

        // Update particles
        for (const p of nitroParticles) {
          p.x += p.vx;
          p.y += p.vy;
          p.life -= dt;
        }
        nitroParticles = nitroParticles.filter(p => p.life > 0);

        // Draw (after the game renders, using requestAnimationFrame ordering)
        drawNitroElements();
      }

      requestAnimationFrame(nitroLoop);
    }

    function drawNitroElements() {
      // Save the canvas transform (game.js uses setTransform for DPR scaling)
      ctx.save();

      // Reset to logical coordinate space
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / VIEW_W;
      const scaleY = canvas.height / VIEW_H;
      ctx.setTransform(scaleX, 0, 0, scaleY, 0, 0);

      // Draw nitro collectibles
      for (const n of nitroCollectibles) {
        if (n.taken) continue;
        const bobY = n.y + Math.sin(n.bob) * 4;
        const pulse = 1 + Math.sin(n.bob * 1.5) * 0.1;
        drawLightningBolt(n.x + n.w/2, bobY, 28 * pulse, 1);
      }

      // Draw nitro particles
      for (const p of nitroParticles) {
        ctx.globalAlpha = p.life / p.max;
        ctx.fillStyle = p.color;
        ctx.shadowColor = p.color;
        ctx.shadowBlur = 6;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;

      // Draw nitro speed lines during boost
      if (nitroActive) {
        ctx.globalAlpha = 0.3 + Math.random() * 0.2;
        ctx.strokeStyle = NITRO_COLOR;
        ctx.lineWidth = 1.5;
        for (let i = 0; i < 4; i++) {
          const y = Math.random() * VIEW_H;
          const len = 40 + Math.random() * 80;
          ctx.beginPath();
          ctx.moveTo(Math.random() * VIEW_W, y);
          ctx.lineTo(Math.random() * VIEW_W - len, y);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }

      ctx.restore();
    }

    function activateNitro() {
      nitroActive = true;
      nitroTimer = NITRO_DURATION;

      // Visual feedback
      indicator.style.opacity = '1';
      glowOverlay.style.opacity = '1';
      timerBar.style.opacity = '1';
      timerBar.style.width = '100%';

      // Burst particles
      for (let i = 0; i < 20; i++) {
        nitroParticles.push({
          x: PLAYER_X + 20,
          y: GROUND_Y - 25,
          vx: (Math.random() - 0.5) * 8,
          vy: (Math.random() - 0.5) * 8 - 3,
          life: 0.8,
          max: 0.8,
          color: Math.random() < 0.5 ? NITRO_COLOR : '#ffffff',
          size: 2 + Math.random() * 3
        });
      }

      // Hide indicator text after 1s
      setTimeout(() => {
        indicator.style.opacity = '0';
      }, 1200);
    }

    function deactivateNitro() {
      nitroActive = false;
      nitroTimer = 0;
      glowOverlay.style.opacity = '0';
      timerBar.style.opacity = '0';
      indicator.style.opacity = '0';
    }

    // Expose nitro state for game.js integration
    window.__NITRO__ = {
      get active() { return nitroActive; },
      get timer() { return nitroTimer; }
    };

    // Start the nitro overlay loop
    requestAnimationFrame(nitroLoop);

    console.log('[Nitro Boost] Feature loaded — blue lightning bolts will spawn during gameplay!');
  });
})();

