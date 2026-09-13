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

// --- the 4:3 correction -----------------------------------------------------
// A 386 put every one of these modes on a 4:3 monitor, so the pixels were not
// square and the demos are not honest drawn 1:1. archive.css does the stretch;
// this installs the control that lets you see it either way, because the
// distortion is itself part of what the archive records -- CIRCLE.PAS draws
// circles that were round on the glass and are eggs in a browser.
//
// Call once per page, at the end of the page's own script, by which time the
// canvas is at whatever size the demo starts in:
//
//   screenAspect();          // or screenAspect('someOtherCanvasId')
//
// The choice is remembered across the ring in localStorage. Backing stores
// that change with the demo (cube, fun, modex, pcx all reassign canvas.width)
// are picked up from the attributes themselves, so a page needs to say nothing
// when it switches mode. A canvas carrying `data-native` is exempt: it is not
// a picture of a screen, and is always drawn 1:1.
function screenAspect(id) {
  const cv = document.getElementById(id || 'screen');
  if (!cv) return;
  const root = document.documentElement;

  let stored = null;
  try { stored = localStorage.getItem('turbo.par'); } catch (e) {}
  if (stored === 'sq') root.dataset.par = 'sq';

  const bar = document.createElement('div');
  bar.className = 'parbar';
  const btn = document.createElement('button');
  const note = document.createElement('span');
  bar.append(btn, note);
  cv.after(bar);

  function label() {
    const w = cv.width, h = cv.height;
    const native = cv.hasAttribute('data-native');
    const square = native || root.dataset.par === 'sq';

    // The pixel aspect ratio: how wide a pixel was for its height, given that
    // this backing store was stretched across a 4:3 screen.
    const par = (4 / 3) * h / w;
    const round = Math.abs(par - 1) < 0.005;   // 640x480: square to begin with
    const shape = round ? 'square pixels on a 4:3 screen, nothing to correct'
      : par > 1 ? 'pixels ' + par.toFixed(2) + '× wider than tall, as VGA made them'
                : 'pixels ' + (1 / par).toFixed(2) + '× taller than wide, as VGA made them';

    btn.textContent = square ? '1:1' : '4:3';
    btn.title = square ? 'stretch to 4:3, as the monitor did'
                       : 'show the backing store 1:1, square pixels';
    note.innerHTML = '<b>' + w + '×' + h + '</b> · ' + (
      native  ? 'video memory, not a screen — always shown 1:1'
      : square ? 'square pixels, as the browser makes them'
               : shape);
  }

  btn.addEventListener('click', () => {
    const square = root.dataset.par === 'sq';
    if (square) delete root.dataset.par; else root.dataset.par = 'sq';
    try { localStorage.setItem('turbo.par', square ? '43' : 'sq'); } catch (e) {}
    label();
  });

  // canvas.width = n writes the content attribute, so the pages that resize
  // themselves mid-demo are caught here without having to call anything.
  function sync() {
    cv.style.setProperty('--nat', (cv.width / cv.height).toFixed(4));
    label();
  }
  new MutationObserver(sync).observe(cv,
    { attributes: true, attributeFilter: ['width', 'height', 'data-native'] });
  sync();
}

// --- the sub-demo strip -----------------------------------------------------
// A <select> shows one of N and says nothing about the rest, which is how a page
// with seven programs on it came to look like a page with one. This lays every
// option out as a row of buttons in the selector's place, and gives each a URL:
// fun.html#fun3 opens on FUN3. The <select> stays in the markup, hidden, as the page's source of truth
// -- every page already reacts to its `change` event, so this drives the demo
// through exactly the path the dropdown did and no demo code has to know.
//
// Call once, at the end of the page's own script:
//
//   demoStrip('variant');
//
// A button's label is the last word before the option's first ": ", which is
// the file or pattern name on every page ("FUN3.PAS", "P12", "BOX"). An option
// can override that with data-label.
// The option's full text is the button's tooltip.
//
// If the page has a <div id="notes" class="captions">, the strip also shows the
// caption whose data-note matches the chosen option, so a caption page needs no
// code of its own to keep them in step.
//
// The address is kept with replaceState rather than pushed, so the back button
// leaves the page instead of stepping back through every demo you looked at.
//
// A link anywhere on the page to one of the options -- <a href="#asmbox2"> in
// the prose -- selects that demo and scrolls the strip to the top of the
// window, so the narrative can say "press W" and put the thing to press W at
// in front of you. Opening the page at such an address does the same.
function demoStrip(selectId) {
  const sel = document.getElementById(selectId);
  if (!sel) return;
  const row = sel.closest('.panel') || sel.parentNode;
  const opts = Array.from(sel.options);

  const bar = document.createElement('div');
  bar.className = 'demos';
  bar.setAttribute('role', 'tablist');
  const captions = document.querySelector('#notes.captions');

  const says = o => o.textContent.replace(/\s+/g, ' ').trim();
  const buttons = opts.map((o, i) => {
    const b = document.createElement('button');
    b.textContent = o.dataset.label || says(o).split(': ')[0].split(' ').pop();
    b.title = says(o);
    b.setAttribute('role', 'tab');
    // A pointer click hands the keyboard straight back to the demo -- several
    // pages read keys and ignore them while a button has focus. A keyboard
    // activation (detail 0) keeps focus, so Tab and Enter still walk the strip.
    b.addEventListener('click', e => { pick(i, true); if (e.detail) b.blur(); });
    bar.appendChild(b);
    return b;
  });

  sel.hidden = true;
  row.insertBefore(bar, sel);

  function show() {
    const i = sel.selectedIndex;
    buttons.forEach((b, k) => b.setAttribute('aria-selected', String(k === i)));
    if (captions) showByData('notes', 'note', sel.value);
  }
  function pick(i, byReader) {
    if (i !== sel.selectedIndex) {
      sel.selectedIndex = i;
      for (const t of ['change', 'input']) sel.dispatchEvent(new Event(t));
    }
    if (byReader) history.replaceState(null, '', '#' + encodeURIComponent(sel.value));
    show();
  }
  const find = hash => opts.findIndex(o => o.value === decodeURIComponent(hash.slice(1)));
  const reveal = how => row.scrollIntoView({ block: 'start', behavior: how });

  function fromHash(how) {
    const k = find(location.hash);
    if (k < 0) return;
    pick(k, false);
    if (how) reveal(how);
  }

  // Handled here rather than left to the browser: a link to the demo already
  // chosen changes no hash, so the browser would fire nothing and not scroll.
  document.addEventListener('click', e => {
    const a = e.target.closest && e.target.closest('a[href^="#"]');
    if (!a) return;
    const k = find(a.getAttribute('href'));
    if (k < 0) return;
    e.preventDefault();
    pick(k, true);
    reveal('smooth');
  });

  sel.addEventListener('change', show);
  window.addEventListener('hashchange', () => fromHash('smooth'));
  fromHash(location.hash ? 'auto' : null);
  show();
}

// --- controls under the screen ----------------------------------------------
// Restart (and pause, where a page has one) is about the picture, so it lives
// in the bar directly under the picture, beside the aspect toggle: one home on
// every page whatever sits above the canvas. The elements are moved, not
// copied, so every listener the page already bound to them still fires. A
// panel left with nothing in it is removed, which is what stops a page with a
// single demo spending a whole row on one restart button.
//
// Call after screenAspect(), which is what builds the bar:
//
//   screenAspect();
//   underScreen('restart');
function underScreen(...ids) {
  const bar = document.querySelector('.parbar');
  if (!bar) return;
  const group = document.createElement('span');
  group.className = 'parctl';
  for (const id of ids) {
    const el = document.getElementById(id);
    if (!el) continue;
    const from = el.parentNode;
    group.appendChild(el);
    if (from && from.classList.contains('panel') && !from.children.length) from.remove();
  }
  if (group.children.length) bar.prepend(group);
}

// --- the ROM font ------------------------------------------------------------
// Every program here that puts text on the screen used the same font: the IBM
// PC's 8x8 character generator in ROM. PALETTE2 and its family read it
// directly (Mem[$F000:$FA6E + n*8 + row]); jmodex's print routines ask the video
// BIOS for the same table (INT 10h, AX=1130h, "ROM 8x8 Char Set"); and BGI's
// OutTextXY in BOX draws through EGAVGA.BGI, which also addresses F000:FA6E --
// Borland never shipped a copy of its own.
//
// These are those 1,024 bytes, taken from ROM_8X8.FNT in MODEX.ZIP, the Mode X
// download of 22 March 1995, where Matt Pritchard had dumped the table (public
// domain, like the rest of the library). Characters 0-127, one byte per row,
// high bit leftmost. The upper half of the character set lived behind a
// separate vector and is not in the file; no demo here prints any of it.
//
// Decoded the first time it is asked for, not on load.
function romFont() {
  if (!romFont.t) {
    const s = atob(
      'AAAAAAAAAAB+gaWBvZmBfn7/2//D5/9+bP7+/nw4EAAQOHz+fDgQADh8OP7+fDh8EBA4fP58OHwA' +
      'ABg8PBgAAP//58PD5///ADxmQkJmPAD/w5m9vZnD/w8HD33MzMx4PGZmZjwYfhg/Mz8wMHDw4H9j' +
      'f2NjZ+bAmVo85+c8WpmA4Pj++OCAAAIOPv4+DgIAGDx+GBh+PBhmZmZmZgBmAH/b23sbGxsAPmM4' +
      'bGw4zHgAAAAAfn5+ABg8fhh+PBj/GDx+GBgYGAAYGBgYfjwYAAAYDP4MGAAAADBg/mAwAAAAAMDA' +
      'wP4AAAAkZv9mJAAAABg8fv//AAAA//9+PBgAAAAAAAAAAAAAMHh4MDAAMABsbGwAAAAAAGxs/mz+' +
      'bGwAMHzAeAz4MAAAxswYMGbGADhsOHbczHYAYGDAAAAAAAAYMGBgYDAYAGAwGBgYMGAAAGY8/zxm' +
      'AAAAMDD8MDAAAAAAAAAAMDBgAAAA/AAAAAAAAAAAADAwAAYMGDBgwIAAfMbO3vbmfAAwcDAwMDD8' +
      'AHjMDDhgzPwAeMwMOAzMeAAcPGzM/gweAPzA+AwMzHgAOGDA+MzMeAD8zAwYMDAwAHjMzHjMzHgA' +
      'eMzMfAwYcAAAMDAAADAwAAAwMAAAMDBgGDBgwGAwGAAAAPwAAPwAAGAwGAwYMGAAeMwMGDAAMAB8' +
      'xt7e3sB4ADB4zMz8zMwA/GZmfGZm/AA8ZsDAwGY8APhsZmZmbPgA/mJoeGhi/gD+Ymh4aGDwADxm' +
      'wMDOZj4AzMzM/MzMzAB4MDAwMDB4AB4MDAzMzHgA5mZseGxm5gDAwMDAwMD8AMbu/v7WxsYAxub2' +
      '3s7GxgA4bMbGxmw4APxmZnxgYPAAeMzMzNx4HAD8ZmZ8bGbmAHjM4HAczHgA/LQwMDAweADMzMzM' +
      'zMz8AMzMzMzMeDAAxsbG1v7uxgDGxmw4OGzGAMzMzHgwMHgA/saMGDJm/gB4YGBgYGB4AMBgMBgM' +
      'BgIAeBgYGBgYeAAQOGzGAAAAAAAAAAAAAAD/MDAYAAAAAAAAAHgMfMx2AOBgYHxmZtwAAAB4zMDM' +
      'eAAcDAx8zMx2AAAAeMz8wHgAOGxg8GBg8AAAAHbMzHwM+OBgbHZmZuYAMABwMDAweAAMAAwMDMzM' +
      'eOBgZmx4bOYAcDAwMDAweAAAAMz+/tbGAAAA+MzMzMwAAAB4zMzMeAAAANxmZnxg8AAAdszMfAwe' +
      'AADcdmZg8AAAAHzAeAz4ABAwfDAwNBgAAADMzMzMdgAAAMzMzHgwAAAAxtb+/mwAAADGbDhsxgAA' +
      'AMzMzHwM+AAA/JgwZPwAHDAw4DAwHAAYGBgAGBgYAOAwMBwwMOAAdtwAAAAAAAAAEDhsxsb+AA==');
    romFont.t = new Uint8Array(1024);
    for (let i = 0; i < 1024; i++) romFont.t[i] = s.charCodeAt(i);
  }
  return romFont.t;
}

// Draw `str` in the ROM font, one 8x8 cell per character from (x0, y0), by
// calling plot(x, y) for every set pixel. The page supplies plot, because every
// page keeps its own framebuffer -- and does its own clipping, the way the
// original routines did not.
//
//   romText('Meow?', 20, 40, (x, y) => setPoint(x, y, col));
function romText(str, x0, y0, plot) {
  const f = romFont();
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c > 127) continue;
    for (let row = 0; row < 8; row++) {
      const bits = f[c * 8 + row];
      if (bits) for (let col = 0; col < 8; col++)
        if (bits & (0x80 >> col)) plot(x0 + i * 8 + col, y0 + row);
    }
  }
}
