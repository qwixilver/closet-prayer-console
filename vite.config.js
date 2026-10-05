import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

export default defineConfig({ base: './', plugins: [react(), {
  name: 'published-license-notices',
  generateBundle() {
    this.emitFile({ type: 'asset', fileName: 'LICENSE.txt', source: readFileSync(new URL('./LICENSE', import.meta.url), 'utf8') });
    const notices = ['react', 'react-dom', 'scheduler', 'qr'].map(name =>
      `${name}\n${readFileSync(new URL(`./node_modules/${name}/LICENSE`, import.meta.url), 'utf8')}`).join('\n\n');
    this.emitFile({ type: 'asset', fileName: 'THIRD_PARTY_NOTICES.txt', source: notices });
  },
}] });
