import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js';
import { toCreasedNormals, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { toPhysical, defaultSpec, capTextureInPlace } from './materials.js';

export const MODEL_EXT = [ 'glb', 'gltf', 'obj', 'stl', 'ply', 'fbx', '3mf', 'step', 'stp', 'iges', 'igs', 'brep' ];
const ext = n => n.split( '.' ).pop().toLowerCase();

function smooth( geo, angleDeg = 38 ) {

	geo.deleteAttribute( 'normal' );
	const g = mergeVertices( geo, 1e-5 );
	g.deleteAttribute( 'normal' );
	const out = toCreasedNormals( g, angleDeg * Math.PI / 180 );
	return out;

}

let occtPromise = null;
async function getOcct() {

	if ( ! occtPromise ) occtPromise = import( 'occt-import-js' ).then( m => ( m.default || m )( { locateFile: f => new URL( f, document.baseURI ).href } ) );
	return occtPromise;

}

async function readStep( buf, kind ) {

	let occt;
	try { occt = await getOcct(); } catch ( e ) { occtPromise = null; throw new Error( 'STEP / IGES import needs WebAssembly, which this page could not start. Export the part as STL, OBJ or GLB instead.' ); }
	const u8 = new Uint8Array( buf );
	const params = { linearUnit: 'millimeter', linearDeflectionType: 'bounding_box_ratio', linearDeflection: 0.0008, angularDeflection: 0.4 };
	const res = kind === 'iges' ? occt.ReadIgesFile( u8, params ) : kind === 'brep' ? occt.ReadBrepFile( u8, params ) : occt.ReadStepFile( u8, params );
	if ( ! res.success ) throw new Error( 'CAD file could not be tessellated' );
	const g = new THREE.Group();
	res.meshes.forEach( ( m, i ) => {

		const geo = new THREE.BufferGeometry();
		geo.setAttribute( 'position', new THREE.Float32BufferAttribute( m.attributes.position.array, 3 ) );
		if ( m.attributes.normal ) geo.setAttribute( 'normal', new THREE.Float32BufferAttribute( m.attributes.normal.array, 3 ) );
		geo.setIndex( new THREE.BufferAttribute( new ( m.index.array.length > 65535 ? Uint32Array : Uint16Array )( m.index.array ), 1 ) );
		const c = m.color ? new THREE.Color( m.color[ 0 ], m.color[ 1 ], m.color[ 2 ] ) : new THREE.Color( '#c9ccd1' );
		const mesh = new THREE.Mesh( geo, new THREE.MeshPhysicalMaterial( { color: c, roughness: 0.5, metalness: 0 } ) );
		mesh.name = m.name || 'Part ' + ( i + 1 );
		g.add( mesh );

	} );
	g.scale.setScalar( 0.001 ); // millimetres → metres
	g.updateMatrixWorld( true );
	return g;

}

/**
 * files: File[]  (a model plus optional .mtl / .bin / texture images that belong to it)
 * Resolves { group, name, ext, buffer(main file bytes) }.
 */
export async function importModelFiles( files, maxTex ) {

	const main = files.find( f => MODEL_EXT.includes( ext( f.name ) ) );
	if ( ! main ) throw new Error( 'No supported 3D file in the selection' );
	const e = ext( main.name ), buffer = await main.arrayBuffer();
	const side = new Map( files.filter( f => f !== main ).map( f => [ f.name.toLowerCase(), URL.createObjectURL( f ) ] ) );
	const manager = new THREE.LoadingManager();
	manager.setURLModifier( url => { const k = decodeURIComponent( url.split( '/' ).pop().split( '?' )[ 0 ] ).toLowerCase(); return side.get( k ) || url; } );
	let obj;

	if ( e === 'glb' || e === 'gltf' ) {

		obj = ( await new GLTFLoader( manager ).parseAsync( e === 'gltf' ? new TextDecoder().decode( buffer ) : buffer, '' ) ).scene;

	} else if ( e === 'obj' ) {

		const text = new TextDecoder().decode( buffer );
		const loader = new OBJLoader( manager );
		const mtlFile = files.find( f => ext( f.name ) === 'mtl' );
		if ( mtlFile ) { const mtl = new MTLLoader( manager ).parse( await mtlFile.text(), '' ); mtl.preload(); loader.setMaterials( mtl ); }
		obj = loader.parse( text );
		obj.traverse( m => { if ( m.isMesh && ! m.geometry.attributes.normal ) m.geometry = smooth( m.geometry ); } );

	} else if ( e === 'stl' ) {

		const geo = smooth( new STLLoader().parse( buffer ) );
		obj = new THREE.Group(); obj.add( new THREE.Mesh( geo, new THREE.MeshPhysicalMaterial( { color: '#c9ccd1', roughness: 0.5 } ) ) );

	} else if ( e === 'ply' ) {

		let geo = new PLYLoader().parse( buffer );
		if ( ! geo.attributes.normal ) geo = smooth( geo );
		obj = new THREE.Group(); obj.add( new THREE.Mesh( geo, new THREE.MeshPhysicalMaterial( { color: geo.attributes.color ? '#ffffff' : '#c9ccd1', vertexColors: !! geo.attributes.color, roughness: 0.5 } ) ) );

	} else if ( e === 'fbx' ) {

		obj = new FBXLoader( manager ).parse( buffer, '' );

	} else if ( e === '3mf' ) {

		obj = new ThreeMFLoader( manager ).parse( buffer );

	} else {

		obj = await readStep( buffer, e === 'iges' || e === 'igs' ? 'iges' : e === 'brep' ? 'brep' : 'step' );
		obj.traverse( m => { if ( m.isMesh && ! m.geometry.attributes.normal ) m.geometry = smooth( m.geometry ); } );

	}

	const group = new THREE.Group();
	group.add( obj );
	finalizeModel( group, maxTex );
	return { group, name: main.name.replace( /\.[^.]+$/, '' ), ext: e, buffer };

}

/** Convert materials to editable physical ones, cap textures, drop lights/cameras that came with the file. */
export function finalizeModel( group, maxTex ) {

	const kill = [];
	group.traverse( o => { if ( o.isLight || o.isCamera ) kill.push( o ); } );
	kill.forEach( o => o.parent?.remove( o ) );
	group.traverse( o => {

		if ( ! o.isMesh ) return;
		o.userData.pickable = true;
		o.castShadow = o.receiveShadow = true;
		if ( Array.isArray( o.material ) ) o.material = o.material[ 0 ];
		o.material = toPhysical( o.material );
		o.userData.original = true; // spec stays null until the user overrides the imported look
		o.userData.origMat = o.material.clone();
		for ( const k of [ 'map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap' ] ) if ( o.material[ k ] ) capTextureInPlace( o.material[ k ], maxTex );
		if ( o.material.map ) o.material.map.anisotropy = 4;
		o.material.needsUpdate = true;
		if ( o.geometry.attributes.position.count > 40000 && ! o.geometry.boundsTree ) {

			try { o.geometry.computeBoundsTree?.( { indirect: true } ); } catch { /* picking falls back to brute force */ }

		}

	} );

}

export function isEnvFile( f ) { return /\.(hdr|exr)$/i.test( f.name ); }

export async function loadHdri( file ) {

	const buf = await file.arrayBuffer();
	const url = URL.createObjectURL( new Blob( [ buf ] ) );
	const loader = /\.exr$/i.test( file.name ) ? new EXRLoader() : new RGBELoader();
	loader.setDataType( THREE.FloatType );
	const tex = await loader.loadAsync( url );
	URL.revokeObjectURL( url );
	return { data: tex.image.data, w: tex.image.width, h: tex.image.height, flipY: /\.exr$/i.test( file.name ) };

}
