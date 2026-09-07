// ===========================================================================
// archive.js -- the small amount of behaviour that is genuinely shared.
//
// Loaded with a plain <script src>, before each page's own inline script, so it
// works from file:// with no server and no modules. Everything here is a
// function on the global object; nothing runs on load.
// ===========================================================================
'use strict';

// --- the palette strip -----------------------------------------------------
// Nearly every program in this archive animates the DAC rather than the screen,
// so the row of colour registers is often the only thing actually changing.
// Five pages had grown their own copy of this; this is that code, once.
//
//   const paintStrip = paletteStrip('strip');   // 256 registers by default
//   paintStrip(x => lut[x]);                    // called per frame
//
// `colorAt` returns a packed ABGR value (what a Uint32Array view of ImageData
// wants on a little-endian machine, which is what the ports already build).
function paletteStrip(id, n) {
  const cv = document.getElementById(id);
  if (!cv) return () => {};
  n = n || +cv.getAttribute('width') || 256;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(n, 16);
  const px = new Uint32Array(img.data.buffer);
  return function paint(colorAt) {
    for (let x = 0; x < n; x++) {
      const c = colorAt(x);
      for (let y = 0; y < 16; y++) px[y * n + x] = c;
    }
    ctx.putImageData(img, 0, 0);
  };
}

// --- status lines -----------------------------------------------------------
// The status readout under each demo is centre-aligned, so anything that changes
// its LENGTH slides the whole line sideways. A counter going 9 -> 10 does it; at
// 60 fps the result reads as a blur rather than as text. Pad every field that
// varies.
//   `step ${w(step, 2)}/64   x ${w(px)}`
function w(v, n = 4) { return String(v).padStart(n); }
function wl(v, n) { return String(v).padEnd(n); }

// --- showing one of several hidden siblings --------------------------------
// Used for the per-demo notes, and for options that only apply to one demo.
// Keys are matched against a data- attribute, so the wiring is visible in the
// markup rather than held in a map that can drift out of step with it.
function showByData(containerId, attr, key) {
  const host = document.getElementById(containerId);
  if (!host) return;
  for (const el of host.children)
    el.hidden = el.dataset[attr] !== String(key);
}
