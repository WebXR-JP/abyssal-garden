import basicSsl from '@vitejs/plugin-basic-ssl'
import react from '@vitejs/plugin-react'
import path from 'path'
import { defineConfig } from 'vite'
import dts from 'vite-plugin-dts'
import federation from '@originjs/vite-plugin-federation'
import { xriftDev } from '@xrift/sdk/vite'

// `--host` を付けたとき（実機・他端末から LAN 経由で開くとき）だけ HTTPS にする。
// WebGPU / WebXR は secure context でしか動かないため、Quest や iPad からは https が必須。
// 証明書は自己署名なので、実機のブラウザで警告を一度許可する必要がある。
const useHttps =
  process.env.HTTPS === '1' ||
  process.argv.some((arg) => arg === '--host' || arg.startsWith('--host='))

export default defineConfig({
  // XRift はワールドを `.../worlds/<id>/<hash>/` のようなサブパスで配信する。
  // `base: '/'` だと `?worker` が `new Worker('/abyssal.worker-xxx.js')` を出力し、
  // サブパス配信では worker の取得に失敗して背景が出ない（MIME type text/html）。
  base: './',
  plugins: [
    useHttps && basicSsl(),
    react(),
    // <Item itemId> をローカルでも本番と同じバンドルで動かすための中継（要 xrift login）
    xriftDev(),
    dts({
      insertTypesEntry: true,
    }),
    federation({
      name: 'xrift_abyssal_garden',
      filename: 'remoteEntry.js',
      exposes: {
        './World': './src/index.tsx',
      },
      shared: {
        react: {
          singleton: true,
          requiredVersion: '*',
        },
        'react-dom': {
          singleton: true,
          requiredVersion: '*',
        },
        'react-dom/client': {
          singleton: true,
        },
        'react/jsx-runtime': {
          singleton: true,
        },
        three: {
          singleton: true,
          requiredVersion: '*',
        },
        'three/addons/loaders/GLTFLoader.js': {
          singleton: true,
        },
        'three/addons/loaders/DRACOLoader.js': {
          singleton: true,
        },
        'three/addons/loaders/KTX2Loader.js': {
          singleton: true,
        },
        '@react-three/fiber': {
          singleton: true,
          requiredVersion: '*',
        },
        '@react-three/rapier': {
          singleton: true,
          requiredVersion: '*',
        },
        '@react-three/drei': {
          singleton: true,
          requiredVersion: '*',
        },
        '@react-three/uikit': {
          singleton: true,
          requiredVersion: '*',
        },
        '@pmndrs/uikit': {
          singleton: true,
          requiredVersion: '*',
        },
        '@xrift/world-components': {
          singleton: true,
          requiredVersion: '*',
        },
      },
    }),
  ],
  worker: {
    // Abyssal Garden のエンジンは Worker 側で動的 import する（品質レベルを渡してから読む）
    format: 'es',
    // `?worker&inline` で 1 ファイルにまとめる（blob の worker は相対 import を解決できない）
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
  build: {
    target: 'esnext',
    minify: false,
    cssCodeSplit: false,
    assetsDir: '',
  },
  resolve: {
    alias: {
      '~': path.resolve(__dirname, './src'),
    },
  },
  define: {
    global: 'globalThis',
  },
})
