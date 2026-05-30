// ============================================================
// gta/bridge-stub.js — documents + stubs the host-game bridges
// ------------------------------------------------------------
// The crime-sandbox layer is designed to run inside the Weekend Road Trip game's
// on-foot mode (onfoot3d.js). In that real environment two global bridges exist:
//
//   window.__roadtrip   (published by game.js — READ ONLY)
//     .state.screen     'title'|'playing'|'paused'|'win'|...  (we only read this)
//     .SCREEN           enum of screen ids
//     ... (driving-sim state we DON'T touch)
//
//   window.ONFOOT       (published by onfoot3d.js)
//     .active           bool — is the on-foot sandbox currently showing
//     .ready            bool
//     .enter() / .exit()
//     .unlocked()       bool — has the player finished the trip at least once
//
// The standalone demo (gta/boot.js) does NOT need these — it is its own host.
// This stub only exists so that integration-aware code paths (and tests of them)
// have something to read when running outside the real game. Importing it is
// optional; boot.js does not. On real integration, DELETE this file — the real
// bridges already exist.
// ============================================================

if (typeof window !== 'undefined') {
  if (!window.__roadtrip) {
    window.__roadtrip = {
      state: { screen: 'onfoot' },
      SCREEN: { TITLE: 'title', PLAYING: 'playing', PAUSED: 'paused', WIN: 'win', INITIALS: 'initials' },
      // the real bridge has much more; the sandbox layer reads only state.screen
      __stub: true,
    };
  }
  if (!window.ONFOOT) {
    window.ONFOOT = {
      active: true, ready: true,
      enter() {}, exit() {},
      unlocked: () => true,
      __stub: true,
    };
  }
}

export const isStub = true;
