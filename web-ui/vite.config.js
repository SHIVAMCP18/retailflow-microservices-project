import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// During `npm run dev`, API calls are proxied to the Kong gateway.
export default defineConfig({
  plugins: [react()],
  css: { postcss: {} },   // don't pick up PostCSS config from parent folders
  server: {
    proxy: Object.fromEntries(
      ['/auth', '/customers', '/products', '/categories', '/orders', '/billing', '/notifications']
        .map(path => [path, { target: 'https://localhost:8443', secure: false }])
    )
  }
});
