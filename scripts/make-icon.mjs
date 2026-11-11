// Renders InThink's [◆] mark (the path data in web/index.html, fill #c2fe0b, transparent background) with Playwright's
// Chromium and writes assets/inprogress.ico: an ICO whose entries are PNGs, at the sizes Windows asks for. Run it by
// hand when the mark changes and commit the .ico; the build only copies it. Usage: node scripts/make-icon.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const SIZES = [16, 24, 32, 48, 64, 256];
const PATH_DATA = 'M2 5.5h6V8H4.5v16H8v2.5H2zM30 5.5h-6V8h3.5v16H24v2.5h6zM16 9.5l6.5 6.5-6.5 6.5L9.5 16z';
const out = fileURLToPath(new URL('../assets/inprogress.ico', import.meta.url));

// Playwright's own Chromium when it is installed, else the machine's Edge (the e2e suite runs on it too).
const browser = await chromium.launch().catch(() => chromium.launch({ channel: 'msedge' }));
try {
  const page = await browser.newPage();
  const pngs = [];
  for (const size of SIZES) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<body style="margin:0;background:transparent"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="${size}" height="${size}"><path fill="#c2fe0b" d="${PATH_DATA}"/></svg></body>`,
    );
    pngs.push(await page.screenshot({ omitBackground: true, type: 'png' }));
  }
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(pngs.length, 4);
  let offset = 6 + 16 * pngs.length;
  const entries = pngs.map((png, i) => {
    const e = Buffer.alloc(16);
    const size = SIZES[i];
    e.writeUInt8(size === 256 ? 0 : size, 0); // width: 0 means 256
    e.writeUInt8(size === 256 ? 0 : size, 1);
    e.writeUInt16LE(1, 4); // colour planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += png.length;
    return e;
  });
  mkdirSync(fileURLToPath(new URL('../assets', import.meta.url)), { recursive: true });
  writeFileSync(out, Buffer.concat([header, ...entries, ...pngs]));
  console.log(`Wrote ${out} (${offset} bytes)`);
} finally {
  await browser.close();
}
