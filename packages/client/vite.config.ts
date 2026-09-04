import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // Proxying keeps the browser talking to one origin, so CORS never enters
    // the picture during development.
    proxy: { '/api': 'http://127.0.0.1:3000' },
  },
});
