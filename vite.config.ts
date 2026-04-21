import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, loadEnv} from 'vite';

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, '.', '');
  return {
    plugins: [react(), tailwindcss()],
    define: {
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
        // ────────────────────────────────────────────────────────────────
        // Node.js専用モジュールをブラウザビルドから完全に除外するスタブ設定。
        // `false` を指定すると Vite はそのモジュールを空のスタブに解決する。
        // ────────────────────────────────────────────────────────────────
        'jimp':            false,
        'fs':              false,
        'fluent-ffmpeg':   false,
        'ffmpeg-static':   false,
      },
    },
    server: {
      hmr: process.env.DISABLE_HMR !== 'true',
      headers: {
        "Cross-Origin-Embedder-Policy": "require-corp",
        "Cross-Origin-Opener-Policy": "same-origin",
      },
    },
    optimizeDeps: {
      // @ffmpeg/* はブラウザ向けWASMバンドルのため事前最適化対象から除外
      exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'],
    },
  };
});
