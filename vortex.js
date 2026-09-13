// ===========================================================================
// vortex.js -- a vortex, drawn the way a 386 could have drawn it.
//
// No DOM in here: the page supplies a canvas, this supplies an 8-bit framebuffer
// and a 256-register palette, and a script outside the browser can run the
// same code and look at the frames. It is also meant to read like the thing an
// assembly version would be: integers throughout the per-frame work, lookup
// tables where a 386 would want them, 16.16 fixed point for positions, 6-bit
// DAC values, Turbo Pascal's random number generator.
//
// THE FLOW is a Burgers vortex (J. M. Burgers, 1948), an exact solution of the
// Navier-Stokes equations with the anatomy of the schematic this was made
// after: fluid drawn inward in a plane, stretched along the axis and thrown out
// of both ends, spinning fastest in a core. In units where the inflow starts at
// radius 1, with the axis vertical (world y):
//
//     radial     -A r / 2          axial    A y
//     swirl      w(r) = W0 (1 - e^-(r^2/C)) / (r^2/C)     radians per second
//
// w is written as a function of r^2, so the per-particle cost is one lookup: no
// square root for r, no division by it. Near the axis it tends to W0, so it is
// finite everywhere.
//
//   createVortex({ width, height, mode: 'palette'|'particles',
//                  lines, count, truecolor, seed })
//     .frame()        advance one frame and draw it
//     .render(out)    fill a Uint32Array of ABGR pixels
//     .lut            the palette as ABGR, for the DAC strip
// ===========================================================================
'use strict';

function createVortex(opt) {
  const W = opt.width, H = opt.height;
  const S = W / 320;                     // every screen constant is for 320x240
  const AGES = 32, DEPTHS = 4, HUES = 2; // 2 x 4 x 32 = the whole DAC

  // --- Turbo Pascal's generator ---------------------------------------------
  let seed = (opt.seed >>> 0) || 12345;
  const random = n => { seed = (Math.imul(seed, 134775813) + 1) >>> 0;
                        return Math.floor(seed / 4294967296 * n); };

  // --- tables -----------------------------------------------------------------
  // Sine: 1024 steps to a turn, Q12.
  const SIN = new Int32Array(1024);
  for (let i = 0; i < 1024; i++) SIN[i] = Math.round(Math.sin(i * Math.PI / 512) * 4096);
  const sin = a => SIN[a & 1023], cos = a => SIN[(a + 256) & 1023];

  // The flow, per frame at 35 fps (one frame = two retraces of a 70 Hz VGA).
  const A = 0.55, DT = 1 / 35, C = 0.045, W0 = 20;
  const KR = Math.round(A / 2 * DT * 65536);   // Q16 radial shrink per frame
  const KY = Math.round(A * DT * 65536);       // Q16 axial stretch per frame
  // Angular step per frame, Q12 radians, indexed by r^2 (Q12) >> 3.
  const OMEGA = new Int32Array(1024);
  for (let i = 0; i < 1024; i++) {
    const q = Math.max(1e-6, (i << 3) / 4096 / C);
    OMEGA[i] = Math.round(W0 * DT * (1 - Math.exp(-q)) / q * 4096);
  }
  const YMAX = Math.round(1.45 * 65536);       // out of the top or bottom: respawn
  const CORE2 = Math.round(0.24 * 0.24 * 4096); // r^2 (Q12) inside which it is orange

  // --- the palette --------------------------------------------------------------
  // Register (h*4 + d)*32 + j. At frame F, register j of a ramp shows the brightness
  // of age (F - j) mod 32, so a pixel written in index F mod 32 starts bright and
  // dims by itself as the palette turns -- nothing is ever redrawn to fade it.
  const HUE = [[12, 50, 63], [63, 34, 8]];      // 6-bit: cyan, orange
  const GAIN = [64, 44, 30, 20];                // depth band 0 is nearest
  const RAMP = new Int32Array(AGES);
  for (let a = 0; a < AGES; a++) RAMP[a] = Math.round(64 * Math.pow(1 - a / AGES, 2.2));
  const dac = new Uint8Array(768);
  const lut = new Uint32Array(256);

  function setPalette(F) {
    for (let h = 0; h < HUES; h++)
      for (let d = 0; d < DEPTHS; d++)
        for (let j = 0; j < AGES; j++) {
          const reg = (h * DEPTHS + d) * AGES + j, a = (F - j) & (AGES - 1);
          const b = RAMP[a] * GAIN[d];            // Q12
          const hot = a < 2 ? (2 - a) * 10 : 0;   // the newest two steps run toward white
          for (let k = 0; k < 3; k++) {
            const v = (HUE[h][k] * b >> 12) + (hot * GAIN[d] >> 6);
            dac[reg * 3 + k] = v > 63 ? 63 : v;
          }
        }
    dac[0] = dac[1] = dac[2] = 0;                 // register 0 is the background
    for (let r = 0; r < 256; r++) {
      const q = r * 3, c = v => (dac[q + v] << 2) | (dac[q + v] >> 4);
      lut[r] = (255 << 24) | (c(2) << 16) | (c(1) << 8) | c(0);
    }
  }

  // --- the framebuffer, and the pixels waiting to be erased ---------------------
  const fb = new Uint8Array(W * H);
  const truecolor = opt.mode === 'particles' && !!opt.truecolor;
  const rgb = truecolor ? new Float32Array(W * H * 3) : null;
  // One list per palette step: the pixels written in that frame. They are
  // erased 32 frames later, just before their index would come round bright
  // again -- unless something newer has been drawn over them since.
  const slotA = [], slotV = [], slotN = new Int32Array(AGES);
  for (let s = 0; s < AGES; s++) { slotA.push(new Int32Array(4096)); slotV.push(new Uint8Array(4096)); }
  let slot = 0;

  function put(a, v) {
    fb[a] = v;
    let n = slotN[slot];
    if (n === slotA[slot].length) {
      const A2 = new Int32Array(n * 2), V2 = new Uint8Array(n * 2);
      A2.set(slotA[slot]); V2.set(slotV[slot]); slotA[slot] = A2; slotV[slot] = V2;
    }
    slotA[slot][n] = a; slotV[slot][n] = v; slotN[slot] = n + 1;
  }
  function eraseSlot(s) {
    const As = slotA[s], Vs = slotV[s];
    for (let i = 0, n = slotN[s]; i < n; i++) if (fb[As[i]] === Vs[i]) fb[As[i]] = 0;
    slotN[s] = 0;
  }

  // Bresenham, as every line in this archive was drawn.
  function line(x0, y0, x1, y1, v, record) {
    let dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
    let dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1, err = dx + dy;
    for (;;) {
      if (x0 >= 0 && x0 < W && y0 >= 0 && y0 < H) {
        const a = y0 * W + x0;
        if (record) put(a, v); else fb[a] = v;
      }
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }
  // The true-color path: lines added into floating-point RGB. Brightness is
  // scaled by particle density so 20,000 do not simply burn to white.
  const GLOW = 1.1 * S * 1000 / Math.max(1, opt.count || 1000);
  function glow(x0, y0, x1, y1, h, d) {
    const c = HUE[h], g = GAIN[d] / 64 * GLOW;
    let dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
    let dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1, err = dx + dy;
    for (;;) {
      if (x0 >= 0 && x0 < W && y0 >= 0 && y0 < H) {
        const a = (y0 * W + x0) * 3;
        rgb[a] += c[0] * g; rgb[a + 1] += c[1] * g; rgb[a + 2] += c[2] * g;
      }
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }

  // --- particles ------------------------------------------------------------------
  const N = opt.mode === 'particles' ? opt.count : opt.lines;
  const px = new Int32Array(N), py = new Int32Array(N), pz = new Int32Array(N);
  const r2s = new Int32Array(N);

  function spawn(i) {
    const ang = random(1024), r = 0.92 + random(1000) * 0.00016;
    px[i] = Math.round(r * cos(ang) * 16);        // Q12 table * 16 = Q16
    pz[i] = Math.round(r * sin(ang) * 16);
    py[i] = (random(2) ? 1 : -1) * (40 + random(900));
  }

  // One frame of the flow for particle i. Returns r^2, Q12.
  function advance(i) {
    let x = px[i], y = py[i], z = pz[i];
    const xs = x >> 4, zs = z >> 4;
    const r2 = (xs * xs + zs * zs) >> 12;
    x -= (x * KR + 32768) >> 16;                   // drawn in
    z -= (z * KR + 32768) >> 16;
    y += (y * KY + 32768) >> 16;                   // stretched out along the axis
    const w = OMEGA[r2 >> 3 > 1023 ? 1023 : r2 >> 3];
    x -= (z * w + 2048) >> 12;                     // turned: x from the old z,
    z += (x * w + 2048) >> 12;                     // z from the NEW x, which keeps it stable
    px[i] = x; py[i] = y; pz[i] = z;
    return r2;
  }

  // --- the camera -------------------------------------------------------------------
  // Angles in 1024ths of a turn. Pitch 0 looks at the disc edge-on (the cross);
  // 256 looks straight down the axis from above (the eye).
  // There is no yaw: the flow is the same seen from any side, and orbiting the
  // axis showed nothing but a slightly different rate of spin.
  let pitch, F, D, cx, cy;
  function setCamera(t) {
    if (opt.mode === 'palette') { pitch = 112; F = 250 * S | 0; D = 196000; cx = W >> 1; cy = H >> 1; return; }
    // ~11 deg to straight down and back every 42 s. It starts at the low end, nearly
    // edge-on, where the shape is easiest to recognise at 320 pixels across --
    // so by the time it looks straight down the axis you know what the eye is.
    pitch = 144 + (112 * sin(((t * 1024 / 1470) | 0) + 768) >> 12);
    // Zooming in with the square of the tilt: wide for most of the cycle, and 4.4
    // times closer looking straight down, where the eye opens. Short of 90 degrees
    // the upper jet's corkscrew lies across the eye; at 90 it rings it.
    const p = pitch - 32;
    F = (232 + (p * p >> 6)) * S | 0;
    D = 196000;                                              // 3.0, Q16
    cx = W >> 1; cy = H >> 1;
  }
  // Projected into sxv/syv, depth band into dband; false if behind the camera.
  let sxv = 0, syv = 0, dband = 0, zv = 0;
  function project(x, y, z) {
    const cp = cos(pitch), sp = sin(pitch);
    const y2 = (y * cp + z * sp) >> 12;
    const z2 = (z * cp - y * sp) >> 12;
    const zc = z2 + D;
    zv = z2;
    if (zc < 16384) return false;
    sxv = cx + ((x * F / zc) | 0);
    syv = cy - ((y2 * F / zc) | 0);
    let b = ((z2 + 92000) * DEPTHS / 184000) | 0;
    // Thrown out along the axis, a particle fades into the dimmer bands as it
    // goes, so the jets taper instead of ending in a block -- and seen from
    // above they no longer pile up into a bright disc where the eye should be.
    const ay = y < 0 ? -y : y, yb = ((ay - 36000) * 3 / 40000) | 0;
    if (yb > b) b = yb;
    dband = b < 0 ? 0 : b > 3 ? 3 : b;
    return true;
  }

  // --- the palette way: streamlines drawn once --------------------------------------
  // Each line is integrated from the rim until it leaves along the axis, and
  // every step is colored by how far along the line it is (plus a random phase
  // per line, or every comet would set off at once). Segments go into depth
  // buckets and are drawn far to near, a few buckets a frame, so the picture
  // builds from the back the way a slow machine would have shown it.
  const BUCKETS = 32;
  let buckets = null, bucketAt = 0;
  function buildLines() {
    setCamera(0);
    buckets = Array.from({ length: BUCKETS }, () => []);
    for (let i = 0; i < N; i++) {
      spawn(i);
      const off = random(AGES);
      let ox = 0, oy = 0, have = false;
      for (let s = 0; s < 1400; s++) {
        const r2 = advance(i);
        if (py[i] > YMAX || py[i] < -YMAX) break;
        if (!project(px[i], py[i], pz[i])) { have = false; continue; }
        const h = r2 < CORE2 ? 1 : 0;
        const v = ((h * DEPTHS + dband) * AGES + ((s + off) & (AGES - 1))) || 1;
        if (have) {
          const b = ((zv + 92000) * BUCKETS / 184000) | 0;
          buckets[b < 0 ? 0 : b >= BUCKETS ? BUCKETS - 1 : b].push(ox, oy, sxv, syv, v);
        }
        ox = sxv; oy = syv; have = true;
      }
    }
    bucketAt = BUCKETS - 1;                        // far end first
  }

  // --- the particle way ------------------------------------------------------------------
  const lastX = new Int32Array(N), lastY = new Int32Array(N);
  // Let the flow fill in before the first frame. Each particle runs its own
  // random number of frames: warmed up all together, they would spiral in as
  // one cohort and leave the outer disc nearly empty for the first half-minute.
  function buildParticles() {
    for (let i = 0; i < N; i++) {
      spawn(i); lastX[i] = -1;
      for (let t = random(1040); t > 0; t--) {
        advance(i);
        if (py[i] > YMAX || py[i] < -YMAX) spawn(i);
      }
    }
  }

  let frameNo = 0;

  function frame() {
    setPalette(frameNo);
    if (opt.mode === 'palette') {
      // a few buckets per frame until the picture is complete, then nothing at all
      for (let k = 0; k < 2 && bucketAt >= 0; k++, bucketAt--) {
        const L = buckets[bucketAt];
        for (let i = 0; i < L.length; i += 5) line(L[i], L[i + 1], L[i + 2], L[i + 3], L[i + 4], false);
      }
    } else {
      slot = frameNo & (AGES - 1);
      if (!truecolor) eraseSlot(slot);
      else for (let i = 0; i < rgb.length; i++) rgb[i] *= 0.9;
      setCamera(frameNo);
      const base = frameNo & (AGES - 1);
      for (let i = 0; i < N; i++) {
        const r2 = advance(i);
        if (py[i] > YMAX || py[i] < -YMAX) { spawn(i); lastX[i] = -1; continue; }
        if (!project(px[i], py[i], pz[i])) { lastX[i] = -1; continue; }
        const h = r2 < CORE2 ? 1 : 0;
        const x0 = lastX[i], y0 = lastY[i];
        // x0 < 0: just respawned (or last seen off the left edge), nothing to draw from.
        // Every other move is a streak, however long the zoom has made it.
        if (x0 >= 0) {
          if (truecolor) glow(x0, y0, sxv, syv, h, dband);
          else line(x0, y0, sxv, syv, ((h * DEPTHS + dband) * AGES + base) || 1, true);
        }
        lastX[i] = sxv; lastY[i] = syv;
      }
    }
    frameNo++;
  }

  function render(out) {
    if (truecolor) {
      // 1 - e^-v rolls off toward full brightness instead of clipping at it
      for (let i = 0, a = 0; i < out.length; i++, a += 3) {
        const r = 255 * (1 - Math.exp(-rgb[a] / 200)) | 0,
              g = 255 * (1 - Math.exp(-rgb[a + 1] / 200)) | 0,
              b = 255 * (1 - Math.exp(-rgb[a + 2] / 200)) | 0;
        out[i] = (255 << 24) | (b << 16) | (g << 8) | r;
      }
    } else {
      for (let i = 0; i < out.length; i++) out[i] = lut[fb[i]];
    }
  }

  if (opt.mode === 'palette') buildLines(); else buildParticles();
  return { frame, render, lut, fb, get frameNo() { return frameNo; } };
}

if (typeof module !== 'undefined') module.exports = { createVortex };
