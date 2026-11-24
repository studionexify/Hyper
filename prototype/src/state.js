import { uid, clone } from './util.js';

/** Everything the user can set that must survive a save: plain JSON only. */
export const PROFILES = {
	integrated: { name: 'Integrated graphics', budgetMB: 1024, maxTex: 1024, gpuLoad: 'low', preview: 0.5, ao: false, aa: false, dpr: 1, ptTex: 512, samples: 64, denoise: 0.5, shadow: 1024 },
	discrete: { name: 'Discrete GPU, 2 GB', budgetMB: 2048, maxTex: 2048, gpuLoad: 'balanced', preview: 1, ao: true, aa: true, dpr: 1.25, ptTex: 1024, samples: 96, denoise: 0.35, shadow: 2048 },
	high: { name: 'High-end GPU', budgetMB: 8192, maxTex: 4096, gpuLoad: 'max', preview: 1, ao: true, aa: true, dpr: 2, ptTex: 2048, samples: 256, denoise: 0.2, shadow: 4096 },
};

export function defaultState() {

	return {
		aspect: '4:5',
		view: 'prepare',
		units: 'auto',
		camera: { pos: [ 0.36, 0.26, 0.62 ], target: [ 0, 0.09, 0 ], margin: 1.25, focal: 70, dof: false, fStop: 5.6, focusDist: 0.7, bookmarks: [] },
		env: { base: 'studio', ambient: 0.25, ambientK: 6500, hdriIntensity: 1, rotation: 0 },
		lights: lightPreset( 'hero' ),
		stage: { kit: 'sweep', color: '#d8d4cd', color2: '#c9bba9', rough: 0.9, bg: 'match', bgColor: '#d8d4cd', ribs: false },
		post: defaultPost(),
		render: { profile: 'integrated', tier: 1, samples: 64, bounces: 5, gpuLoad: 'low', denoise: 0.5, format: 'png', quality: 0.92, preview: 0.5, budgetMB: 1024, transparent: false, maxTex: 1024 },
	};

}

export function defaultPost() {

	return {
		tone: 0, look: 'neutral', lutStrength: 1,
		exposure: 0, temp: 0, tint: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0,
		vibrance: 0, saturation: 0, sharpen: 0, vignette: 0, vignetteRound: 0.5, grain: 0,
	};

}

export function newLight( o = {} ) {

	return Object.assign( {
		id: uid(), name: 'Softbox', type: 'softbox', on: true,
		az: 35, el: 38, dist: 1.4, w: 0.9, h: 0.9, soft: 0.5, K: 5600, tint: 0, intensity: 6, roll: 0,
	}, o );

}

export function lightPreset( id ) {

	const L = ( o ) => newLight( o );
	switch ( id ) {

		case 'top': return [ L( { name: 'Top softbox', az: 0, el: 80, dist: 1.3, w: 1.4, h: 1.4, intensity: 8, K: 5600 } ), L( { name: 'Fill', type: 'softbox', az: 150, el: 20, dist: 1.8, w: 1.2, h: 1.2, intensity: 2, K: 6500 } ) ];
		case 'rim': return [ L( { name: 'Rim left', type: 'strip', az: - 130, el: 28, dist: 1.4, w: 0.25, h: 1.4, intensity: 16, K: 7200 } ), L( { name: 'Rim right', type: 'strip', az: 130, el: 28, dist: 1.4, w: 0.25, h: 1.4, intensity: 16, K: 4200 } ), L( { name: 'Key', az: 10, el: 55, dist: 1.6, w: 1.2, h: 1.2, intensity: 4, K: 5600 } ) ];
		case 'three': return [ L( { name: 'Key', az: 40, el: 35, dist: 1.4, w: 1, h: 1, intensity: 10, K: 5200 } ), L( { name: 'Fill', az: - 55, el: 15, dist: 1.8, w: 1.4, h: 1.4, intensity: 3, K: 6800 } ), L( { name: 'Back', type: 'strip', az: 180, el: 40, dist: 1.5, w: 1.6, h: 0.3, intensity: 12, K: 6500 } ) ];
		case 'sun': return [ L( { name: 'Sun', type: 'disc', az: 60, el: 28, dist: 4, w: 0.45, h: 0.45, soft: 0.12, intensity: 220, K: 5000 } ) ];
		case 'soft': return [ L( { name: 'Overhead', az: 0, el: 70, dist: 1.5, w: 3, h: 3, soft: 1, intensity: 3.5, K: 6200 } ) ];
		default: return [ L( { name: 'Key softbox', az: 38, el: 36, dist: 1.4, w: 1, h: 1, intensity: 5, K: 5400 } ), L( { name: 'Rim strip', type: 'strip', az: - 125, el: 30, dist: 1.5, w: 0.22, h: 1.5, intensity: 9, K: 7000 } ), L( { name: 'Fill', az: - 45, el: 12, dist: 2, w: 1.4, h: 1.4, intensity: 1.4, K: 6500 } ) ];

	}

}

export const bus = new EventTarget();
export const emit = ( kind, detail ) => bus.dispatchEvent( new CustomEvent( kind, { detail } ) );
export const on = ( kind, fn ) => bus.addEventListener( kind, fn );

export const S = defaultState();

export function replaceState( next ) {

	const d = defaultState();
	const n = clone( next );
	for ( const k of Object.keys( d ) ) {

		if ( n[ k ] === undefined ) continue;
		if ( d[ k ] && typeof d[ k ] === 'object' && ! Array.isArray( d[ k ] ) ) S[ k ] = Object.assign( {}, d[ k ], n[ k ] );
		else S[ k ] = n[ k ];

	}

}

/** Non-serialised runtime state. */
export const R = { mode: 'prepare', sel: { model: null, part: null }, gizmo: 'translate', gizmoTarget: 'model', selLight: null, models: [], envBase: null, ao: false, grid: true, hudTri: 0 };
