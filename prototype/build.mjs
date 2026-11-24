// Bundles src/main.js into one IIFE and inlines it (plus CSS) into dist/index.html.
// STEP support needs occt-import-js.wasm, which is copied next to the page.
import { build } from 'esbuild';
import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';

mkdirSync( 'dist', { recursive: true } );

const result = await build( {
	entryPoints: [ 'src/main.js' ],
	bundle: true,
	minify: process.env.NO_MIN ? false : true,
	format: 'iife',
	target: 'es2021',
	platform: 'browser',
	external: [ 'fs', 'path', 'crypto', 'ws', 'perf_hooks', 'worker_threads', 'child_process', 'os', 'url' ],
	write: false,
	legalComments: 'none',
	logLevel: 'warning',
	define: { 'process.env.NODE_ENV': '"production"' },
} );

let js = result.outputFiles[ 0 ].text.replace( /<\/script/gi, '<\\/script' );
const css = readFileSync( 'src/style.css', 'utf8' );
let html = readFileSync( 'src/index.template.html', 'utf8' );
html = html.replace( '/*__CSS__*/', () => css ).replace( '/*__JS__*/', () => js );
writeFileSync( 'dist/index.html', html );
copyFileSync( 'node_modules/occt-import-js/dist/occt-import-js.wasm', 'dist/occt-import-js.wasm' );
console.log( 'built dist/index.html', ( html.length / 1024 / 1024 ).toFixed( 2 ) + ' MB' );
