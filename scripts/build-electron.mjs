// Bundles the Electron main process (which embeds the server) and the preload script.
import { build } from 'esbuild';

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outdir: 'dist-electron',
  outExtension: { '.js': '.cjs' },
  // Native / heavy deps stay in node_modules
  external: ['electron', 'sharp', 'exifr', 'electron-updater'],
  logLevel: 'info',
};

await build({ ...common, entryPoints: ['electron/main.ts', 'electron/preload.ts'] });
