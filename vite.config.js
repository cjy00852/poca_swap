import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
export default defineConfig({
  base: './',
  build: { target: 'es2022' },
  plugins: [{ name: 'poca-sample-photos', generateBundle() {
    for (let i = 1; i <= 5; i++) {
      const fileName = `images/poca_0${i}.jpg`;
      this.emitFile({ type: 'asset', fileName, source: readFileSync(new URL(fileName, import.meta.url)) });
    }
  } }]
});
