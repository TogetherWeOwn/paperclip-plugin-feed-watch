import { build } from 'esbuild';
await build({ entryPoints: ['src/worker.ts', 'src/manifest.ts'], outdir: 'dist', bundle: true,
  platform: 'node', format: 'esm', target: 'node24', external: ['@paperclipai/plugin-sdk'] });
await build({ entryPoints: ['cloudflare/worker.ts'], outfile: 'dist/cloudflare.js', bundle: true,
  platform: 'browser', format: 'esm', target: 'es2023' });
