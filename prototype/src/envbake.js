import * as THREE from 'three';
import { kelvinToLinear, deg, clamp } from './util.js';

export const ENV_W = 1024, ENV_H = 512;

// Equirect convention used by three.js: u = atan2(z, x) / 2π + .5, v = asin(y) / π + .5 (row 0 = v 0)
const colCos = new Float32Array( ENV_W ), colSin = new Float32Array( ENV_W );
for ( let i = 0; i < ENV_W; i ++ ) { const phi = ( ( i + 0.5 ) / ENV_W - 0.5 ) * Math.PI * 2; colCos[ i ] = Math.cos( phi ); colSin[ i ] = Math.sin( phi ); }
const rowCos = new Float32Array( ENV_H ), rowSin = new Float32Array( ENV_H );
for ( let j = 0; j < ENV_H; j ++ ) { const el = ( ( j + 0.5 ) / ENV_H - 0.5 ) * Math.PI; rowCos[ j ] = Math.cos( el ); rowSin[ j ] = Math.sin( el ); }

export function lightDir( az, el ) {

	const a = az * deg, e = el * deg;
	return [ Math.sin( a ) * Math.cos( e ), Math.sin( e ), Math.cos( a ) * Math.cos( e ) ];

}

/** Resample an imported HDRI to the working size (bilinear-free nearest is fine at this res). */
export function prepareHdri( src ) {

	const out = new Float32Array( ENV_W * ENV_H * 4 );
	for ( let j = 0; j < ENV_H; j ++ ) {

		const sj = Math.min( src.h - 1, Math.floor( ( src.flipY ? ENV_H - 1 - j : j ) / ENV_H * src.h ) );
		for ( let i = 0; i < ENV_W; i ++ ) {

			const si = Math.min( src.w - 1, Math.floor( i / ENV_W * src.w ) ), s = ( sj * src.w + si ) * 4, o = ( j * ENV_W + i ) * 4;
			out[ o ] = src.data[ s ]; out[ o + 1 ] = src.data[ s + 1 ]; out[ o + 2 ] = src.data[ s + 2 ]; out[ o + 3 ] = 1;

		}

	}

	return out;

}

/**
 * Bake ambient dome + emitters (softbox / strip / disc) into one equirect HDR.
 * Lights live in the environment on purpose: they are sampled by the path tracer's importance
 * sampling, appear in reflections and give physically soft shadows, and the raster viewport
 * gets the same light through the prefiltered environment.
 */
export function bakeEnvironment( env, lights, hdri, center = [ 0, 0.1, 0 ] ) {

	const data = new Float32Array( ENV_W * ENV_H * 4 );
	const amb = kelvinToLinear( env.ambientK ), shift = Math.round( ( env.rotation / 360 ) * ENV_W );
	const useH = env.base === 'hdri' && hdri;

	const em = lights.filter( l => l.on ).map( l => {

		const f = lightDir( l.az, l.el ), up0 = Math.abs( f[ 1 ] ) > 0.98 ? [ 0, 0, 1 ] : [ 0, 1, 0 ];
		const r = norm( cross( up0, f ) ), u = cross( f, r );
		const roll = l.roll * deg, c = Math.cos( roll ), s = Math.sin( roll );
		const rr = r.map( ( v, k ) => v * c + u[ k ] * s ), uu = u.map( ( v, k ) => v * c - r[ k ] * s );
		const col = kelvinToLinear( l.K ).map( ( v, k ) => v * ( k === 1 ? 1 - l.tint * 0.18 : k === 0 || k === 2 ? 1 + l.tint * 0.09 : 1 ) );
		const hw = ( l.type === 'disc' ? l.w : l.w ) / 2, hh = ( l.type === 'disc' ? l.w : l.h ) / 2;
		return { f, r: rr, u: uu, col, hw, hh, dist: l.dist, soft: Math.max( 0.002, l.soft * Math.min( hw, hh ) ), disc: l.type === 'disc', I: l.intensity };

	} );

	for ( let j = 0; j < ENV_H; j ++ ) {

		const cy = rowCos[ j ], sy = rowSin[ j ];
		const skyW = 0.55 + 0.45 * smooth( - 0.2, 0.8, sy );
		for ( let i = 0; i < ENV_W; i ++ ) {

			const dx = cy * colCos[ i ], dz = cy * colSin[ i ], o = ( j * ENV_W + i ) * 4;
			let R = 0, G = 0, B = 0;
			if ( useH ) {

				const si = ( ( i + shift ) % ENV_W + ENV_W ) % ENV_W, s = ( j * ENV_W + si ) * 4, k = env.hdriIntensity;
				R = hdri[ s ] * k; G = hdri[ s + 1 ] * k; B = hdri[ s + 2 ] * k;

			}

			if ( ! useH || env.ambient > 0 ) { const a = env.ambient * skyW * ( useH ? 0.5 : 1 ); R += amb[ 0 ] * a; G += amb[ 1 ] * a; B += amb[ 2 ] * a; }
			for ( let k = 0; k < em.length; k ++ ) {

				const L = em[ k ], lz = dx * L.f[ 0 ] + sy * L.f[ 1 ] + dz * L.f[ 2 ];
				if ( lz <= 0.02 ) continue;
				const px = ( dx * L.r[ 0 ] + sy * L.r[ 1 ] + dz * L.r[ 2 ] ) / lz * L.dist, py = ( dx * L.u[ 0 ] + sy * L.u[ 1 ] + dz * L.u[ 2 ] ) / lz * L.dist;
				const sd = L.disc ? Math.hypot( px, py ) - L.hw : Math.max( Math.abs( px ) - L.hw, Math.abs( py ) - L.hh );
				const m = smooth( 0, 1, 0.5 - sd / ( 2 * L.soft ) );
				if ( m <= 0 ) continue;
				const rn = L.disc ? Math.hypot( px, py ) / L.hw : Math.max( Math.abs( px ) / L.hw, Math.abs( py ) / L.hh );
				const v = m * L.I * ( 1 - 0.28 * Math.min( 1, rn * rn ) );
				R += L.col[ 0 ] * v; G += L.col[ 1 ] * v; B += L.col[ 2 ] * v;

			}

			data[ o ] = R; data[ o + 1 ] = G; data[ o + 2 ] = B; data[ o + 3 ] = 1;

		}

	}

	const half = new Uint16Array( data.length );
	for ( let i = 0; i < data.length; i ++ ) half[ i ] = THREE.DataUtils.toHalfFloat( Math.min( data[ i ], 60000 ) );
	const t = new THREE.DataTexture( half, ENV_W, ENV_H, THREE.RGBAFormat, THREE.HalfFloatType );
	t.mapping = THREE.EquirectangularReflectionMapping; t.colorSpace = THREE.LinearSRGBColorSpace;
	t.minFilter = t.magFilter = THREE.LinearFilter; t.generateMipmaps = false; t.wrapS = THREE.RepeatWrapping; t.needsUpdate = true;
	return t;

}

function smooth( a, b, x ) { const t = clamp( ( x - a ) / ( b - a ), 0, 1 ); return t * t * ( 3 - 2 * t ); }
function cross( a, b ) { return [ a[ 1 ] * b[ 2 ] - a[ 2 ] * b[ 1 ], a[ 2 ] * b[ 0 ] - a[ 0 ] * b[ 2 ], a[ 0 ] * b[ 1 ] - a[ 1 ] * b[ 0 ] ]; }
function norm( a ) { const l = Math.hypot( ...a ) || 1; return a.map( v => v / l ); }
