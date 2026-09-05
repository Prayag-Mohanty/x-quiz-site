import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // Proxying keeps the browser talking to one origin, so CORS never enters
    // the picture during development. /ws needs ws:true or the upgrade request
    // is proxied as plain HTTP and the socket never opens.
    proxy: {
      '/api': 'http://127.0.0.1:3000',
      '/ws': { target: 'ws://127.0.0.1:3000', ws: true },
      // Uploaded images and audio, served by @fastify/static at /media/.
      // Without this the dev server answers with index.html and every <img>
      // silently renders nothing — which is invisible on a text question and
      // fatal on a visual connect, where the images are the whole round.
      '/media': 'http://127.0.0.1:3000',
    },
  },
});
