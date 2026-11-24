import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { patternTexture } from './materials.js';

export const KITS = {
	sweep: { name: 'Studio sweep', sub: 'Seamless backdrop', css: 'linear-gradient(#e9e6e0, #d3cfc7)' },
	steps: { name: 'Steps', sub: 'Three stepped blocks', css: 'linear-gradient(135deg,#e4d2c0 0 50%,#c9b7a4 50% 100%)' },
	podium: { name: 'Podium', sub: 'Round plinth + sweep', css: 'radial-gradient(circle at 50% 70%,#f1ece4 0 30%,#d7d0c5 31%)' },
	ribbed: { name: 'Ribbed wall', sub: 'Fluted backdrop', css: 'repeating-linear-gradient(90deg,#c9c4bc 0 6px,#dedad3 6px 12px)' },
	none: { name: 'Void', sub: 'No floor', css: 'linear-gradient(#2a2c31,#17181b)' },
};

function mat( color, rough ) {

	const m = new THREE.MeshPhysicalMaterial( { color, roughness: rough, metalness: 0 } );
	m.side = THREE.DoubleSide; return m;

}

function sweepGeo( width, front, back, radius, wallH ) {

	const prof = [];
	prof.push( [ front, 0 ] ); prof.push( [ - back, 0 ] );
	for ( let i = 1; i <= 16; i ++ ) { const a = i / 16 * Math.PI / 2; prof.push( [ - back - Math.sin( a ) * radius, radius - Math.cos( a ) * radius ] ); }
	prof.push( [ - back - radius, radius + wallH ] );
	const pos = [], idx = [];
	prof.forEach( ( p, i ) => { pos.push( - width / 2, p[ 1 ], p[ 0 ], width / 2, p[ 1 ], p[ 0 ] ); if ( i < prof.length - 1 ) { const a = i * 2; idx.push( a, a + 1, a + 2, a + 1, a + 3, a + 2 ); } } );
	const g = new THREE.BufferGeometry();
	g.setAttribute( 'position', new THREE.Float32BufferAttribute( pos, 3 ) ); g.setIndex( idx ); g.computeVertexNormals();
	return g;

}

function ribbedWallGeo( width, height, pitch, depth ) {

	const n = Math.max( 8, Math.round( width / pitch ) ), seg = 8, pts = [];
	for ( let i = 0; i <= n * seg; i ++ ) {

		const t = i / ( n * seg ), ph = ( i % seg ) / seg;
		pts.push( new THREE.Vector2( - width / 2 + t * width, - Math.sqrt( Math.max( 0, Math.sin( ph * Math.PI ) ) ) * depth ) );

	}

	pts.push( new THREE.Vector2( width / 2, depth * 0.5 ), new THREE.Vector2( - width / 2, depth * 0.5 ) );
	const g = new THREE.ExtrudeGeometry( new THREE.Shape( pts ), { depth: height, bevelEnabled: false, curveSegments: 1 } );
	g.rotateX( - Math.PI / 2 ); g.computeVertexNormals(); return g;

}

/**
 * Build the stage around a model of size `span` (metres). Returns { group, floorY, floors }.
 * `floors` are the meshes that receive the raster contact-shadow overlay.
 */
export function buildStage( kit, st, span ) {

	const group = new THREE.Group(); group.name = 'Stage';
	const floors = []; let floorY = 0;
	const col = new THREE.Color( st.color ), col2 = new THREE.Color( st.color2 );
	const add = ( geo, m, name, pos ) => { const o = new THREE.Mesh( geo, m ); o.name = name; if ( pos ) o.position.set( ...pos ); o.castShadow = o.receiveShadow = true; group.add( o ); return o; };
	const s = Math.max( span, 0.05 );

	if ( kit === 'sweep' || kit === 'podium' || kit === 'ribbed' ) {

		const sw = add( sweepGeo( s * 40, s * 18, s * 3.2, s * 1.6, s * 30 ), mat( col, st.rough ), 'Sweep' ); floors.push( sw );

		if ( kit === 'podium' ) {

			const h = s * 0.16, r = s * 0.95;
			const pod = add( new THREE.CylinderGeometry( r, r * 1.01, h, 96 ), mat( col2, st.rough * 0.8 ), 'Podium', [ 0, h / 2, 0 ] ); floors.length = 0; floors.push( pod, sw ); floorY = h;

		}

		if ( kit === 'ribbed' ) {

			const g = ribbedWallGeo( s * 16, s * 6, s * 0.17, s * 0.06 );
			add( g, mat( col2, st.rough ), 'Ribbed wall', [ 0, 0, - s * 2.2 ] );

		}

	} else if ( kit === 'steps' ) {

		const h = s * 0.28, w = s * 2.4, d = s * 2.6, r = s * 0.01;
		const A = add( new RoundedBoxGeometry( w, h * 1.0, d, 4, r ), mat( col, st.rough ), 'Step A', [ 0, h / 2, 0 ] );
		const B = add( new RoundedBoxGeometry( w, h * 2.0, d, 4, r ), mat( col2, st.rough ), 'Step B', [ - w * 1.02, h, - d * 0.15 ] );
		const C = add( new RoundedBoxGeometry( w, h * 3.1, d, 4, r ), mat( col.clone().lerp( col2, 0.5 ), st.rough ), 'Step C', [ - w * 2.04, h * 1.55, - d * 0.3 ] );
		const bg = add( sweepGeo( s * 40, s * 18, s * 5.5, s * 1.6, s * 30 ), mat( col, st.rough ), 'Back sweep' );
		bg.position.y = - 0.0005; floors.push( A, B, C, bg ); floorY = h;

	} else if ( kit === 'catcher' ) {

		const m = new THREE.MeshPhysicalMaterial( { color: '#ffffff', roughness: 1 } ); m.matte = true; // library flag: shadow catcher
		const p = add( new THREE.PlaneGeometry( s * 60, s * 60 ).rotateX( - Math.PI / 2 ), m, 'Shadow catcher' ); p.userData.catcher = true; floors.push( p );

	}

	group.traverse( o => { if ( o.isMesh ) o.userData.stage = true; } );
	return { group, floorY, floors };

}
