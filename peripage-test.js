#!/usr/bin/env node
/* ============================================================
   JL Customs - PeriPage self-test

   Prints a test pattern straight to the A40a with no Electron and no
   dependencies. Run this first on a new Pi: it proves the device node,
   permissions and protocol all work before the kiosk is involved.

     node peripage-test.js              print the test pattern
     node peripage-test.js --dry-run    build the job, print nothing
     node peripage-test.js --out job.bin  write the bytes to a file
     PERIPAGE_DEVICE=/dev/usb/lp1 node peripage-test.js
   ============================================================ */
'use strict';

const fs = require('fs');
const peripage = require('./peripage');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const outIdx = args.indexOf('--out');
const outFile = outIdx !== -1 ? args[outIdx + 1] : null;

const W = peripage.WIDTH_DOTS; // 1632
const H = 500;                 // ~62mm of paper - keep the test cheap

function buildPattern() {
  const rgba = Buffer.alloc(W * H * 4);
  const set = (x, y, v) => {
    const i = (y * W + x) * 4;
    rgba[i] = rgba[i + 1] = rgba[i + 2] = v;
    rgba[i + 3] = 255;
  };

  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) set(x, y, 255);

  // Border - edge alignment and full usable width.
  for (let x = 0; x < W; x++) for (let t = 0; t < 4; t++) { set(x, t, 0); set(x, H - 1 - t, 0); }
  for (let y = 0; y < H; y++) for (let t = 0; t < 4; t++) { set(t, y, 0); set(W - 1 - t, y, 0); }

  // Solid bar - full-ink coverage across the head.
  for (let y = 30; y < 90; y++) for (let x = 30; x < W - 30; x++) set(x, y, 0);

  // Gradient - dithering.
  for (let y = 120; y < 260; y++) {
    for (let x = 30; x < W - 30; x++) set(x, y, Math.round(255 * (x - 30) / (W - 60)));
  }

  // Grey step wedge - flat-tone dither quality.
  for (let s = 0; s < 8; s++) {
    const v = Math.round(255 * s / 7);
    const step = Math.floor((W - 60) / 8);
    for (let y = 290; y < 380; y++) {
      for (let x = 30 + s * step; x < 30 + s * step + step - 6; x++) set(x, y, v);
    }
  }

  // 1px comb - single-dot addressing at native resolution.
  for (let x = 30; x < W - 30; x += 4) for (let y = 410; y < 470; y++) set(x, y, 0);

  return rgba;
}

async function main() {
  console.log(`PeriPage A40a self-test - ${W} dots wide @ ${peripage.DPI}dpi`);

  const rgba = buildPattern();
  const { raster, widthBytes, lines } = peripage.rgbaToRaster(rgba, W, H);
  const job = peripage.buildJob(raster, widthBytes);
  console.log(`built job: ${lines} lines x ${widthBytes} bytes = ${job.length} bytes total`);

  if (outFile) {
    fs.writeFileSync(outFile, job);
    console.log(`wrote ${outFile}`);
  }

  if (dryRun) {
    console.log('--dry-run: not printing.');
    return;
  }

  let device;
  try {
    device = await peripage.findDevice();
  } catch (err) {
    console.error(`\nERROR: ${err.message}`);
    console.error('\nCheck:  lsusb            (expect 353d:1183)');
    console.error('        ls -l /dev/usb/   (expect lp0)');
    console.error('        lsmod | grep usblp');
    process.exit(1);
  }
  console.log(`device: ${device}`);

  try {
    const res = await peripage.writeToDevice(job, device);
    console.log(`\nOK - sent ${res.bytes} bytes to ${res.device}`);
    console.log('Expect: border, solid bar, gradient, 8-step wedge, fine comb.');
  } catch (err) {
    console.error(`\nERROR: ${err.message}`);
    process.exit(1);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
