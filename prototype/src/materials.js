import * as THREE from 'three';
import { clamp } from './util.js';

// ---------------------------------------------------------------- procedural surface patterns
// Height fields are periodic so they tile; they become normal maps (the path tracer only reads standard
// MeshPhysicalMaterial maps, so patterns are baked, not shader code).
const N = 512;
const tri = x => Math.abs( ( ( x % 1 ) + 1 ) % 1 * 2 - 1 );
const rnd = ( x, y ) => { const s = Math.sin( x * 127.1 + y * 311.7 ) * 43758.5453; return s - Math.floor( s ); };
function vnoise( x, y, p ) {

	const xi = Math.floor( x ), yi = Math.floor( y ), xf = x - xi, yf = y - yi;
	const f = t => t * t * ( 3 - 2 * t ), r = ( i, j ) => rnd( ( ( i % p ) + p ) % p, ( ( j % p ) + p ) % p );
	const a = r( xi, yi ), b = r( xi + 1, yi ), c = r( xi, yi + 1 ), d = r( xi + 1, yi + 1 );
	return a + ( b - a ) * f( xf ) + ( c - a ) * f( yf ) + ( a - b - c + d ) * f( xf ) * f( yf );

}

export const PATTERNS = {
	none: { name: 'None' },
	ribs: { name: 'Ribs', fn: ( u ) => Math.sqrt( Math.max( 0, 1 - Math.pow( tri( u * 4 ) * 2 - 1, 2 ) ) ) },
	fine: { name: 'Fine grooves', fn: ( u ) => 0.5 + 0.5 * Math.sin( u * Math.PI * 2 * 24 ) },
	knurl: { name: 'Diamond knurl', fn: ( u, v ) => Math.min( tri( ( u + v ) * 6 ), tri( ( u - v ) * 6 ) ) },
	dimples: { name: 'Dimples', fn: ( u, v ) => { const x = ( u * 8 ) % 1 - 0.5, y = ( v * 8 ) % 1 - 0.5; return 1 - Math.min( 1, Math.hypot( x, y ) * 2.2 ); } },
	hex: { name: 'Hex mesh', fn: ( u, v ) => { const s = 8, x = u * s, y = v * s * 1.1547; const q = ( ( x + ( Math.floor( y ) % 2 ) * 0.5 ) % 1 ) - 0.5; const p = ( y % 1 ) - 0.5; return 1 - clamp( Math.max( Math.abs( q ) * 1.2, Math.abs( p ) ) * 2.0, 0, 1 ); } },
	grain: { name: 'Mold grain', fn: ( u, v ) => 0.6 * vnoise( u * 64, v * 64, 64 ) + 0.4 * vnoise( u * 128, v * 128, 128 ) },
	weave: { name: 'Carbon weave', fn: ( u, v ) => { const a = Math.sin( u * Math.PI * 2 * 16 ) * 0.5 + 0.5, b = Math.sin( v * Math.PI * 2 * 16 ) * 0.5 + 0.5; return ( Math.floor( u * 16 ) + Math.floor( v * 16 ) ) % 2 ? a : b; } },
	brushed: { name: 'Brushed', fn: ( u, v ) => vnoise( u * 4, v * 256, 256 ) * 0.7 + vnoise( u * 8, v * 512, 512 ) * 0.3 },
	perf: { name: 'Perforation', fn: ( u, v ) => { const x = ( u * 10 ) % 1 - 0.5, y = ( v * 10 ) % 1 - 0.5; return Math.hypot( x, y ) < 0.28 ? 0 : 1; } },
};

const patCache = new Map();
export function patternTexture( id ) {

	if ( ! PATTERNS[ id ]?.fn ) return null;
	if ( patCache.has( id ) ) return patCache.get( id );
	const fn = PATTERNS[ id ].fn, hgt = new Float32Array( N * N );
	for ( let y = 0; y < N; y ++ ) for ( let x = 0; x < N; x ++ ) hgt[ y * N + x ] = fn( x / N, y / N );
	const px = new Uint8Array( N * N * 4 ), at = ( x, y ) => hgt[ ( ( y + N ) % N ) * N + ( ( x + N ) % N ) ];
	const k = id === 'perf' ? 6 : 3;
	for ( let y = 0; y < N; y ++ ) for ( let x = 0; x < N; x ++ ) {

		const dx = ( at( x + 1, y ) - at( x - 1, y ) ) * k, dy = ( at( x, y + 1 ) - at( x, y - 1 ) ) * k;
		const l = Math.hypot( dx, dy, 1 ), i = ( y * N + x ) * 4;
		px[ i ] = ( - dx / l * 0.5 + 0.5 ) * 255; px[ i + 1 ] = ( dy / l * 0.5 + 0.5 ) * 255; px[ i + 2 ] = ( 1 / l * 0.5 + 0.5 ) * 255; px[ i + 3 ] = 255;

	}

	const t = new THREE.DataTexture( px, N, N, THREE.RGBAFormat );
	t.wrapS = t.wrapT = THREE.RepeatWrapping; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
	t.anisotropy = 4; t.colorSpace = THREE.NoColorSpace; t.needsUpdate = true;
	patCache.set( id, t );
	return t;

}

// ---------------------------------------------------------------- preset library
const M = ( name, cat, color, o = {} ) => ( { name, cat, spec: Object.assign( { color, metalness: 0, roughness: 0.5 }, o ) } );
export const PRESETS = [
	M( 'Matte ABS', 'Plastic', '#c9ccd1', { roughness: 0.55 } ),
	M( 'Gloss ABS', 'Plastic', '#e8e8ea', { roughness: 0.12, clearcoat: 0.6, clearcoatRoughness: 0.05 } ),
	M( 'Soft-touch', 'Plastic', '#8f959d', { roughness: 0.78, sheen: 0.35, sheenRoughness: 0.5 } ),
	M( 'Frosted', 'Plastic', '#f0f0f2', { roughness: 0.38, transmission: 0.45, thickness: 0.004, ior: 1.45 } ),
	M( 'Black plastic', 'Plastic', '#1b1c1f', { roughness: 0.35 } ),
	M( 'Signal orange', 'Plastic', '#ff5a1f', { roughness: 0.45 } ),
	M( 'Anodized blue', 'Metal', '#4b6a8f', { metalness: 1, roughness: 0.32 } ),
	M( 'Anodized red', 'Metal', '#d1493f', { metalness: 1, roughness: 0.34 } ),
	M( 'Brushed steel', 'Metal', '#c4c7cc', { metalness: 1, roughness: 0.38, pattern: { id: 'brushed', scale: 2, depth: 0.5 } } ),
	M( 'Polished chrome', 'Metal', '#eeeeee', { metalness: 1, roughness: 0.04 } ),
	M( 'Gold', 'Metal', '#e6b450', { metalness: 1, roughness: 0.18 } ),
	M( 'Copper', 'Metal', '#c8774f', { metalness: 1, roughness: 0.25 } ),
	M( 'Titanium', 'Metal', '#8a8d93', { metalness: 1, roughness: 0.42 } ),
	M( 'Black oxide', 'Metal', '#26282c', { metalness: 1, roughness: 0.45 } ),
	M( 'Clear glass', 'Glass', '#ffffff', { roughness: 0, transmission: 1, thickness: 0.004, ior: 1.5 } ),
	M( 'Smoked glass', 'Glass', '#6f7378', { roughness: 0.02, transmission: 1, thickness: 0.01, ior: 1.5, attenuationColor: '#5b6068', attenuationDistance: 0.06 } ),
	M( 'Tinted amber', 'Glass', '#ffb25a', { roughness: 0.02, transmission: 1, thickness: 0.01, ior: 1.5, attenuationColor: '#ff9a3c', attenuationDistance: 0.04 } ),
	M( 'Silicone', 'Soft', '#8fc7b0', { roughness: 0.62, sheen: 0.5, sheenRoughness: 0.4 } ),
	M( 'Rubber', 'Soft', '#202225', { roughness: 0.85 } ),
	M( 'TPU', 'Soft', '#e9e4dc', { roughness: 0.5, transmission: 0.2, thickness: 0.003 } ),
	M( 'Ceramic', 'Natural', '#f4f1ea', { roughness: 0.14, clearcoat: 0.4 } ),
	M( 'Concrete', 'Natural', '#9b9a96', { roughness: 0.95, pattern: { id: 'grain', scale: 2, depth: 0.5 } } ),
	M( 'Oak', 'Natural', '#b88a58', { roughness: 0.55, pattern: { id: 'fine', scale: 3, depth: 0.25 } } ),
	M( 'Linen', 'Natural', '#d8cfc0', { roughness: 0.95, sheen: 0.8, sheenRoughness: 0.6, pattern: { id: 'weave', scale: 6, depth: 0.5 } } ),
	M( 'Car paint', 'Paint', '#2b5c9e', { metalness: 0.6, roughness: 0.28, clearcoat: 1, clearcoatRoughness: 0.03 } ),
	M( 'Pearl white', 'Paint', '#f6f6f3', { metalness: 0.15, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.05 } ),
	M( 'LED glow', 'Emissive', '#ffffff', { roughness: 0.5, emissive: '#7ef0ff', emissiveIntensity: 6 } ),
	M( 'Warm LED', 'Emissive', '#ffffff', { roughness: 0.5, emissive: '#ffb066', emissiveIntensity: 5 } ),
];

export const FINISH_CATS = [ ...new Set( PRESETS.map( p => p.cat ) ) ];

export function defaultSpec( over = {} ) {

	return Object.assign( {
		preset: 'Matte ABS', color: '#c9ccd1', metalness: 0, roughness: 0.55, clearcoat: 0, clearcoatRoughness: 0.1,
		transmission: 0, ior: 1.5, thickness: 0, sheen: 0, sheenRoughness: 0.5, emissive: '#000000', emissiveIntensity: 0, opacity: 1,
		attenuationColor: '#ffffff', attenuationDistance: 0,
		pattern: { id: 'none', scale: 8, depth: 1 },
		image: null, // { data, name, mapping, scale, rot, ox, oy }
	}, over );

}

export function swatchCss( s ) {

	const c = s.color || '#888', m = s.metalness || 0;
	if ( s.transmission > 0.5 ) return `radial-gradient(circle at 32% 28%, #fff 0 8%, ${c}55 30%, ${c}22 70%, #0004)`;
	if ( m > 0.5 ) return `conic-gradient(from 30deg, ${c}, #fff8, ${c}, #0006, ${c})`;
	return `radial-gradient(circle at 32% 28%, ${s.roughness < 0.25 ? '#fffc' : '#fff4'} 0 10%, ${c} 38%, color-mix(in srgb, ${c} 55%, #000))`;

}

// ---------------------------------------------------------------- texture size cap (low-VRAM)
const imgCache = new Map();
export function loadImage( src ) {

	if ( imgCache.has( src ) ) return imgCache.get( src );
	const p = new Promise( ( res, rej ) => { const i = new Image(); i.onload = () => res( i ); i.onerror = rej; i.src = src; } );
	imgCache.set( src, p );
	return p;

}

export function capImage( img, maxTex ) {

	const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
	const s = Math.min( 1, maxTex / Math.max( w, h ) );
	const pot = v => Math.max( 1, Math.round( v * s ) );
	const c = document.createElement( 'canvas' ); c.width = pot( w ); c.height = pot( h );
	c.getContext( '2d' ).drawImage( img, 0, 0, c.width, c.height );
	return c;

}

export function capTextureInPlace( tex, maxTex ) {

	const img = tex?.image; if ( ! img ) return;
	const w = img.width || img.naturalWidth, h = img.height || img.naturalHeight;
	if ( ! w || Math.max( w, h ) <= maxTex || img.data ) return;
	tex.image = capImage( img, maxTex ); tex.needsUpdate = true;

}

// ---------------------------------------------------------------- UV projection (so raster and path tracer share one mapping)
export function ensureUVBackup( geo ) {

	if ( geo.userData.uvBackup === undefined ) geo.userData.uvBackup = geo.attributes.uv ? geo.attributes.uv.array.slice() : null;

}

export function projectUVs( mesh, im ) {

	let geo = mesh.geometry;
	ensureUVBackup( geo );
	let mapping = im.mapping || 'box';
	if ( mapping === 'uv' && ! geo.userData.uvBackup ) mapping = 'box';

	const uvArr = ( () => {

		if ( mapping === 'uv' ) return geo.userData.uvBackup.slice();
		// projections need per-face data: unwrap indices once, remembering the original for save/load
		if ( geo.index ) {

			const flat = geo.toNonIndexed();
			flat.userData = geo.userData; flat.userData.uvBackup = geo.userData.uvBackup;
			geo.dispose(); mesh.geometry = geo = flat;

		}

		const pos = geo.attributes.position; geo.computeBoundingBox();
		const bb = geo.boundingBox, sz = new THREE.Vector3(); bb.getSize( sz );
		const span = Math.max( sz.x, sz.y, sz.z ) || 1, out = new Float32Array( pos.count * 2 );
		const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
		for ( let i = 0; i < pos.count; i += 3 ) {

			a.fromBufferAttribute( pos, i ); b.fromBufferAttribute( pos, i + 1 ); c.fromBufferAttribute( pos, i + 2 );
			n.crossVectors( e1.subVectors( b, a ), e2.subVectors( c, a ) ).normalize();
			const ax = Math.abs( n.x ), ay = Math.abs( n.y ), az = Math.abs( n.z );
			const P = [ a, b, c ], uv = [];
			for ( const p of P ) {

				const x = ( p.x - bb.min.x ) / span, y = ( p.y - bb.min.y ) / span, z = ( p.z - bb.min.z ) / span;
				if ( mapping === 'planar' ) uv.push( [ x, y ] );
				else if ( mapping === 'box' ) uv.push( ax >= ay && ax >= az ? [ z, y ] : ay >= az ? [ x, z ] : [ x, y ] );
				else {

					const cx = ( bb.min.x + bb.max.x ) / 2, cz = ( bb.min.z + bb.max.z ) / 2;
					const u = Math.atan2( p.x - cx, p.z - cz ) / ( Math.PI * 2 ) + 0.5;
					const v = mapping === 'sphere' ? Math.atan2( p.y - ( bb.min.y + bb.max.y ) / 2, Math.hypot( p.x - cx, p.z - cz ) ) / Math.PI + 0.5 : ( p.y - bb.min.y ) / ( sz.y || 1 );
					uv.push( [ u, v ] );

				}

			}

			if ( mapping === 'cylinder' || mapping === 'sphere' ) {

				const m = Math.max( uv[ 0 ][ 0 ], uv[ 1 ][ 0 ], uv[ 2 ][ 0 ] );
				uv.forEach( q => { if ( m - q[ 0 ] > 0.5 ) q[ 0 ] += 1; } );

			}

			for ( let k = 0; k < 3; k ++ ) { out[ ( i + k ) * 2 ] = uv[ k ][ 0 ]; out[ ( i + k ) * 2 + 1 ] = uv[ k ][ 1 ]; }

		}

		return out;

	} )();

	const sc = Math.max( 0.05, im.scale || 1 ), r = ( im.rot || 0 ) * Math.PI / 180, cs = Math.cos( r ), sn = Math.sin( r );
	const res = new Float32Array( uvArr.length );
	for ( let i = 0; i < uvArr.length; i += 2 ) {

		let u = ( uvArr[ i ] - 0.5 ) / sc, v = ( uvArr[ i + 1 ] - 0.5 ) / sc;
		const ru = u * cs - v * sn, rv = u * sn + v * cs;
		res[ i ] = ru + 0.5 + ( im.ox || 0 ); res[ i + 1 ] = rv + 0.5 + ( im.oy || 0 );

	}

	geo.setAttribute( 'uv', new THREE.BufferAttribute( res, 2 ) );
	geo.attributes.uv.needsUpdate = true;
	return mesh.geometry;

}

// ---------------------------------------------------------------- spec -> THREE material
export async function buildMaterial( spec, maxTex, prev ) {

	const m = prev && prev.isMeshPhysicalMaterial ? prev : new THREE.MeshPhysicalMaterial();
	m.color.set( spec.color ); m.metalness = spec.metalness; m.roughness = spec.roughness;
	m.clearcoat = spec.clearcoat; m.clearcoatRoughness = spec.clearcoatRoughness;
	m.transmission = spec.transmission; m.ior = spec.ior; m.thickness = spec.thickness;
	m.sheen = spec.sheen; m.sheenRoughness = spec.sheenRoughness; m.sheenColor = new THREE.Color( '#ffffff' );
	m.emissive.set( spec.emissive ); m.emissiveIntensity = spec.emissiveIntensity;
	m.opacity = spec.opacity; m.transparent = spec.opacity < 1;
	m.attenuationColor.set( spec.attenuationColor || '#ffffff' ); m.attenuationDistance = spec.attenuationDistance > 0 ? spec.attenuationDistance : Infinity;
	m.side = spec.transmission > 0 ? THREE.FrontSide : THREE.FrontSide;
	m.envMapIntensity = 1;

	// pattern
	const pat = spec.pattern || { id: 'none' };
	const pt = patternTexture( pat.id );
	if ( pt ) {

		const t = pt;
		m.normalMap = t; m.normalScale.set( pat.depth, pat.depth );
		// repeat via a per-material clone-free approach: textures are shared, so scale through texture.repeat on a clone
		const key = pat.id + ':' + pat.scale;
		if ( ! buildMaterial.reps ) buildMaterial.reps = new Map();
		let tt = buildMaterial.reps.get( key );
		if ( ! tt ) { tt = t.clone(); tt.repeat.set( pat.scale, pat.scale ); tt.wrapS = tt.wrapT = THREE.RepeatWrapping; tt.needsUpdate = true; buildMaterial.reps.set( key, tt ); }
		m.normalMap = tt;
		if ( pat.id === 'perf' ) { m.alphaTest = 0; }

	} else m.normalMap = null;

	// image wrap
	if ( spec.image ) {

		const img = await loadImage( spec.image.data );
		const key = spec.image.data.length + ':' + maxTex;
		if ( ! m.userData.imgKey || m.userData.imgKey !== key ) {

			m.map?.dispose();
			const tex = new THREE.CanvasTexture( capImage( img, maxTex ) );
			tex.colorSpace = THREE.SRGBColorSpace; tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.anisotropy = 4; tex.generateMipmaps = true;
			m.map = tex; m.userData.imgKey = key;

		}

	} else if ( m.map && m.userData.imgKey ) { m.map.dispose(); m.map = null; m.userData.imgKey = null; }

	m.needsUpdate = true;
	return m;

}

/** Turn any imported material into a MeshPhysicalMaterial we can edit. */
export function toPhysical( src ) {

	if ( ! src ) return new THREE.MeshPhysicalMaterial( { color: '#c9ccd1', roughness: 0.55 } );
	if ( src.isMeshPhysicalMaterial ) return src;
	const m = new THREE.MeshPhysicalMaterial();
	if ( src.isMeshStandardMaterial ) m.copy( src );
	else {

		m.color.copy( src.color || new THREE.Color( '#c9ccd1' ) ); m.map = src.map || null; m.opacity = src.opacity ?? 1; m.transparent = src.transparent;
		m.roughness = src.shininess != null ? clamp( 1 - src.shininess / 120, 0.2, 1 ) : 0.6; m.metalness = 0;
		if ( src.normalMap ) m.normalMap = src.normalMap;
		if ( src.emissive ) { m.emissive.copy( src.emissive ); m.emissiveMap = src.emissiveMap || null; }

	}

	m.side = src.side; m.name = src.name;
	return m;

}
