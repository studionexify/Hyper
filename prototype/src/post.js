import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { DenoiseMaterial } from 'three-gpu-pathtracer';
import { clamp } from './util.js';

export const TONES = [ 'Khronos Neutral', 'AgX', 'ACES Filmic', 'Soft Filmic', 'Linear' ];
export const THREE_TONE = [ THREE.NeutralToneMapping, THREE.AgXToneMapping, THREE.ACESFilmicToneMapping, THREE.NeutralToneMapping, THREE.LinearToneMapping ];

// Parametric looks stand in for LUTs until .cube files are imported (display-space grade).
export const LOOKS = {
	neutral: { name: 'Neutral', tone: 0, contrast: 0, sat: 0, fade: 0, sh: [ 0, 0, 0 ], hi: [ 0, 0, 0 ], css: 'linear-gradient(135deg,#777,#ddd)' },
	clean: { name: 'Clean studio', tone: 0, contrast: 0.1, sat: 0.06, fade: 0, sh: [ 0, 0, 0.01 ], hi: [ 0.01, 0.01, 0 ], css: 'linear-gradient(135deg,#9aa4ad,#f2f5f7)' },
	warm: { name: 'Warm editorial', tone: 1, contrast: 0.12, sat: 0.02, fade: 0.015, sh: [ 0, 0.012, 0.03 ], hi: [ 0.07, 0.035, - 0.03 ], css: 'linear-gradient(135deg,#7b5a46,#f2cfa8)' },
	cool: { name: 'Cool tech', tone: 0, contrast: 0.14, sat: - 0.05, fade: 0, sh: [ 0, 0.02, 0.06 ], hi: [ - 0.02, 0.01, 0.05 ], css: 'linear-gradient(135deg,#34506b,#cfe3f5)' },
	film: { name: 'Faded film', tone: 1, contrast: - 0.04, sat: - 0.14, fade: 0.07, sh: [ 0.01, 0.025, 0.035 ], hi: [ 0.05, 0.03, 0 ], css: 'linear-gradient(135deg,#6f6a62,#e4d9c6)' },
	punch: { name: 'High contrast', tone: 2, contrast: 0.32, sat: 0.14, fade: 0, sh: [ 0, 0, 0 ], hi: [ 0, 0, 0 ], css: 'linear-gradient(135deg,#111,#fff)' },
	mono: { name: 'Mono matte', tone: 1, contrast: 0.12, sat: - 1, fade: 0.05, sh: [ 0, 0, 0 ], hi: [ 0, 0, 0 ], css: 'linear-gradient(135deg,#222,#d8d8d8)' },
	pastel: { name: 'Pastel', tone: 3, contrast: - 0.06, sat: - 0.08, fade: 0.04, sh: [ 0.02, 0.01, 0.03 ], hi: [ 0.03, 0.02, 0.04 ], css: 'linear-gradient(135deg,#d8c3d9,#f5efe0)' },
};

const VS = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4( position.xy, 0.0, 1.0 ); }`;

const FS = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform sampler2D tMap;
uniform sampler3D tLut;
uniform bool uHasLut;
uniform float uLutStrength;
uniform vec2 uTexel, uFull, uOrigin;
uniform float uExposure, uContrast, uHighlights, uShadows, uWhites, uBlacks, uVibrance, uSat, uSharp, uVig, uVigRound, uGrain, uGrainScale;
uniform float uLookContrast, uLookSat, uLookFade, uAlpha, uSample;
uniform vec3 uWB, uShTint, uHiTint;
uniform int uTone;
#include <tonemapping_pars_fragment>

vec3 softFilmic( vec3 c ) { c = max( c, vec3( 0.0 ) ); return c * ( 1.0 + c / 36.0 ) / ( 1.0 + c ); }
vec3 toSRGB( vec3 c ) { c = clamp( c, 0.0, 1.0 ); return mix( c * 12.92, 1.055 * pow( c, vec3( 1.0 / 2.4 ) ) - 0.055, step( 0.0031308, c ) ); }
float hash12( vec2 p ) { vec3 p3 = fract( vec3( p.xyx ) * .1031 ); p3 += dot( p3, p3.yzx + 33.33 ); return fract( ( p3.x + p3.y ) * p3.z ); }
float luma( vec3 c ) { return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ); }

void main() {
	vec4 t = texture2D( tMap, vUv );
	vec3 col = max( t.rgb, vec3( 0.0 ) );
	if ( uSharp > 0.0 ) {
		vec3 b = ( texture2D( tMap, vUv + vec2( uTexel.x, 0.0 ) ).rgb + texture2D( tMap, vUv - vec2( uTexel.x, 0.0 ) ).rgb +
			texture2D( tMap, vUv + vec2( 0.0, uTexel.y ) ).rgb + texture2D( tMap, vUv - vec2( 0.0, uTexel.y ) ).rgb ) * 0.25;
		col = max( col + uSharp * 1.6 * ( col - b ), vec3( 0.0 ) );
	}
	col *= exp2( uExposure ) * uWB;

	// tonal range sliders work in stops around mid grey
	float lg = log2( max( luma( col ), 1e-4 ) / 0.18 );
	float adj = uShadows * 1.6 * ( 1.0 - smoothstep( - 4.0, 0.6, lg ) )
		+ uHighlights * 1.6 * smoothstep( - 0.6, 3.0, lg )
		+ uBlacks * 1.1 * ( 1.0 - smoothstep( - 7.0, - 2.5, lg ) )
		+ uWhites * 1.1 * smoothstep( 0.8, 4.0, lg );
	col *= exp2( adj );

	if ( uTone == 0 ) col = NeutralToneMapping( col );
	else if ( uTone == 1 ) col = AgXToneMapping( col );
	else if ( uTone == 2 ) col = ACESFilmicToneMapping( col );
	else if ( uTone == 3 ) col = softFilmic( col );
	col = toSRGB( col );

	float c = clamp( uContrast + uLookContrast, - 1.0, 1.0 );
	col += c * ( col * col * ( 3.0 - 2.0 * col ) - col );
	float l = luma( col );
	float mx = max( col.r, max( col.g, col.b ) ), mn = min( col.r, min( col.g, col.b ) );
	col = mix( vec3( l ), col, max( 0.0, 1.0 + uSat + uLookSat + uVibrance * ( 1.0 - ( mx - mn ) ) ) );
	col = col * ( 1.0 - uLookFade ) + uLookFade;
	col += uShTint * ( 1.0 - l ) * ( 1.0 - l ) + uHiTint * l * l;
	if ( uHasLut ) {
		vec3 q = clamp( col, 0.0, 1.0 ); float n = float( textureSize( tLut, 0 ).x );
		col = mix( col, texture( tLut, q * ( n - 1.0 ) / n + 0.5 / n ).rgb, uLutStrength );
	}

	vec2 gp = gl_FragCoord.xy + uOrigin;
	if ( uVig > 0.0 ) {
		vec2 q = ( gp / uFull - 0.5 ) * vec2( mix( 1.0, uFull.x / uFull.y, uVigRound ), 1.0 ) * 2.0;
		col *= 1.0 - uVig * smoothstep( 0.35, 1.5, length( q ) );
	}
	if ( uGrain > 0.0 ) {
		float g = hash12( floor( gp / uGrainScale ) + uSample * 1.7 ) + hash12( floor( gp / uGrainScale ) * 1.31 + 7.0 ) - 1.0;
		col += g * uGrain * 0.16 * ( 1.0 - abs( l * 2.0 - 1.0 ) * 0.6 );
	}
	col += ( hash12( gp ) - hash12( gp + 17.0 ) ) / 255.0; // dither
	float a = uAlpha > 0.5 ? clamp( t.a, 0.0, 1.0 ) : 1.0;
	gl_FragColor = vec4( clamp( col, 0.0, 1.0 ) * a, a );
}`;

const COPY_FS = `varying vec2 vUv; uniform sampler2D tMap; void main(){ gl_FragColor = texture2D( tMap, vUv ); }`;

export class PostFX {

	constructor( renderer ) {

		this.r = renderer;
		this.quad = new FullScreenQuad( null );
		this.mat = new THREE.ShaderMaterial( {
			vertexShader: VS, fragmentShader: FS, depthTest: false, depthWrite: false, toneMapped: false,
			uniforms: {
				tMap: { value: null }, tLut: { value: null }, uHasLut: { value: false }, uLutStrength: { value: 1 },
				uTexel: { value: new THREE.Vector2() }, uFull: { value: new THREE.Vector2( 1, 1 ) }, uOrigin: { value: new THREE.Vector2() },
				uExposure: { value: 0 }, uContrast: { value: 0 }, uHighlights: { value: 0 }, uShadows: { value: 0 }, uWhites: { value: 0 }, uBlacks: { value: 0 },
				uVibrance: { value: 0 }, uSat: { value: 0 }, uSharp: { value: 0 }, uVig: { value: 0 }, uVigRound: { value: 0.5 }, uGrain: { value: 0 }, uGrainScale: { value: 1 },
				uLookContrast: { value: 0 }, uLookSat: { value: 0 }, uLookFade: { value: 0 }, uAlpha: { value: 0 }, uSample: { value: 0 },
				uWB: { value: new THREE.Vector3( 1, 1, 1 ) }, uShTint: { value: new THREE.Vector3() }, uHiTint: { value: new THREE.Vector3() },
				uTone: { value: 0 }, toneMappingExposure: { value: 1 },
			},
		} );
		this.copy = new THREE.ShaderMaterial( { vertexShader: VS, fragmentShader: COPY_FS, uniforms: { tMap: { value: null } }, depthTest: false, depthWrite: false, toneMapped: false } );
		this.dn = new DenoiseMaterial( { map: null } );
		this.dnRT = null; this.lut = null; this.lutName = '';
		this.small = new THREE.WebGLRenderTarget( 160, 90, { type: THREE.FloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false } );
		this.hist = new THREE.WebGLRenderTarget( 256, 144, { type: THREE.UnsignedByteType, depthBuffer: false } );

	}

	setParams( p, extra = {} ) {

		const u = this.mat.uniforms, look = LOOKS[ p.look ] || LOOKS.neutral;
		u.uExposure.value = p.exposure; u.uContrast.value = p.contrast; u.uHighlights.value = p.highlights; u.uShadows.value = p.shadows;
		u.uWhites.value = p.whites; u.uBlacks.value = p.blacks; u.uVibrance.value = p.vibrance; u.uSat.value = p.saturation; u.uSharp.value = p.sharpen;
		u.uVig.value = p.vignette; u.uVigRound.value = p.vignetteRound; u.uGrain.value = p.grain;
		u.uLookContrast.value = this.lut ? 0 : look.contrast; u.uLookSat.value = this.lut ? 0 : look.sat; u.uLookFade.value = this.lut ? 0 : look.fade;
		u.uShTint.value.set( ...( this.lut ? [ 0, 0, 0 ] : look.sh ) ); u.uHiTint.value.set( ...( this.lut ? [ 0, 0, 0 ] : look.hi ) );
		u.uTone.value = p.tone;
		// white balance: temp warms/cools, tint shifts green/magenta
		const t = p.temp / 100, g = p.tint / 100;
		u.uWB.value.set( 1 + 0.35 * t + 0.1 * g, 1 - 0.2 * g, 1 - 0.35 * t + 0.1 * g );
		u.uHasLut.value = !! this.lut; u.tLut.value = this.lut; u.uLutStrength.value = p.lutStrength;
		u.uAlpha.value = extra.alpha ? 1 : 0; u.uSample.value = extra.sample || 0;

	}

	/** Draw `map` through the grade. geom: { w, h (drawing buffer), full:[W,H], origin:[x,y] (GL y-up), grainScale } */
	draw( map, geom, target = null ) {

		const u = this.mat.uniforms;
		u.tMap.value = map;
		u.uTexel.value.set( 1 / geom.w, 1 / geom.h );
		u.uFull.value.set( ...( geom.full || [ geom.w, geom.h ] ) ); u.uOrigin.value.set( ...( geom.origin || [ 0, 0 ] ) );
		u.uGrainScale.value = Math.max( 1, geom.grainScale || 1 );
		const r = this.r, prev = r.getRenderTarget();
		r.setRenderTarget( target ); this.quad.material = this.mat;
		const ac = r.autoClear; r.autoClear = false; this.quad.render( r ); r.autoClear = ac;
		r.setRenderTarget( prev );

	}

	denoise( map, w, h, strength ) {

		if ( strength <= 0.001 ) return map;
		if ( ! this.dnRT || this.dnRT.width !== w || this.dnRT.height !== h ) {

			this.dnRT?.dispose();
			this.dnRT = new THREE.WebGLRenderTarget( w, h, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false } );

		}

		this.dn.uniforms.map.value = map; this.dn.uniforms.sigma.value = 2 + strength * 6; this.dn.uniforms.threshold.value = 0.02 + strength * 0.06; this.dn.uniforms.kSigma.value = 1;
		const r = this.r, prev = r.getRenderTarget(); r.setRenderTarget( this.dnRT ); this.quad.material = this.dn;
		const ac = r.autoClear; r.autoClear = false; this.quad.render( r ); r.autoClear = ac; r.setRenderTarget( prev );
		return this.dnRT.texture;

	}

	/** Histogram of the graded output + luminance percentiles of the scene-linear input. */
	analyse( map, p ) {

		const r = this.r, out = { hist: null, lum: null };
		this.setParams( p );
		this.draw( map, { w: this.hist.width, h: this.hist.height }, this.hist );
		const px = new Uint8Array( this.hist.width * this.hist.height * 4 );
		r.readRenderTargetPixels( this.hist, 0, 0, this.hist.width, this.hist.height, px );
		const bins = [ new Uint32Array( 64 ), new Uint32Array( 64 ), new Uint32Array( 64 ), new Uint32Array( 64 ) ];
		for ( let i = 0; i < px.length; i += 4 ) {

			if ( px[ i + 3 ] === 0 ) continue;
			bins[ 0 ][ px[ i ] >> 2 ] ++; bins[ 1 ][ px[ i + 1 ] >> 2 ] ++; bins[ 2 ][ px[ i + 2 ] >> 2 ] ++;
			bins[ 3 ][ ( 0.2126 * px[ i ] + 0.7152 * px[ i + 1 ] + 0.0722 * px[ i + 2 ] ) / 4 | 0 ] ++;

		}

		out.hist = bins;
		return out;

	}

	linearStats( map ) {

		const r = this.r, prev = r.getRenderTarget();
		this.copy.uniforms.tMap.value = map; this.quad.material = this.copy; r.setRenderTarget( this.small );
		const ac = r.autoClear; r.autoClear = false; this.quad.render( r ); r.autoClear = ac;
		const f = new Float32Array( 160 * 90 * 4 ); r.readRenderTargetPixels( this.small, 0, 0, 160, 90, f ); r.setRenderTarget( prev );
		const L = [];
		for ( let i = 0; i < f.length; i += 4 ) if ( f[ i + 3 ] > 0.05 || true ) L.push( 0.2126 * f[ i ] + 0.7152 * f[ i + 1 ] + 0.0722 * f[ i + 2 ] );
		L.sort( ( a, b ) => a - b );
		const q = k => L[ Math.min( L.length - 1, Math.floor( k * L.length ) ) ];
		return { p2: q( 0.02 ), p25: q( 0.25 ), p50: q( 0.5 ), p75: q( 0.75 ), p98: q( 0.98 ), p995: q( 0.995 ) };

	}

	/** Lightroom-style Auto: pick exposure and tonal ranges from the rendered image. */
	auto( map, p ) {

		const s = this.linearStats( map );
		const med = Math.max( s.p50, 1e-4 );
		const ev = clamp( Math.log2( 0.2 / med ), - 3.5, 3.5 );
		const hiLinear = s.p98 * Math.pow( 2, ev ), loLinear = s.p2 * Math.pow( 2, ev );
		return Object.assign( {}, p, {
			exposure: + ev.toFixed( 2 ),
			highlights: + clamp( - Math.log2( Math.max( hiLinear, 1e-3 ) / 2.5 ) * - 0.5 * - 1, - 1, 0.2 ).toFixed( 2 ),
			shadows: + clamp( Math.log2( 0.02 / Math.max( loLinear, 1e-4 ) ) * 0.25, 0, 0.8 ).toFixed( 2 ),
			contrast: 0.12, whites: 0, blacks: - 0.05, vibrance: 0.15,
		} );

	}

	async setLutFromText( text, name ) {

		const lines = text.split( /\r?\n/ ); let n = 0; const vals = [];
		for ( const raw of lines ) {

			const l = raw.trim(); if ( ! l || l[ 0 ] === '#' ) continue;
			if ( l.startsWith( 'LUT_3D_SIZE' ) ) { n = parseInt( l.split( /\s+/ )[ 1 ] ); continue; }
			if ( /^[A-Z_]+/.test( l ) ) continue;
			const p = l.split( /\s+/ ).map( Number ); if ( p.length === 3 && ! p.some( isNaN ) ) vals.push( ...p );

		}

		if ( ! n || vals.length < n * n * n * 3 ) throw new Error( 'Not a 3D .cube LUT' );
		const half = new Uint16Array( n * n * n * 4 );
		for ( let i = 0; i < n * n * n; i ++ ) { half[ i * 4 ] = THREE.DataUtils.toHalfFloat( vals[ i * 3 ] ); half[ i * 4 + 1 ] = THREE.DataUtils.toHalfFloat( vals[ i * 3 + 1 ] ); half[ i * 4 + 2 ] = THREE.DataUtils.toHalfFloat( vals[ i * 3 + 2 ] ); half[ i * 4 + 3 ] = THREE.DataUtils.toHalfFloat( 1 ); }
		const t = new THREE.Data3DTexture( half, n, n, n ); t.format = THREE.RGBAFormat; t.type = THREE.HalfFloatType; t.minFilter = t.magFilter = THREE.LinearFilter;
		t.wrapS = t.wrapT = t.wrapR = THREE.ClampToEdgeWrapping; t.unpackAlignment = 1; t.needsUpdate = true;
		this.lut?.dispose(); this.lut = t; this.lutName = name;

	}

	clearLut() { this.lut?.dispose(); this.lut = null; this.lutName = ''; }

}
