import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const OUT_ROOT = path.resolve(process.cwd(), 'sample-photos');

interface Spot {
  city: string;
  folder: string;
  lat: number;
  lon: number;
  palette: [string, string, string];
  accent: string;
}

const SPOTS: Spot[] = [
  { city: 'Sao_Paulo', folder: 'Brasil/Sao_Paulo', lat: -23.5505, lon: -46.6333, palette: ['#0f172a', '#1e3a8a', '#38bdf8'], accent: '#f59e0b' },
  { city: 'Rio_de_Janeiro', folder: 'Brasil/Rio', lat: -22.9068, lon: -43.1729, palette: ['#064e3b', '#0284c7', '#f59e0b'], accent: '#fef08a' },
  { city: 'Florianopolis', folder: 'Brasil/Floripa', lat: -27.5954, lon: -48.548, palette: ['#0c4a6e', '#0d9488', '#67e8f9'], accent: '#fde047' },
  { city: 'Lisboa', folder: 'Europa/Lisboa', lat: 38.7223, lon: -9.1393, palette: ['#451a03', '#c2410c', '#fbbf24'], accent: '#fff7ed' },
  { city: 'Paris', folder: 'Europa/Paris', lat: 48.8566, lon: 2.3522, palette: ['#1e1b4b', '#4338ca', '#ec4899'], accent: '#fbcfe8' },
  { city: 'Tokyo', folder: 'Asia/Tokyo', lat: 35.6762, lon: 139.6503, palette: ['#09090b', '#7e22ce', '#f43f5e'], accent: '#38bdf8' },
  { city: 'New_York', folder: 'Americas/NYC', lat: 40.7128, lon: -74.006, palette: ['#111827', '#374151', '#60a5fa'], accent: '#fb923c' },
  { city: 'Patagonia', folder: 'Americas/Patagonia', lat: -50.9423, lon: -73.4068, palette: ['#0f172a', '#0369a1', '#e0f2fe'], accent: '#ffffff' },
];

const GEAR = [
  { make: 'SONY', model: 'ILCE-7M4', lens: 'FE 24-70mm F2.8 GM II', focal: '35/1', fnum: '28/10' },
  { make: 'Canon', model: 'EOS R5', lens: 'RF 50mm F1.2L USM', focal: '50/1', fnum: '14/10' },
  { make: 'Apple', model: 'iPhone 15 Pro', lens: 'iPhone 15 Pro back triple camera 6.765mm f/1.78', focal: '24/1', fnum: '18/10' },
  { make: 'FUJIFILM', model: 'X-T5', lens: 'XF35mmF1.4 R', focal: '35/1', fnum: '20/10' },
  { make: 'NIKON', model: 'Z8', lens: 'NIKKOR Z 85mm f/1.8 S', focal: '85/1', fnum: '18/10' },
];

const ISOS = ['100', '200', '400', '800', '1600', '3200'];
const SHUTTERS = ['1/2000', '1/1000', '1/500', '1/250', '1/125', '1/60'];

function toDmsRational(deg: number): string {
  const abs = Math.abs(deg);
  const d = Math.floor(abs);
  const mFloat = (abs - d) * 60;
  const m = Math.floor(mFloat);
  const s = Math.round((mFloat - m) * 60 * 100);
  return `${d}/1 ${m}/1 ${s}/100`;
}

function buildArtworkSvg(spot: Spot, index: number, gearModel: string, dateLabel: string): string {
  const w = 1200;
  const h = 900;
  const sunX = 240 + ((index * 137) % 720);
  const sunY = 180 + ((index * 73) % 260);
  const hillOffset = (index * 41) % 160;
  return `
  <svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <defs>
      <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${spot.palette[0]}" />
        <stop offset="55%" stop-color="${spot.palette[1]}" />
        <stop offset="100%" stop-color="${spot.palette[2]}" />
      </linearGradient>
      <radialGradient id="glow" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="${spot.accent}" stop-opacity="0.95" />
        <stop offset="100%" stop-color="${spot.accent}" stop-opacity="0" />
      </radialGradient>
    </defs>
    <rect width="${w}" height="${h}" fill="url(#sky)" />
    <circle cx="${sunX}" cy="${sunY}" r="180" fill="url(#glow)" />
    <circle cx="${sunX}" cy="${sunY}" r="48" fill="${spot.accent}" opacity="0.92" />
    <path d="M0 ${640 - hillOffset / 3} Q ${320 + hillOffset} ${440} ${700} ${600} T ${w} ${520} L ${w} ${h} L 0 ${h} Z" fill="${spot.palette[0]}" opacity="0.58" />
    <path d="M0 ${720} Q ${460 - hillOffset} ${560} ${860} ${680} T ${w} ${630} L ${w} ${h} L 0 ${h} Z" fill="#09090b" opacity="0.72" />
    <text x="56" y="810" font-family="Segoe UI, Arial, sans-serif" font-size="44" font-weight="700" fill="#ffffff" opacity="0.92">${spot.city.replace(/_/g, ' ')} #${String(index + 1).padStart(2, '0')}</text>
    <text x="56" y="852" font-family="Segoe UI, Arial, sans-serif" font-size="24" fill="#e4e4e7" opacity="0.78">${gearModel}  •  ${dateLabel}</text>
  </svg>`;
}

async function main() {
  await fs.mkdir(OUT_ROOT, { recursive: true });
  const total = 48;

  for (let i = 0; i < total; i++) {
    const spot = SPOTS[i % SPOTS.length];
    const gear = GEAR[i % GEAR.length];
    const iso = ISOS[i % ISOS.length];
    const shutter = SHUTTERS[i % SHUTTERS.length];

    // Small realistic jitter around each city so clusters expand nicely as you zoom in
    const lat = spot.lat + ((i % 7) - 3) * 0.018;
    const lon = spot.lon + ((Math.floor(i / 7) % 7) - 3) * 0.022;

    const year = 2024 + (i % 3);
    const month = String(1 + (i % 12)).padStart(2, '0');
    const day = String(1 + ((i * 3) % 27)).padStart(2, '0');
    const hour = String(8 + (i % 12)).padStart(2, '0');
    const exifDate = `${year}:${month}:${day} ${hour}:15:00`;
    const labelDate = `${day}/${month}/${year}`;

    const dir = path.join(OUT_ROOT, spot.folder);
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `${spot.city}_${String(i + 1).padStart(3, '0')}.jpg`);

    const svg = buildArtworkSvg(spot, i, `${gear.make} ${gear.model}`, labelDate);
    await sharp(Buffer.from(svg))
      .jpeg({ quality: 86 })
      .withExif({
        IFD0: {
          Make: gear.make,
          Model: gear.model,
        },
        IFD2: {
          DateTimeOriginal: exifDate,
          CreateDate: exifDate,
          LensModel: gear.lens,
          ISOSpeedRatings: iso,
          FNumber: gear.fnum,
          ExposureTime: shutter,
          FocalLength: gear.focal,
        },
        IFD3: {
          GPSLatitudeRef: lat >= 0 ? 'N' : 'S',
          GPSLatitude: toDmsRational(lat),
          GPSLongitudeRef: lon >= 0 ? 'E' : 'W',
          GPSLongitude: toDmsRational(lon),
        },
      })
      .toFile(filePath);
  }

  console.log(`Generated ${total} sample EXIF+GPS photos in ${OUT_ROOT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
