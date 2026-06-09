#!/usr/bin/env node
// Generate extension PNG icons from inline SVG
// Usage: node extension/src/icons/generate.js
// Requires: sharp (npm install in extension/)

import sharp from 'sharp';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

function makeSvg(size) {
  const center   = size / 2;
  const radius   = size / 2 - 1.5;       // circle radius with border gap
  const sw       = Math.max(1, size / 16); // stroke width scales with size
  const armGap   = size * 0.18;           // gap around center before arm starts
  const armEnd   = radius * 0.85;         // arm extends to 85% of radius
  const dotR     = size * 0.06;           // small center dot

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <!-- Background circle -->
  <circle cx="${center}" cy="${center}" r="${radius}"
    fill="#0f1117" stroke="#4493f8" stroke-width="${sw * 1.2}"/>

  <!-- Crosshair arms (gap in center) -->
  <!-- Top arm -->
  <line x1="${center}" y1="${center - armGap}" x2="${center}" y2="${center - armEnd}"
    stroke="#e6edf3" stroke-width="${sw}" stroke-linecap="round"/>
  <!-- Bottom arm -->
  <line x1="${center}" y1="${center + armGap}" x2="${center}" y2="${center + armEnd}"
    stroke="#e6edf3" stroke-width="${sw}" stroke-linecap="round"/>
  <!-- Left arm -->
  <line x1="${center - armGap}" y1="${center}" x2="${center - armEnd}" y2="${center}"
    stroke="#e6edf3" stroke-width="${sw}" stroke-linecap="round"/>
  <!-- Right arm -->
  <line x1="${center + armGap}" y1="${center}" x2="${center + armEnd}" y2="${center}"
    stroke="#e6edf3" stroke-width="${sw}" stroke-linecap="round"/>

  <!-- Center dot -->
  <circle cx="${center}" cy="${center}" r="${dotR}"
    fill="#4493f8"/>
</svg>`;
}

const sizes = [16, 32, 48, 128];

for (const size of sizes) {
  const svg  = makeSvg(size);
  const out  = join(__dirname, `icon${size}.png`);
  await sharp(Buffer.from(svg))
    .png()
    .toFile(out);
  console.log(`Generated icon${size}.png`);
}

console.log('Done.');
