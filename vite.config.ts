import { defineConfig } from 'vite'
import { viteStaticCopy } from 'vite-plugin-static-copy'
import webExtension from 'vite-plugin-web-extension'

// https://vitejs.dev/config/
export default defineConfig({
    esbuild: {
        charset: 'utf8',
        jsx: 'automatic',
        jsxImportSource: 'preact',
    },
    resolve: {
        alias: {
            'react/jsx-runtime': 'preact/jsx-runtime',
            'react/jsx-dev-runtime': 'preact/jsx-runtime',
            'react-dom/test-utils': 'preact/test-utils',
            'react-dom': 'preact/compat',
            'react': 'preact/compat',
        },
    },
    plugins: [
        webExtension({
            manifest: 'manifest.json',
            disableAutoLaunch: true,
        }),
        viteStaticCopy({
            targets: [
                { src: 'icons/*.png', dest: 'icons' },
            ],
        }),
    ],
    build: {
        cssMinify: false,
        outDir: 'dist',
        emptyOutDir: true,
    },
})
