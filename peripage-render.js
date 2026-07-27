/* ============================================================
   JL Customs - render a page's print-area to PeriPage raster

   The A40a has no text mode: it prints bitmaps or nothing. So instead
   of handing HTML to Chromium's print pipeline (which needs a CUPS
   queue and a vendor driver), we render the same #print-area markup
   off-screen at the printer's exact panel width and ship the pixels.

   The markup is lifted from the *live* page so dynamically built
   estimates come through, and the page's own @media print CSS is
   reused verbatim - printed output keeps matching the old behaviour.
   ============================================================ */
'use strict';

const { BrowserWindow } = require('electron');
const peripage = require('./peripage');

// The panel is 1632 dots at 203dpi = 204mm. Lay the page out at the CSS
// pixel equivalent (96dpi) and zoom up, so type sizes stay sane rather
// than rendering 1632 CSS px wide and looking microscopic.
const CSS_WIDTH = Math.round((peripage.WIDTH_DOTS / peripage.DPI) * 96); // ~772
const ZOOM = peripage.WIDTH_DOTS / CSS_WIDTH;

const PRINT_AREA_IDS = ['print-area', 'contact-print-area'];

/** Pull the print-area markup and stylesheets out of a live page. */
async function extractPrintArea(webContents) {
  const ids = JSON.stringify(PRINT_AREA_IDS);
  return webContents.executeJavaScript(`(() => {
    const ids = ${ids};
    let el = null;
    for (const id of ids) {
      const found = document.getElementById(id);
      if (found && found.innerHTML.trim()) { el = found; break; }
    }
    if (!el) return null;
    return {
      id: el.id,
      html: el.outerHTML,
      styles: Array.from(document.querySelectorAll('style'))
        .map(s => s.textContent).join('\\n'),
      links: Array.from(document.querySelectorAll('link[rel="stylesheet"]'))
        .map(l => l.href),
      base: location.href
    };
  })()`);
}

/** Assemble a standalone document that renders just the print-area. */
function buildDocument(part) {
  const links = part.links
    .map((href) => `<link rel="stylesheet" href="${href}">`)
    .join('\n');

  // The page hides the print-area outside @media print; force it visible
  // here and strip the page background so we don't dither a dark theme
  // into a solid black sheet. Everything else about the look - padding,
  // fonts, borders - is left to the page's own #print-area CSS so the
  // printed receipt matches the design defined alongside the markup.
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<base href="${part.base}">
${links}
<style>${part.styles}</style>
<style>
  html, body {
    margin: 0; padding: 0;
    background: #fff !important;
    width: ${CSS_WIDTH}px;
    /* The source page may set body to height:100% + flex for its app layout;
       neutralise that so body wraps the print-area and its measured height is
       the real content height, not the viewport height. */
    height: auto !important;
    min-height: 0 !important;
    display: block !important;
  }
  #${part.id} {
    display: block !important;
    position: static !important;
    left: auto !important; top: auto !important;
    background: #fff !important;
  }
</style>
</head>
<body>${part.html}</body>
</html>`;
}

/**
 * Render the given window's print-area and return RGBA pixels.
 * @returns {Promise<{bitmap: Buffer, width: number, height: number}>}
 */
async function renderPrintArea(sourceWebContents) {
  const part = await extractPrintArea(sourceWebContents);
  if (!part) throw new Error('no print-area content on this page');

  const win = new BrowserWindow({
    show: false,
    width: CSS_WIDTH,
    height: 1200,
    webPreferences: {
      offscreen: true,
      nodeIntegration: false,
      contextIsolation: true,
      // The doc we build is our own markup rendered from a data URL; it
      // needs to load the app's local stylesheets via the file:// base.
      webSecurity: false
    }
  });

  try {
    const doc = buildDocument(part);
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(doc));

    // Chromium persists zoom level per-host in the session and restores it on
    // load. A stray zoom (e.g. left by another tool, or a prior run) would lay
    // the page out in a shrunken viewport and capture it clipped, so pin the
    // zoom to 1:1 explicitly before measuring anything.
    win.webContents.setZoomFactor(1);

    // Let webfonts settle before measuring.
    await win.webContents.executeJavaScript(
      'document.fonts && document.fonts.ready ? document.fonts.ready.then(() => 0) : 0'
    );

    // Wait for images (the logo) to finish loading too, or the height is
    // measured short and the capture clips the bottom off the receipt.
    await win.webContents.executeJavaScript(
      'Promise.all(Array.from(document.images).map((img) => ' +
      'img.complete ? 0 : new Promise((r) => { img.onload = img.onerror = r; })))' +
      '.then(() => 0)'
    );

    const cssHeight = await win.webContents.executeJavaScript(
      'Math.ceil(document.body.getBoundingClientRect().height)'
    );
    if (!cssHeight) throw new Error('print-area rendered with zero height');

    // Resize so the whole page is in the viewport. We deliberately do NOT
    // call setZoomFactor here: on an offscreen window it applies racily and,
    // because the content area stays at CSS width, magnifies the page into a
    // clipped viewport. Instead we capture at CSS width and let rgbaToRaster
    // upscale to the panel's dot width - deterministic, and it dithers clean.
    win.setContentSize(CSS_WIDTH, cssHeight);

    // Let the resize paint a frame.
    await new Promise((r) => setTimeout(r, 150));

    const image = await win.webContents.capturePage();
    const size = image.getSize();               // logical (DIP) size
    if (!size.width || !size.height) throw new Error('capture came back empty');

    // On a HiDPI display the offscreen frame is rendered at a device scale
    // factor > 1, so toBitmap() returns more pixels than getSize() reports
    // (e.g. 1544px wide for a 772 DIP window at 2x). Recover the true pixel
    // dimensions from the buffer length, or the raster stride is wrong and the
    // page comes out doubled and clipped. On a 1x display this is a no-op.
    const bitmap = image.toBitmap();
    const sf = Math.max(1, Math.round(Math.sqrt(bitmap.length / (4 * size.width * size.height))));
    const width = size.width * sf;
    const height = size.height * sf;

    return { bitmap, width, height };
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

/** Render the print-area and send it straight to the printer. */
async function printPrintArea(sourceWebContents, opts = {}) {
  const { bitmap, width, height } = await renderPrintArea(sourceWebContents);
  // Electron's toBitmap() is BGRA.
  return peripage.printRgba(bitmap, width, height, { ...opts, bgra: true });
}

module.exports = { renderPrintArea, printPrintArea, CSS_WIDTH, ZOOM };
