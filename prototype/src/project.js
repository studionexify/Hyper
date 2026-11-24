import * as THREE from 'three';
import { zipSync } from 'three/examples/jsm/libs/fflate.module.js';
import { S, R, replaceState, emit } from './state.js';
import { clone, uid, toast } from './util.js';
import { SAMPLES } from './samples.js';
import { importModelFiles, finalizeModel } from './importers.js';

// ---------------------------------------------------------------- storage (IndexedDB with in-memory fallback)
const mem = { assets: new Map(), scenes: new Map() };
let dbp = null;
function db() {

	if ( dbp ) return dbp;
	dbp = new Promise( res => {

		try {

			const rq = indexedDB.open( 'hyper-proto', 1 );
			rq.onupgradeneeded = () => { rq.result.createObjectStore( 'assets' ); rq.result.createObjectStore( 'scenes' ); };
			rq.onsuccess = () => res( rq.result ); rq.onerror = () => res( null ); rq.onblocked = () => res( null );

		} catch { res( null ); }

	} );
	return dbp;

}

async function idb( store, mode, fn ) {

	const d = await db(); if ( ! d ) return null;
	return new Promise( res => { try { const tx = d.transaction( store, mode ), rq = fn( tx.objectStore( store ) ); tx.oncomplete = () => res( rq?.result ?? null ); tx.onerror = () => res( null ); } catch { res( null ); } } );

}

export async function putAsset( id, rec ) { mem.assets.set( id, rec ); await idb( 'assets', 'readwrite', s => s.put( rec, id ) ); }
export async function getAsset( id ) { return mem.assets.get( id ) || await idb( 'assets', 'readonly', s => s.get( id ) ); }
export async function putScene( sc ) { mem.scenes.set( sc.id, sc ); await idb( 'scenes', 'readwrite', s => s.put( sc, sc.id ) ); }
export async function delScene( id ) { mem.scenes.delete( id ); await idb( 'scenes', 'readwrite', s => s.delete( id ) ); }
export async function listScenes() {

	const all = await idb( 'scenes', 'readonly', s => s.getAll() );
	const arr = all && all.length ? all : [ ...mem.scenes.values() ];
	return arr.sort( ( a, b ) => a.t - b.t );

}

// ---------------------------------------------------------------- model creation
let engineRef = null;
export const bind = e => { engineRef = e; };

export async function createModel( src, engine = engineRef ) {

	let group, name;
	if ( src.kind === 'sample' ) { const s = SAMPLES[ src.id ]; group = s.build(); finalizeModel( group, S.render.maxTex ); group.traverse( o => { if ( o.isMesh ) { o.userData.original = false; o.userData.baseSpec = clone( o.userData.spec ); } } ); name = s.name; }
	else {

		const a = await getAsset( src.assetId ); if ( ! a ) throw new Error( 'Model file is missing from this browser' );
		const res = await importModelFiles( [ new File( [ a.buffer ], a.name ) ], S.render.maxTex ); group = res.group; name = res.name;

	}

	const wrap = new THREE.Group(); wrap.add( group );
	return { id: uid(), name, group: wrap, src };

}

export async function addFromFiles( files, engine = engineRef ) {

	const res = await importModelFiles( files, S.render.maxTex );
	const assetId = uid(), main = files.find( f => /\.(glb|gltf|obj|stl|ply|fbx|3mf|step|stp|iges|igs|brep)$/i.test( f.name ) );
	await putAsset( assetId, { name: main.name, buffer: res.buffer } );
	const wrap = new THREE.Group(); wrap.add( res.group );
	engine.normaliseImport( wrap, S.units );
	const m = { id: uid(), name: res.name, group: wrap, src: { kind: 'file', assetId, name: main.name } };
	engine.addModel( m ); engine.dropToFloor( m, true ); engine.placeBeside( m );
	return m;

}

export async function addSample( id, engine = engineRef ) {

	const m = await createModel( { kind: 'sample', id } );
	engine.addModel( m ); engine.dropToFloor( m, true ); engine.placeBeside( m );
	const meshes = []; m.group.traverse( o => { if ( o.isMesh ) meshes.push( o ); } );
	await Promise.all( meshes.map( o => engine.applySpec( o ) ) );
	return m;

}

// ---------------------------------------------------------------- snapshots
export function snapshot( engine = engineRef ) {

	const models = R.models.map( m => {

		const parts = []; m.group.traverse( o => { if ( o.isMesh ) parts.push( { name: o.name, visible: o.visible, spec: o.userData.spec ? clone( o.userData.spec ) : null, pos: o.position.toArray(), rot: [ o.rotation.x, o.rotation.y, o.rotation.z ], scl: o.scale.toArray() } ); } );
		return { id: m.id, name: m.name, src: m.src, pos: m.group.position.toArray(), rot: [ m.group.rotation.x, m.group.rotation.y, m.group.rotation.z ], scl: m.group.scale.toArray(), visible: m.group.visible, parts };

	} );
	const s = clone( S ); delete s.view;
	return { v: 1, state: s, models };

}

export async function restore( snap, engine = engineRef ) {

	engine.clearModels(); R.sel = { model: null, part: null };
	replaceState( snap.state );
	for ( const md of snap.models ) {

		const m = await createModel( md.src ); m.id = md.id; m.name = md.name;
		m.group.position.set( ...md.pos ); m.group.rotation.set( ...md.rot ); m.group.scale.set( ...md.scl ); m.group.visible = md.visible !== false;
		const meshes = []; m.group.traverse( o => { if ( o.isMesh ) meshes.push( o ); } );
		meshes.forEach( ( o, i ) => {

			const p = md.parts[ i ]; if ( ! p ) return;
			o.visible = p.visible; if ( p.pos ) { o.position.set( ...p.pos ); o.rotation.set( ...p.rot ); o.scale.set( ...p.scl ); }
			o.userData.spec = p.spec ? clone( p.spec ) : null;

		} );
		engine.addModel( m );
		await Promise.all( meshes.map( o => o.userData.spec ? engine.applySpec( o ) : null ) );

	}

	if ( S.env.base === 'hdri' && ! R.envBase ) { S.env.base = 'studio'; toast( 'This scene used an HDRI that is not loaded; switched to the studio dome' ); }
	engine.rebuildStage(); engine.updateEnvironment( true ); engine.applyLens(); engine.setCamera( S.camera.pos, S.camera.target ); engine.resize();
	engine.ptDirty = { geo: true, mat: true, env: true, cam: true };
	emit( 'restored' );

}

export async function saveScene( name, engine = engineRef, existingId ) {

	const sc = { id: existingId || uid(), name, t: Date.now(), snap: snapshot(), thumb: engine.thumbnail(), renders: [] };
	await putScene( sc ); return sc;

}

// ---------------------------------------------------------------- project export / import (JSON; the download allow-list has no custom extension)
const b64 = buf => { let s = ''; const u = new Uint8Array( buf ), c = 0x8000; for ( let i = 0; i < u.length; i += c ) s += String.fromCharCode.apply( null, u.subarray( i, i + c ) ); return btoa( s ); };
const unb64 = s => { const b = atob( s ), u = new Uint8Array( b.length ); for ( let i = 0; i < b.length; i ++ ) u[ i ] = b.charCodeAt( i ); return u.buffer; };

export async function exportProject() {

	const scenes = await listScenes(), cur = { id: 'current', name: 'Current', t: Date.now(), snap: snapshot(), thumb: '' };
	const all = [ ...scenes, cur ], assets = {};
	for ( const sc of all ) for ( const m of sc.snap.models ) if ( m.src.kind === 'file' && ! assets[ m.src.assetId ] ) { const a = await getAsset( m.src.assetId ); if ( a ) assets[ m.src.assetId ] = { name: a.name, data: b64( a.buffer ) }; }
	return JSON.stringify( { hyper: 1, scenes: all, assets } );

}

export async function importProject( text ) {

	const p = JSON.parse( text ); if ( ! p.hyper ) throw new Error( 'Not a Hyper project file' );
	for ( const id in p.assets ) await putAsset( id, { name: p.assets[ id ].name, buffer: unb64( p.assets[ id ].data ) } );
	const out = [];
	for ( const sc of p.scenes ) { if ( sc.id === 'current' ) sc.id = uid(), sc.name = 'Imported'; await putScene( sc ); out.push( sc ); }
	return out;

}

export function zipFiles( files ) { return zipSync( files, { level: 0 } ); }
