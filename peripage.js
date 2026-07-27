/* ============================================================
   JL Customs - PeriPage raster driver (A40a / IP-A40 family)

   Speaks the vendor's wire protocol directly, so no CUPS queue or
   vendor driver is needed. The byte stream is identical on Linux and
   Windows; only the device path differs.

   Protocol (decoded from the vendor driver's own output):

     10 FF FE 01              wake
     10 FF 10 03 01           mode
     1B 40  00                init
     10 FF 10 00 02           mode
     1B 61 01                 centre
     1D 76 30 00 xL xH yL yH  raster header, little-endian
     <raster>                 xBytes * yLines, 1bpp MSB-first, 1 = black
     10 50                    end page
     10 FF FE 45              sleep

   The printer has no ESC/POS text parser - it ignores everything that
   is not a raster block, and never answers DLE EOT. Bitmap or nothing.
   ============================================================ */
'use strict';

const fs = require('fs');
const fsp = require('fs/promises');

// From the vendor config: <Driver name="IP-A40" cmd="peripage" dpi="203"
// minwidth="40" maxwidth="220" ... />. The driver emits 204 bytes/line.
const WIDTH_BYTES = 204;
const WIDTH_DOTS = WIDTH_BYTES * 8; // 1632
const DPI = 203;

// GS v 0 carries height in two bytes, so a single block tops out here.
const MAX_LINES = 0xffff;

const HEADER_PREFIX = Buffer.from([
  0x10, 0xff, 0xfe, 0x01,
  0x10, 0xff, 0x10, 0x03, 0x01,
  0x1b, 0x40,
  0x00,
  0x10, 0xff, 0x10, 0x00, 0x02,
  0x1b, 0x61, 0x01
]);

const TRAILER = Buffer.from([0x10, 0x50, 0x10, 0xff, 0xfe, 0x45]);

/**
 * Wrap packed 1bpp raster in the PeriPage framing.
 * @param {Buffer} raster  widthBytes * lines, MSB-first, 1 = black
 */
function buildJob(raster, widthBytes = WIDTH_BYTES) {
  if (widthBytes <= 0 || widthBytes > 0xffff) {
    throw new Error(`bad width: ${widthBytes} bytes`);
  }
  if (raster.length % widthBytes !== 0) {
    throw new Error(`raster ${raster.length} not divisible by width ${widthBytes}`);
  }

  const lines = raster.length / widthBytes;
  if (lines === 0) throw new Error('raster is empty');
  if (lines > MAX_LINES) throw new Error(`raster ${lines} lines exceeds ${MAX_LINES}`);

  const gs = Buffer.from([
    0x1d, 0x76, 0x30, 0x00,
    widthBytes & 0xff, (widthBytes >> 8) & 0xff,
    lines & 0xff, (lines >> 8) & 0xff
  ]);

  return Buffer.concat([HEADER_PREFIX, gs, raster, TRAILER]);
}

/**
 * RGBA pixels -> packed 1bpp raster, with Floyd-Steinberg dithering.
 * The vendor config sets graymethod="3" (dither) for this family, so
 * photos and anti-aliased text both survive the 1-bit trip.
 *
 * @param {Buffer} rgba    w*h*4 bytes
 * @param {number} w       source width in pixels
 * @param {number} h       source height in pixels
 * @param {object} [opts]
 * @param {number} [opts.widthBytes]  output width, defaults to the panel width
 * @param {number} [opts.threshold]   0-255, used when dither is false
 * @param {boolean} [opts.dither]     defaults true
 * @param {boolean} [opts.bgra]       source is BGRA, as Electron's
 *                                    nativeImage.toBitmap() returns
 */
function rgbaToRaster(rgba, w, h, opts = {}) {
  const widthBytes = opts.widthBytes || WIDTH_BYTES;
  const outDots = widthBytes * 8;
  const dither = opts.dither !== false;
  const threshold = opts.threshold != null ? opts.threshold : 128;
  // Electron hands back BGRA; a plain PNG decoder hands back RGBA.
  const rOff = opts.bgra ? 2 : 0;
  const bOff = opts.bgra ? 0 : 2;

  if (rgba.length < w * h * 4) {
    throw new Error(`rgba buffer too small: ${rgba.length} < ${w * h * 4}`);
  }

  // Scale to the panel width, preserving aspect. Nearest-neighbour is fine
  // here because the source is rendered at (or near) the target width.
  const scale = outDots / w;
  const outH = Math.max(1, Math.round(h * scale));
  if (outH > MAX_LINES) {
    throw new Error(`page would be ${outH} lines, over the ${MAX_LINES} limit`);
  }

  // Greyscale at output resolution. Float so dithering can push error around.
  const grey = new Float32Array(outDots * outH);
  for (let y = 0; y < outH; y++) {
    const sy = Math.min(h - 1, Math.floor(y / scale));
    for (let x = 0; x < outDots; x++) {
      const sx = Math.min(w - 1, Math.floor(x / scale));
      const i = (sy * w + sx) * 4;
      const a = rgba[i + 3] / 255;
      // Composite onto white: unpainted areas must not print black.
      const r = rgba[i + rOff] * a + 255 * (1 - a);
      const g = rgba[i + 1] * a + 255 * (1 - a);
      const b = rgba[i + bOff] * a + 255 * (1 - a);
      grey[y * outDots + x] = 0.299 * r + 0.587 * g + 0.114 * b;
    }
  }

  const raster = Buffer.alloc(widthBytes * outH); // zeroed = white

  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outDots; x++) {
      const idx = y * outDots + x;
      const old = grey[idx];
      const black = dither ? old < 128 : old < threshold;
      if (black) {
        // MSB-first: leftmost dot is bit 7.
        raster[y * widthBytes + (x >> 3)] |= 0x80 >> (x & 7);
      }
      if (!dither) continue;

      const err = old - (black ? 0 : 255);
      // Floyd-Steinberg: 7/16 right, 3/16 down-left, 5/16 down, 1/16 down-right.
      if (x + 1 < outDots) grey[idx + 1] += err * 7 / 16;
      if (y + 1 < outH) {
        if (x > 0) grey[idx + outDots - 1] += err * 3 / 16;
        grey[idx + outDots] += err * 5 / 16;
        if (x + 1 < outDots) grey[idx + outDots + 1] += err * 1 / 16;
      }
    }
  }

  return { raster, widthBytes, lines: outH };
}

/**
 * Locate the printer's character device. Linux binds this family to
 * usblp, giving /dev/usb/lp0. Override with PERIPAGE_DEVICE.
 */
async function findDevice() {
  if (process.env.PERIPAGE_DEVICE) return process.env.PERIPAGE_DEVICE;

  const candidates = [];
  try {
    const entries = await fsp.readdir('/dev/usb');
    for (const e of entries) {
      if (/^lp\d+$/.test(e)) candidates.push(`/dev/usb/${e}`);
    }
  } catch (_) { /* /dev/usb absent - fall through */ }

  // Some kernels expose it at the top level instead.
  for (const p of ['/dev/lp0', '/dev/lp1']) {
    try { await fsp.access(p); candidates.push(p); } catch (_) { /* not there */ }
  }

  candidates.sort();
  if (!candidates.length) {
    throw new Error(
      'no PeriPage device found (looked for /dev/usb/lp*, /dev/lp*). ' +
      'Is it plugged in and powered on? Set PERIPAGE_DEVICE to override.'
    );
  }
  return candidates[0];
}

/**
 * Write a job to the device. usblp accepts a plain sequential write; the
 * printer pulls bytes as the head consumes them, so a big page blocks
 * until it has physically printed. Hence the generous default timeout.
 */
function writeToDevice(job, device, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    let stream;
    let done = false;

    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (stream) stream.destroy();
      err ? reject(err) : resolve({ bytes: job.length, device });
    };

    const timer = setTimeout(() => {
      finish(new Error(
        `printer did not accept data within ${timeoutMs}ms - it may be out of ` +
        'paper, its cover open, or asleep'
      ));
    }, timeoutMs);

    try {
      stream = fs.createWriteStream(device, { flags: 'w' });
    } catch (err) {
      return finish(err);
    }

    stream.on('error', (err) => {
      if (err.code === 'EACCES') {
        return finish(new Error(
          `permission denied on ${device}. Add the user to the 'lp' group ` +
          "(sudo usermod -aG lp $USER) and re-login, or install a udev rule."
        ));
      }
      if (err.code === 'ENOENT') {
        return finish(new Error(`${device} disappeared - printer unplugged?`));
      }
      finish(err);
    });

    stream.on('finish', () => finish(null));
    stream.end(job);
  });
}

/** Render RGBA pixels straight to the printer. */
async function printRgba(rgba, w, h, opts = {}) {
  const { raster, widthBytes } = rgbaToRaster(rgba, w, h, opts);
  const job = buildJob(raster, widthBytes);
  const device = opts.device || await findDevice();
  return writeToDevice(job, device, opts.timeoutMs);
}

module.exports = {
  WIDTH_BYTES,
  WIDTH_DOTS,
  DPI,
  MAX_LINES,
  buildJob,
  rgbaToRaster,
  findDevice,
  writeToDevice,
  printRgba
};
