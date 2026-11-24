export const clamp = ( x, a, b ) => Math.min( b, Math.max( a, x ) );
export const lerp = ( a, b, t ) => a + ( b - a ) * t;
export const deg = Math.PI / 180;
export const uid = () => Math.random().toString(36).slice( 2, 9 );
export const clone = o => JSON.parse( JSON.stringify( o ) );

export function debounce( fn, ms ) {

	let t;
	return ( ...a ) => { clearTimeout( t ); t = setTimeout( () => fn( ...a ), ms ); };

}

export function raf( fn ) {

	let q = false;
	return ( ...a ) => { if ( q ) return; q = true; requestAnimationFrame( () => { q = false; fn( ...a ); } ); };

}

/** DOM builder: h('div.class#id', {onclick, style:{}}, ...children) */
export function h( sel, props, ...kids ) {

	const m = sel.match( /^([a-z0-9]+)?((?:[.#][\w-]+)*)$/i );
	const el = document.createElement( m[ 1 ] || 'div' );
	( m[ 2 ].match( /[.#][\w-]+/g ) || [] ).forEach( s => s[ 0 ] === '.' ? el.classList.add( s.slice( 1 ) ) : el.id = s.slice( 1 ) );
	if ( props != null && ( typeof props !== 'object' || props.nodeType || Array.isArray( props ) ) ) { kids.unshift( props ); props = null; }
	for ( const k in props || {} ) {

		const v = props[ k ];
		if ( v == null || v === false ) continue;
		if ( k === 'style' && typeof v === 'object' ) Object.assign( el.style, v );
		else if ( k.startsWith( 'on' ) ) el.addEventListener( k.slice( 2 ).toLowerCase(), v );
		else if ( k === 'html' ) el.innerHTML = v;
		else if ( k in el && k !== 'list' ) { try { el[ k ] = v; } catch { el.setAttribute( k, v ); } } else el.setAttribute( k, v === true ? '' : v );

	}

	const add = k => { if ( k == null || k === false ) return; if ( Array.isArray( k ) ) k.forEach( add ); else el.append( k.nodeType ? k : document.createTextNode( String( k ) ) ); };
	kids.forEach( add );
	return el;

}

// ---- icons (24px grid, stroke) ----
const P = {
	move: '<path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3"/>',
	rotate: '<path d="M20 12a8 8 0 1 1-2.5-5.8"/><path d="M20 4v5h-5"/>',
	scale: '<rect x="4" y="10" width="10" height="10" rx="1.5"/><path d="M14 10l6-6M15 4h5v5"/>',
	import: '<path d="M12 3v12M7 10l5 5 5-5M4 20h16"/>',
	cube: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/>',
	sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
	moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/>',
	grid: '<path d="M4 4h16v16H4zM4 12h16M12 4v16"/>',
	camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
	frame: '<path d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4"/>',
	focus: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/>',
	layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
	eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
	eyeoff: '<path d="M3 3l18 18M10.6 5.1A9.7 9.7 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3.3 4M6.5 6.7C3.7 8.5 2 12 2 12s4 7 10 7c1.6 0 3-.4 4.3-1"/>',
	trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
	plus: '<path d="M12 5v14M5 12h14"/>',
	save: '<path d="M5 4h11l3 3v13H5z"/><path d="M8 4v5h7V4M8 20v-6h8v6"/>',
	play: '<path d="M7 4l13 8-13 8z"/>',
	pause: '<path d="M8 5v14M16 5v14"/>',
	stop: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
	download: '<path d="M12 4v11M7 11l5 5 5-5M4 20h16"/>',
	reset: '<path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v5h5"/>',
	auto: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z"/>',
	sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>',
	compare: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M12 5v14"/>',
	light: '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z"/>',
	shot: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="1.6"/><path d="M21 16l-5-5-8 9"/>',
	floor: '<path d="M3 17l5-6h8l5 6zM8 11V6h8v5"/>',
	pin: '<path d="M12 21s7-6.2 7-11a7 7 0 0 0-14 0c0 4.8 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/>',
	copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
	check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
	x: '<path d="M6 6l12 12M18 6L6 18"/>',
	ao: '<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 0 0 16" fill="currentColor" stroke="none" opacity=".35"/>',
	bbox: '<path d="M4 8l8-4 8 4v8l-8 4-8-4z" stroke-dasharray="2.5 2.5"/>',
	hdr: '<circle cx="12" cy="12" r="8"/><path d="M4 12h16M12 4c3 3 3 13 0 16M12 4c-3 3-3 13 0 16"/>',
};

export const icon = ( n, cls = '' ) => `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${P[ n ] || ''}</svg>`;
export const ic = ( n, cls ) => { const t = document.createElement( 'template' ); t.innerHTML = icon( n, cls ); return t.content.firstChild; };

/** Tanner Helland blackbody approximation; returns linear RGB, normalised to max 1. */
export function kelvinToLinear( k ) {

	const t = clamp( k, 1000, 40000 ) / 100;
	let r, g, b;
	if ( t <= 66 ) {

		r = 255; g = 99.4708025861 * Math.log( t ) - 161.1195681661;
		b = t <= 19 ? 0 : 138.5177312231 * Math.log( t - 10 ) - 305.0447927307;

	} else {

		r = 329.698727446 * Math.pow( t - 60, - 0.1332047592 );
		g = 288.1221695283 * Math.pow( t - 60, - 0.0755148492 ); b = 255;

	}

	const lin = c => Math.pow( clamp( c, 0, 255 ) / 255, 2.2 );
	const rgb = [ lin( r ), lin( g ), lin( b ) ];
	const m = Math.max( ...rgb ) || 1;
	return rgb.map( v => v / m );

}

export function hexToLinear( hex ) {

	const n = parseInt( hex.slice( 1 ), 16 );
	const f = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow( ( v + 0.055 ) / 1.055, 2.4 ); };
	return [ f( n >> 16 & 255 ), f( n >> 8 & 255 ), f( n & 255 ) ];

}

export function fmtBytes( b ) {

	if ( b > 1073741824 ) return ( b / 1073741824 ).toFixed( 2 ) + ' GB';
	if ( b > 1048576 ) return ( b / 1048576 ).toFixed( b > 104857600 ? 0 : 1 ) + ' MB';
	return ( b / 1024 ).toFixed( 0 ) + ' KB';

}

export function toast( msg, ms = 2800 ) {

	const t = document.getElementById( 'toast' );
	t.textContent = msg; t.classList.add( 'show' );
	clearTimeout( toast._t ); toast._t = setTimeout( () => t.classList.remove( 'show' ), ms );

}

export const tierLabels = [ '1K', '2K', '4K', '6K', '8K' ];
export const tierPx = [ 1024, 2048, 4096, 6144, 8192 ];
export const aspects = { '1:1': 1, '4:5': 0.8, '3:2': 1.5, '16:9': 16 / 9, '9:16': 9 / 16, '2:3': 2 / 3, free: 0 };
