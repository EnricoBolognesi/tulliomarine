import { defineConfig } from 'vite';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Dev-only endpoint: POST an image blob to /__poster to save public/poster.webp,
// so the static hero poster is a real frame of our own 3D scene.
function posterEndpoint() {
  return {
    name: 'poster-endpoint',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__poster', (req, res) => {
        if (req.method !== 'POST') return res.writeHead(405).end();
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', async () => {
          const out = fileURLToPath(new URL('./public/poster.webp', import.meta.url));
          await writeFile(out, Buffer.concat(chunks));
          res.writeHead(200).end('ok');
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [posterEndpoint()],
  build: {
    target: 'es2022',
    // The lazy 3D chunk (three.js + scene, ~160 KB gzip) is expected to be large.
    chunkSizeWarningLimit: 700,
  },
});
