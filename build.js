import { build } from 'esbuild';

await build({
  entryPoints: ['src/action.ts'],
  format: 'esm',
  bundle: true,
  treeShaking: true,
  platform: 'node',
  minify: true,
  banner: {
    js: `
import { createRequire } from 'node:module';
import path from 'node:path';
import url from 'node:url';

const require = createRequire(import.meta.url);
const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
    `,
  },
  outfile: 'lib/action.mjs',
});
