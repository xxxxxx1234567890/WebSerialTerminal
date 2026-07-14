const sharp = require('sharp');
const path = require('path');

const SIZES = [192, 512];

// Terminal icon SVG: dark background + green ">_" prompt
function createSvg(size) {
  const pad = Math.round(size * 0.15);
  const innerW = size - pad * 2;
  const innerH = size - pad * 2;
  const fontSize = Math.round(size * 0.35);
  const borderW = Math.max(2, Math.round(size / 80));

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
    <defs>
      <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" style="stop-color:#0d0d0d"/>
        <stop offset="100%" style="stop-color:#050505"/>
      </linearGradient>
      <filter id="glow">
        <feGaussianBlur stdDeviation="${Math.max(1, size * 0.01)}" result="blur"/>
        <feMerge>
          <feMergeNode in="blur"/>
          <feMergeNode in="SourceGraphic"/>
        </feMerge>
      </filter>
    </defs>

    <!-- Background -->
    <rect width="${size}" height="${size}" rx="${Math.round(size * 0.08)}" fill="url(#bg)"/>

    <!-- Terminal border -->
    <rect x="${borderW}" y="${borderW}" width="${size - borderW * 2}" height="${size - borderW * 2}"
          rx="${Math.round(size * 0.07)}" fill="none" stroke="#00ff41" stroke-width="${borderW}" opacity="0.6"/>

    <!-- Title bar dots -->
    <circle cx="${pad}" cy="${pad}" r="${Math.round(size * 0.02)}" fill="#ff5f56" opacity="0.4"/>
    <circle cx="${Math.round(pad + size * 0.035)}" cy="${pad}" r="${Math.round(size * 0.02)}" fill="#ffbd2e" opacity="0.4"/>
    <circle cx="${Math.round(pad + size * 0.07)}" cy="${pad}" r="${Math.round(size * 0.02)}" fill="#27c93f" opacity="0.4"/>

    <!-- ">_" prompt text -->
    <text x="${size / 2}" y="${size / 2 + fontSize * 0.35}"
          font-family="Consolas, 'Courier New', monospace"
          font-size="${fontSize}"
          font-weight="bold"
          fill="#00ff41"
          text-anchor="middle"
          filter="url(#glow)">>_</text>

    <!-- Subtle CRT scanline overlay -->
    <g opacity="0.03">
      ${Array.from({length: Math.round(size / 4)}, (_, i) =>
        `<line x1="0" y1="${i * 4}" x2="${size}" y2="${i * 4}" stroke="white" stroke-width="1"/>`
      ).join('')}
    </g>
  </svg>`;
}

async function generateIcon(size) {
  const svg = createSvg(size);
  const outPath = path.join(__dirname, 'icons', `icon-${size}x${size}.png`);
  await sharp(Buffer.from(svg)).resize(size, size).png().toFile(outPath);
  console.log(`Created ${outPath}`);
}

async function main() {
  for (const size of SIZES) {
    await generateIcon(size);
  }
  console.log('Done!');
}

main().catch(console.error);
