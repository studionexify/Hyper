import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { defaultSpec, PRESETS } from './materials.js';

const P = n => PRESETS.find( p => p.name === n ).spec;
const spec = ( n, o = {} ) => defaultSpec( Object.assign( { preset: n }, P( n ), o ) );

/** Stadium (oval) outline with optional scallops: the ribbed profile from the lamp reference. */
function stadiumShape( w, h, ribs, depth, segs = 10 ) {

	const r = h / 2, sl = w - h; // straight length
	const perim = 2 * sl + 2 * Math.PI * r, pts = [];
	const total = ribs > 0 ? ribs * segs : 96;
	const at = ( s ) => {

		s = ( ( s % perim ) + perim ) % perim;
		if ( s < sl ) return { x: - sl / 2 + s, y: - r, nx: 0, ny: - 1 };
		s -= sl;
		if ( s < Math.PI * r ) { const a = - Math.PI / 2 + s / r; return { x: sl / 2 + Math.cos( a ) * r, y: Math.sin( a ) * r, nx: Math.cos( a ), ny: Math.sin( a ) }; }
		s -= Math.PI * r;
		if ( s < sl ) return { x: sl / 2 - s, y: r, nx: 0, ny: 1 };
		s -= sl;
		const a = Math.PI / 2 + s / r; return { x: - sl / 2 + Math.cos( a ) * r, y: Math.sin( a ) * r, nx: Math.cos( a ), ny: Math.sin( a ) };

	};

	for ( let i = 0; i < total; i ++ ) {

		const t = i / total, q = at( t * perim ), ph = ( i % segs ) / segs;
		const bump = ribs > 0 ? Math.sqrt( Math.max( 0, Math.sin( ph * Math.PI ) ) ) * depth : 0;
		pts.push( new THREE.Vector2( q.x + q.nx * bump, q.y + q.ny * bump ) );

	}

	return new THREE.Shape( pts );

}

function extrude( shape, d, bevel = 0.0012 ) {

	const g = new THREE.ExtrudeGeometry( shape, { depth: d, bevelEnabled: bevel > 0, bevelSize: bevel, bevelThickness: bevel, bevelSegments: 2, curveSegments: 4 } );
	g.computeVertexNormals(); return g;

}

function mesh( geo, name, sp, pos = [ 0, 0, 0 ], rot = [ 0, 0, 0 ] ) {

	const m = new THREE.Mesh( geo, new THREE.MeshPhysicalMaterial() );
	m.name = name; m.position.set( ...pos ); m.rotation.set( ...rot ); m.userData.spec = sp;
	return m;

}

export const SAMPLES = {
	lamp: {
		name: 'Fluted lamp', hint: 'Ribbed desk lamp',
		build() {

			const g = new THREE.Group();
			const base = extrude( stadiumShape( 0.15, 0.085, 0, 0 ), 0.004, 0.0008 ); base.rotateX( - Math.PI / 2 );
			const stem = extrude( stadiumShape( 0.068, 0.056, 28, 0.0014 ), 0.2, 0.0006 ); stem.rotateX( - Math.PI / 2 );
			const head = extrude( stadiumShape( 0.14, 0.06, 40, 0.0014 ), 0.052, 0.0006 ); head.rotateX( - Math.PI / 2 );
			g.add( mesh( base, 'Base plate', spec( 'Signal orange', { roughness: 0.4 } ), [ 0, 0, 0 ] ) );
			g.add( mesh( stem, 'Fluted stem', spec( 'Signal orange', { color: '#e8644f', roughness: 0.5 } ), [ - 0.034, 0.004, 0 ] ) );
			g.add( mesh( head, 'Lamp head', spec( 'Signal orange', { color: '#e8644f', roughness: 0.5 } ), [ 0.0, 0.204, 0 ] ) );
			const ring = new THREE.Mesh( new THREE.CylinderGeometry( 0.024, 0.024, 0.001, 48 ), new THREE.MeshPhysicalMaterial() );
			ring.name = 'Light diffuser'; ring.position.set( 0.0, 0.2035, 0.0 ); ring.userData.spec = spec( 'LED glow', { emissive: '#ffe2b8', emissiveIntensity: 3 } );
			g.add( ring );
			return g;

		},
	},
	pod: {
		name: 'Disc pod', hint: 'Rounded device with disc',
		build() {

			const g = new THREE.Group();
			const body = new RoundedBoxGeometry( 0.12, 0.034, 0.12, 6, 0.012 );
			const disc = new THREE.CylinderGeometry( 0.046, 0.046, 0.0016, 64 );
			const hub = new THREE.CylinderGeometry( 0.0155, 0.0155, 0.002, 48 );
			const port = new RoundedBoxGeometry( 0.016, 0.007, 0.004, 2, 0.0015 );
			g.add( mesh( body, 'Body', spec( 'Gloss ABS', { color: '#f1d27a', roughness: 0.32, clearcoat: 0.3 } ), [ 0, 0.017, 0 ] ) );
			g.add( mesh( disc, 'Disc', spec( 'Gloss ABS', { color: '#f7f5f0', roughness: 0.22 } ), [ 0, 0.0348, 0 ] ) );
			g.add( mesh( hub, 'Disc hub', spec( 'Black plastic', { color: '#3a3b3e', roughness: 0.4 } ), [ 0, 0.0368, 0 ] ) );
			for ( let i = 0; i < 3; i ++ ) g.add( mesh( port, 'Port ' + ( i + 1 ), spec( 'Black plastic' ), [ - 0.026 + i * 0.026, 0.016, 0.0605 ] ) );
			const knob = new THREE.CylinderGeometry( 0.0055, 0.0055, 0.003, 24 );
			g.add( mesh( knob, 'Knob', spec( 'Signal orange', { roughness: 0.35 } ), [ - 0.055, 0.0355, 0.055 ] ) );
			return g;

		},
	},
	kettle: {
		name: 'Kettle', hint: 'Tapered body, strap',
		build() {

			const g = new THREE.Group();
			const pts = [ [ 0.001, 0 ], [ 0.058, 0 ], [ 0.061, 0.004 ], [ 0.07, 0.04 ], [ 0.076, 0.12 ], [ 0.08, 0.2 ], [ 0.082, 0.205 ], [ 0.001, 0.205 ] ].map( p => new THREE.Vector2( p[ 0 ], p[ 1 ] ) );
			g.add( mesh( new THREE.LatheGeometry( pts, 64 ), 'Body', spec( 'Matte ABS', { color: '#8d9095', roughness: 0.62 } ), [ 0, 0.004, 0 ] ) );
			const cap = [ [ 0.001, 0 ], [ 0.083, 0 ], [ 0.083, 0.045 ], [ 0.079, 0.052 ], [ 0.001, 0.052 ] ].map( p => new THREE.Vector2( p[ 0 ], p[ 1 ] ) );
			g.add( mesh( new THREE.LatheGeometry( cap, 64 ), 'Collar', spec( 'Black plastic', { roughness: 0.32 } ), [ 0, 0.209, 0 ] ) );
			const path = new THREE.CurvePath();
			const A = new THREE.Vector3( 0.082, 0.245, 0 ), B = new THREE.Vector3( 0.14, 0.245, 0 ), C = new THREE.Vector3( 0.14, 0.15, 0 ), D = new THREE.Vector3( 0.084, 0.15, 0 );
			path.add( new THREE.LineCurve3( A, B ) ); path.add( new THREE.QuadraticBezierCurve3( B, new THREE.Vector3( 0.152, 0.245, 0 ), new THREE.Vector3( 0.152, 0.23, 0 ) ) );
			path.add( new THREE.LineCurve3( new THREE.Vector3( 0.152, 0.23, 0 ), new THREE.Vector3( 0.152, 0.165, 0 ) ) ); path.add( new THREE.QuadraticBezierCurve3( new THREE.Vector3( 0.152, 0.165, 0 ), new THREE.Vector3( 0.152, 0.15, 0 ), D ) );
			g.add( mesh( new THREE.TubeGeometry( path, 80, 0.0075, 14 ), 'Handle', spec( 'Black plastic', { roughness: 0.4 } ) ) );
			g.add( mesh( new RoundedBoxGeometry( 0.016, 0.075, 0.012, 3, 0.004 ), 'Strap', spec( 'Signal orange', { roughness: 0.35 } ), [ 0, 0.236, 0.082 ] ) );
			return g;

		},
	},
	orb: {
		name: 'Material orb', hint: 'Sphere on plinth',
		build() {

			const g = new THREE.Group();
			g.add( mesh( new THREE.SphereGeometry( 0.06, 96, 64 ), 'Orb', spec( 'Car paint' ), [ 0, 0.066, 0 ] ) );
			g.add( mesh( new THREE.CylinderGeometry( 0.045, 0.05, 0.006, 64 ), 'Plinth', spec( 'Matte ABS', { color: '#2a2c30' } ), [ 0, 0.003, 0 ] ) );
			return g;

		},
	},
};
