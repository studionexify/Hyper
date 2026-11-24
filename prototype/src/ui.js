import { S, R, emit, on, defaultPost, newLight, lightPreset, PROFILES } from './state.js';
import { h, ic, icon, clamp, clone, uid, fmtBytes, toast, tierLabels, tierPx, aspects, kelvinToLinear } from './util.js';
import { PRESETS, FINISH_CATS, PATTERNS, defaultSpec, swatchCss } from './materials.js';
import { KITS } from './stage.js';
import { TONES, LOOKS } from './post.js';
import { SAMPLES } from './samples.js';
import * as P from './project.js';
import { importModelFiles, isEnvFile, loadHdri } from './importers.js';
import { prepareHdri } from './envbake.js';

let E; // engine
export const ctx = { E: null, change: () => {}, renderRight: () => {}, renderLeft: () => {}, tab: { prepare: 'transform', render: 'output' } };
const $ = s => document.querySelector( s );

// ---------------------------------------------------------------- primitives
const fmtNum = ( v, dec ) => ( Math.abs( v ) >= 100 ? v.toFixed( Math.min( dec, 1 ) ) : v.toFixed( dec ) );

export function slider( o ) {

	const { label, min, max, step = 0.01, dec = 2, unit = '', def, cls = '', get, set } = o;
	const row = h( 'div.row' ), val = h( 'input.val.num', { type: 'text', 'aria-label': label } );
	const r = h( 'input', { type: 'range', min, max, step, 'aria-label': label } ); if ( cls ) r.className = cls;
	const paint = () => r.style.setProperty( '--p', ( ( r.value - min ) / ( max - min ) * 100 ) + '%' );
	const sync = () => { r.value = get(); val.value = fmtNum( + r.value, dec ) + ( unit ? '' : '' ); paint(); };
	r.addEventListener( 'input', () => { set( + r.value ); val.value = fmtNum( + r.value, dec ); paint(); } );
	val.addEventListener( 'change', () => { const x = parseFloat( val.value ); if ( isNaN( x ) ) { sync(); return; } const c = clamp( x, min, max ); set( c ); sync(); } );
	val.addEventListener( 'keydown', e => { if ( e.key === 'Enter' ) val.blur(); } );
	const lab = h( 'label', { title: def !== undefined ? 'Double-click to reset' : '', ondblclick: () => { if ( def !== undefined ) { set( def ); sync(); } } }, label + ( unit ? ` (${unit})` : '' ) );
	row.append( lab, r, val ); sync(); row.sync = sync; return row;

}

export const row = ( label, ...els ) => h( 'div.row.wide', h( 'label', label ), h( 'div', { style: { display: 'flex', gap: '6px', minWidth: 0 } }, ...els ) );
export const full = ( ...els ) => h( 'div.row.full', ...els );

export function sel( items, get, set, cls = '' ) {

	const s = h( 'select', { class: cls } );
	items.forEach( ( it ) => { const [ v, l ] = Array.isArray( it ) ? it : [ it, it ]; s.append( h( 'option', { value: v }, l ) ); } );
	s.value = get(); s.addEventListener( 'change', () => set( s.value ) ); return s;

}

export function chips( items, get, set ) {

	const box = h( 'div.chips' );
	const paint = () => [ ...box.children ].forEach( ( c, i ) => c.classList.toggle( 'on', String( get() ) === String( items[ i ][ 0 ] ) ) );
	items.forEach( ( [ v, l ] ) => box.append( h( 'button.chip', { type: 'button', onclick: () => { set( v ); paint(); } }, l ) ) );
	paint(); return box;

}

export function color( get, set ) { const i = h( 'input', { type: 'color', value: get() } ); i.addEventListener( 'input', () => set( i.value ) ); return i; }
export const btn = ( label, fn, cls = '', icn ) => h( 'button.btn' + ( cls ? '.' + cls.split( ' ' ).join( '.' ) : '' ), { type: 'button', onclick: fn }, icn ? ic( icn ) : null, label );
export const sec = ( title, kids, acts ) => h( 'section.sec', h( 'h4', h( 'span', title ), acts ? h( 'span.acts', acts ) : null ), kids );
const hint = t => h( 'div.hint', t );

function onFiles( input, fn ) { input.onchange = async () => { const f = [ ...input.files ]; input.value = ''; if ( f.length ) await fn( f ); }; }

// ---------------------------------------------------------------- left rail: models (prepare) / scenes (render)
export function renderLeft() {

	const el = $( '#left' ); el.replaceChildren();
	if ( R.mode === 'render' ) { renderScenes( el ); return; }
	el.append( h( 'div.pane-h', 'Scene' ) );
	const drop = h( 'div.drop', { onclick: () => $( '#fileModel' ).click(), tabindex: 0, role: 'button', onkeydown: e => { if ( e.key === 'Enter' ) $( '#fileModel' ).click(); } }, ic( 'import' ), h( 'div', 'Import 3D model' ), h( 'small', 'STEP · STL · OBJ · GLB · FBX · 3MF · PLY' ) );
	[ 'dragover', 'dragenter' ].forEach( ev => drop.addEventListener( ev, e => { e.preventDefault(); drop.classList.add( 'over' ); } ) );
	[ 'dragleave', 'drop' ].forEach( ev => drop.addEventListener( ev, e => { e.preventDefault(); drop.classList.remove( 'over' ); } ) );
	drop.addEventListener( 'drop', e => importFiles( [ ...e.dataTransfer.files ] ) );
	el.append( drop );

	el.append( h( 'div.tree', R.models.length ? R.models.map( modelNode ) : h( 'div.empty', 'No models yet. Import a file or add a sample below.' ) ) );
	el.append( sec( 'Samples', h( 'div.cards', Object.entries( SAMPLES ).map( ( [ id, s ] ) => h( 'button.card', { type: 'button', onclick: async () => { const m = await P.addSample( id ); select( m, null ); ctx.E.rebuildStage(); ctx.E.frame(); ctx.E.updateEnvironment( true ); ctx.change( 'models' ); } }, h( 'div.t', s.name ), h( 'div.s', s.hint ) ) ) ) ) );
	el.append( sec( 'Import units', [ chips( [ [ 'auto', 'Auto fit' ], [ 'mm', 'mm' ], [ 'cm', 'cm' ], [ 'm', 'm' ], [ 'in', 'in' ] ], () => S.units, v => { S.units = v; } ), hint( 'Applied to the next import. Auto fit scales the longest side to 220 mm.' ) ] ) );

}

function modelNode( m ) {

	const nodes = [ h( 'div.node' + ( R.sel.model === m && ! R.sel.part ? '.sel' : '' ), { onclick: () => select( m, null ) },
		ic( 'cube' ), h( 'span.nm', m.name ),
		h( 'button.mini', { title: 'Show / hide', onclick: e => { e.stopPropagation(); m.group.visible = ! m.group.visible; ctx.E.geoDirty = true; ctx.E.invalidate(); renderLeft(); } }, ic( m.group.visible ? 'eye' : 'eyeoff' ) ),
		h( 'button.mini', { title: 'Remove', onclick: e => { e.stopPropagation(); ctx.E.removeModel( m ); if ( R.sel.model === m ) R.sel = { model: null, part: null }; ctx.E.rebuildStage(); ctx.E.attachGizmo(); ctx.change( 'models' ); } }, ic( 'trash' ) ) ) ];
	const parts = []; m.group.traverse( o => { if ( o.isMesh ) parts.push( o ); } );
	if ( parts.length > 1 ) parts.slice( 0, 60 ).forEach( p => nodes.push( h( 'div.node.part' + ( R.sel.part === p ? '.sel' : '' ), { onclick: () => select( m, p ) },
		h( 'span.dot', { style: { background: '#' + p.material.color.getHexString() } } ), h( 'span.nm', p.name || 'Part' ),
		h( 'button.mini', { title: 'Show / hide', onclick: e => { e.stopPropagation(); p.visible = ! p.visible; ctx.E.geoDirty = true; ctx.E.invalidate(); renderLeft(); } }, ic( p.visible ? 'eye' : 'eyeoff' ) ) ) ) );
	if ( parts.length > 60 ) nodes.push( h( 'div.hint', `+ ${parts.length - 60} more parts` ) );
	return nodes;

}

export function select( model, part ) {

	R.sel = { model, part };
	ctx.E.attachGizmo(); renderLeft(); if ( R.mode === 'prepare' ) { if ( part && ctx.tab.prepare === 'transform' ) { /* keep */ } renderRight(); }

}

export async function importFiles( files ) {

	try {

		const env = files.find( isEnvFile );
		if ( env && ! files.some( f => /\.(glb|gltf|obj|stl|ply|fbx|3mf|step|stp)$/i.test( f.name ) ) ) { await setHdri( env ); return; }
		toast( 'Importing ' + files[ 0 ].name + '…' );
		const m = await P.addFromFiles( files ); select( m, null ); ctx.E.rebuildStage(); ctx.E.frame(); ctx.E.updateEnvironment( true ); ctx.change( 'models' );
		toast( `Imported ${m.name}` );

	} catch ( e ) { console.warn( e ); toast( 'Import failed: ' + ( e.message || e ), 5000 ); }

}

async function setHdri( file ) {

	toast( 'Loading HDRI…' );
	const src = await loadHdri( file );
	R.envBase = { id: uid(), name: file.name, data: prepareHdri( src ) }; S.env.base = 'hdri';
	ctx.E.updateEnvironment( true ); renderRight(); toast( 'HDRI applied: ' + file.name );

}

// ---------------------------------------------------------------- right: Prepare
export function renderRight() {

	clearInterval( histTimer ); const el = $( '#right' ); el.replaceChildren();
	const tabs = R.mode === 'prepare' ? [ [ 'transform', 'Object' ], [ 'material', 'Material' ], [ 'lights', 'Light' ], [ 'camera', 'Camera' ], [ 'stage', 'Scene' ] ] : [ [ 'output', 'Output' ], [ 'post', 'Adjust' ], [ 'look', 'Look' ] ];
	const cur = ctx.tab[ R.mode ];
	el.append( h( 'div.tabs', { role: 'tablist' }, tabs.map( ( [ id, l ] ) => h( 'button' + ( id === cur ? '.on' : '' ), { role: 'tab', onclick: () => { ctx.tab[ R.mode ] = id; renderRight(); } }, l ) ) ) );
	const body = h( 'div' ); el.append( body );
	( { transform: tabTransform, material: tabMaterial, lights: tabLights, camera: tabCamera, stage: tabStage, output: tabOutput, post: tabPost, look: tabLook }[ cur ] )( body );

}

// ---- Object
function tabTransform( b ) {

	const m = R.sel.model; if ( ! m ) { b.append( h( 'div.empty', 'Select a model in the viewport or the scene list.' ) ); return; }
	const part = R.gizmoTarget === 'part' && R.sel.part ? R.sel.part : null, o = part || m.group;
	const touch = () => { ctx.E.geoDirty = true; ctx.E.invalidate(); ctx.E.attachGizmo(); };
	b.append( sec( part ? 'Part: ' + part.name : m.name, [] ) );
	const rows = [];
	[ 'X', 'Y', 'Z' ].forEach( ( a, i ) => rows.push( slider( { label: 'Move ' + a, min: - 600, max: 600, step: 0.5, dec: 1, unit: 'mm', def: 0, get: () => o.position.getComponent( i ) * 1000, set: v => { o.position.setComponent( i, v / 1000 ); touch(); } } ) ) );
	b.append( sec( 'Position', rows ) ); const rot = [];
	[ 'X', 'Y', 'Z' ].forEach( ( a, i ) => rot.push( slider( { label: 'Rotate ' + a, min: - 180, max: 180, step: 0.5, dec: 1, unit: '°', def: 0, get: () => [ o.rotation.x, o.rotation.y, o.rotation.z ][ i ] * 180 / Math.PI, set: v => { const r = [ o.rotation.x, o.rotation.y, o.rotation.z ]; r[ i ] = v * Math.PI / 180; o.rotation.set( ...r ); touch(); } } ) ) );
	b.append( sec( 'Rotation', rot ) );
	const base = o.userData._s0 ??= o.scale.x;
	b.append( sec( 'Scale', [ slider( { label: 'Uniform', min: 10, max: 400, step: 1, dec: 0, unit: '%', def: 100, get: () => o.scale.x / base * 100, set: v => { o.scale.setScalar( base * v / 100 ); touch(); } } ), dims( o ) ] ) );
	b.append( sec( 'Place', [ h( 'div.split', btn( 'Drop to floor', () => { ctx.E.dropToFloor( m ); renderRight(); }, 'sm', 'floor' ), btn( 'Center', () => { ctx.E.dropToFloor( m, true ); renderRight(); }, 'sm', 'pin' ) ),
		h( 'div.split', btn( 'Frame', () => ctx.E.frame(), 'sm', 'frame' ), btn( 'Reset', () => { o.position.set( 0, 0, 0 ); o.rotation.set( 0, 0, 0 ); touch(); ctx.E.dropToFloor( m, true ); renderRight(); }, 'sm', 'reset' ) ) ] ) );
	b.append( sec( 'Gizmo applies to', [ chips( [ [ 'model', 'Whole model' ], [ 'part', 'Selected part' ] ], () => R.gizmoTarget, v => { R.gizmoTarget = v; ctx.E.attachGizmo(); renderRight(); } ) ] ) );

}

function dims( o ) {

	const box = new ( ctx.E.bounds().constructor )().setFromObject( o ), s = box.getSize( new ( box.min.constructor )() );
	return h( 'div.kv', h( 'span', 'Size W × H × D' ), h( 'b.num', `${( s.x * 1000 ).toFixed( 1 )} × ${( s.y * 1000 ).toFixed( 1 )} × ${( s.z * 1000 ).toFixed( 1 )} mm` ) );

}

// ---- Material
function tabMaterial( b ) {

	const part = R.sel.part || ( R.sel.model && firstMesh( R.sel.model ) );
	if ( ! part ) { b.append( h( 'div.empty', 'Select a part to edit its material.' ) ); return; }
	const parts = () => { const a = []; ( R.sel.model?.group || part ).traverse( o => { if ( o.isMesh ) a.push( o ); } ); return a; };
	const apply = ( fn, all ) => { ( all ? parts() : [ part ] ).forEach( p => { p.userData.spec ||= defaultSpec( { color: '#' + p.material.color.getHexString(), roughness: p.material.roughness, metalness: p.material.metalness } ); fn( p.userData.spec ); } ); queue( all ? parts() : [ part ] ); };
	let spec = part.userData.spec;
	b.append( sec( part.name || 'Part', [ h( 'div.split', btn( 'Apply to all parts', () => { const s = part.userData.spec; if ( s ) parts().forEach( p => { p.userData.spec = clone( s ); } ); queue( parts() ); toast( 'Material copied to all parts' ); }, 'sm' ), btn( 'Reset to import', () => resetOriginal( part ), 'sm', 'reset' ) ) ] ) );
	if ( ! spec ) {

		b.append( h( 'div.hint', 'This part uses its imported material. Pick a finish below to override it.' ) );

	}

	// library
	const lib = [ chips( [ [ 'All', 'All' ], ...FINISH_CATS.map( c => [ c, c ] ) ], () => ctx.cat || 'All', v => { ctx.cat = v; renderRight(); } ),
		h( 'div.swatches', PRESETS.filter( p => ( ctx.cat || 'All' ) === 'All' || p.cat === ctx.cat ).map( p => h( 'button.sw' + ( spec?.preset === p.name ? '.on' : '' ), { type: 'button', title: p.name, style: { background: swatchCss( p.spec ) }, onclick: () => { const keepImg = part.userData.spec?.image || null; apply( s => { Object.assign( s, defaultSpec(), clone( p.spec ), { preset: p.name, image: keepImg } ); } ); renderRight(); } } ) ) ) ];
	b.append( sec( 'Finish library', lib ) );
	if ( ! spec ) return; spec = part.userData.spec;
	const S_ = ( k, r ) => slider( Object.assign( { get: () => spec[ k ], set: v => { spec[ k ] = v; queue( [ part ] ); } }, r ) );
	b.append( sec( 'Surface', [ row( 'Color', color( () => spec.color, v => { spec.color = v; queue( [ part ] ); } ) ),
		S_( 'roughness', { label: 'Roughness', min: 0, max: 1, def: 0.5 } ), S_( 'metalness', { label: 'Metalness', min: 0, max: 1, def: 0 } ),
		S_( 'clearcoat', { label: 'Clear coat', min: 0, max: 1, def: 0 } ), S_( 'clearcoatRoughness', { label: 'Coat rough', min: 0, max: 1, def: 0.1 } ),
		S_( 'sheen', { label: 'Sheen', min: 0, max: 1, def: 0 } ) ] ) );
	b.append( sec( 'Glass & light', [ S_( 'transmission', { label: 'Transmission', min: 0, max: 1, def: 0 } ), S_( 'ior', { label: 'IOR', min: 1, max: 2.4, def: 1.5 } ),
		slider( { label: 'Thickness', unit: 'mm', min: 0, max: 40, step: 0.5, dec: 1, def: 0, get: () => spec.thickness * 1000, set: v => { spec.thickness = v / 1000; queue( [ part ] ); } } ),
		S_( 'opacity', { label: 'Opacity', min: 0, max: 1, def: 1 } ),
		row( 'Emissive', color( () => spec.emissive, v => { spec.emissive = v; queue( [ part ] ); } ) ), S_( 'emissiveIntensity', { label: 'Glow', min: 0, max: 20, step: 0.1, dec: 1, def: 0 } ) ] ) );
	b.append( sec( 'Pattern', [ row( 'Type', sel( Object.entries( PATTERNS ).map( ( [ k, v ] ) => [ k, v.name ] ), () => spec.pattern.id, v => { spec.pattern.id = v; queue( [ part ] ); } ) ),
		slider( { label: 'Density', min: 1, max: 60, step: 1, dec: 0, def: 8, get: () => spec.pattern.scale, set: v => { spec.pattern.scale = v; queue( [ part ] ); } } ),
		slider( { label: 'Depth', min: 0, max: 3, step: 0.05, dec: 2, def: 1, get: () => spec.pattern.depth, set: v => { spec.pattern.depth = v; queue( [ part ] ); } } ) ] ) );
	const im = spec.image;
	b.append( sec( 'Image wrap', [ full( h( 'div.split', { style: { padding: 0 } }, btn( im ? 'Replace image' : 'Import image', () => $( '#fileImage' ).click(), 'sm', 'import' ), im ? btn( 'Remove', () => { spec.image = null; queue( [ part ] ); renderRight(); }, 'sm', 'trash' ) : h( 'span' ) ) ),
		...( im ? [ row( 'Mapping', sel( [ [ 'uv', 'Model UVs' ], [ 'box', 'Box' ], [ 'planar', 'Planar' ], [ 'cylinder', 'Cylinder' ], [ 'sphere', 'Sphere' ] ], () => im.mapping, v => { im.mapping = v; queue( [ part ] ); } ) ),
			slider( { label: 'Scale', min: 0.1, max: 6, step: 0.01, def: 1, get: () => im.scale, set: v => { im.scale = v; queue( [ part ] ); } } ), slider( { label: 'Rotate', unit: '°', min: - 180, max: 180, step: 1, dec: 0, def: 0, get: () => im.rot, set: v => { im.rot = v; queue( [ part ] ); } } ),
			slider( { label: 'Offset X', min: - 1, max: 1, def: 0, get: () => im.ox, set: v => { im.ox = v; queue( [ part ] ); } } ), slider( { label: 'Offset Y', min: - 1, max: 1, def: 0, get: () => im.oy, set: v => { im.oy = v; queue( [ part ] ); } } ),
			hint( 'Set Color to white so the image shows true. STEP, STL and most OBJ files have no UVs: pick Box or Cylinder.' ) ] : [ hint( 'PNG, JPEG, SVG or WebP. Images wrap the selected part.' ) ] ) ] ) );

}

const pending = new Set();
function queue( meshes ) {

	meshes.forEach( m => pending.add( m ) );
	if ( queue.t ) return; queue.t = requestAnimationFrame( async () => { queue.t = 0; const m = [ ...pending ]; pending.clear(); for ( const x of m ) await ctx.E.applySpec( x ); renderLeft(); } );

}

function firstMesh( model ) { let f = null; model.group.traverse( o => { if ( ! f && o.isMesh ) f = o; } ); return f; }
function resetOriginal( part ) {

	if ( part.userData.baseSpec ) { part.userData.spec = clone( part.userData.baseSpec ); queue( [ part ] ); renderRight(); toast( 'Sample material restored' ); return; }
	if ( ! part.userData.origMat ) { toast( 'This part has no imported material to restore' ); return; }
	part.material = part.userData.origMat.clone(); part.userData.spec = null; ctx.E.ptDirty.mat = true; ctx.E.invalidate(); renderRight(); toast( 'Imported material restored' );

}

onFileInit();
function onFileInit() {

	addEventListener( 'DOMContentLoaded', () => {

		onFiles( $( '#fileModel' ), importFiles );
		onFiles( $( '#fileHdr' ), async f => { try { await setHdri( f[ 0 ] ); } catch ( e ) { toast( 'HDRI failed: ' + e.message, 4000 ); } } );
		onFiles( $( '#fileImage' ), async f => {

			const part = R.sel.part || ( R.sel.model && firstMesh( R.sel.model ) ); if ( ! part ) return;
			const url = await new Promise( res => { const r = new FileReader(); r.onload = () => res( r.result ); r.readAsDataURL( f[ 0 ] ); } );
			part.userData.spec ||= defaultSpec( { color: '#' + part.material.color.getHexString() } );
			part.userData.spec.image = { data: url, name: f[ 0 ].name, mapping: part.geometry.attributes.uv ? 'uv' : 'box', scale: 1, rot: 0, ox: 0, oy: 0 }; part.userData.spec.color = '#ffffff';
			queue( [ part ] ); renderRight();

		} );
		onFiles( $( '#fileLut' ), async f => { try { await ctx.E.post.setLutFromText( await f[ 0 ].text(), f[ 0 ].name ); toast( 'LUT loaded: ' + f[ 0 ].name ); renderRight(); ctx.E.invalidate(); } catch ( e ) { toast( e.message, 4000 ); } } );

	} );

}

// ---- Lights
function tabLights( b ) {

	b.append( sec( 'Presets', [ chips( [ [ 'hero', 'Hero' ], [ 'three', 'Three-point' ], [ 'top', 'Top' ], [ 'rim', 'Rim' ], [ 'soft', 'Overcast' ], [ 'sun', 'Sun' ] ], () => '', v => { S.lights = lightPreset( v ); R.selLight = S.lights[ 0 ]?.id; ctx.E.updateEnvironment(); renderRight(); } ) ] ) );
	const list = S.lights.map( l => h( 'div.lightrow' + ( R.selLight === l.id ? '.sel' : '' ), { onclick: () => { R.selLight = l.id; ctx.E.refreshLightHelpers(); ctx.E.invalidate(); renderRight(); } },
		h( 'span.sq', { style: { background: '#' + kelvinToLinear( l.K ).map( v => Math.round( Math.pow( v, 1 / 2.2 ) * 255 ).toString( 16 ).padStart( 2, '0' ) ).join( '' ), opacity: l.on ? 1 : 0.3 } } ),
		h( 'span.nm', l.name ),
		h( 'button.mini', { title: 'On / off', onclick: e => { e.stopPropagation(); l.on = ! l.on; ctx.E.updateEnvironment(); renderRight(); } }, ic( l.on ? 'eye' : 'eyeoff' ) ),
		h( 'button.mini', { title: 'Delete', onclick: e => { e.stopPropagation(); S.lights = S.lights.filter( q => q !== l ); ctx.E.updateEnvironment(); renderRight(); } }, ic( 'trash' ) ) ) );
	b.append( sec( 'Lights', [ ...list, h( 'div.split', btn( 'Softbox', () => addLight( 'softbox' ), 'sm', 'plus' ), btn( 'Strip', () => addLight( 'strip' ), 'sm', 'plus' ) ), h( 'div.split', btn( 'Disc / sun', () => addLight( 'disc' ), 'sm', 'plus' ), btn( 'Show all lights', () => ctx.E.frameLights(), 'sm', 'frame' ) ) ] ) );
	const l = S.lights.find( x => x.id === R.selLight ) || S.lights[ 0 ];
	if ( l ) {

		R.selLight = l.id;
		const up = () => { ctx.E.updateEnvironment(); };
		const L = ( k, r ) => slider( Object.assign( { get: () => l[ k ], set: v => { l[ k ] = v; up(); } }, r ) );
		b.append( sec( l.name, [ row( 'Type', sel( [ [ 'softbox', 'Softbox' ], [ 'strip', 'Strip' ], [ 'disc', 'Disc / sun' ] ], () => l.type, v => { l.type = v; up(); renderRight(); } ) ),
			L( 'az', { label: 'Around', unit: '°', min: - 180, max: 180, step: 1, dec: 0, def: 35 } ), L( 'el', { label: 'Elevation', unit: '°', min: - 10, max: 90, step: 1, dec: 0, def: 38 } ), L( 'dist', { label: 'Distance', unit: 'm', min: 0.4, max: 6, step: 0.05, def: 1.4 } ) ] ) );
		b.append( sec( 'Shape', [ l.type === 'disc' ? L( 'w', { label: 'Diameter', unit: 'm', min: 0.02, max: 3, step: 0.01, def: 0.45 } ) : L( 'w', { label: 'Size W', unit: 'm', min: 0.05, max: 4, step: 0.01, def: 1 } ),
			l.type === 'disc' ? null : L( 'h', { label: 'Size H', unit: 'm', min: 0.05, max: 4, step: 0.01, def: 1 } ), L( 'soft', { label: 'Softness', min: 0.02, max: 1, def: 0.5 } ), l.type === 'disc' ? null : L( 'roll', { label: 'Roll', unit: '°', min: - 90, max: 90, step: 1, dec: 0, def: 0 } ) ] ) );
		b.append( sec( 'Colour & power', [ slider( { label: 'Power', unit: 'EV', min: - 3, max: 9, step: 0.05, dec: 2, def: Math.log2( 9 ), get: () => Math.log2( Math.max( l.intensity, 0.125 ) ), set: v => { l.intensity = Math.pow( 2, v ); up(); } } ),
			L( 'K', { label: 'Temperature', unit: 'K', min: 2000, max: 12000, step: 50, dec: 0, def: 5600, cls: 'tempbar' } ), slider( { label: 'Tint', min: - 100, max: 100, step: 1, dec: 0, def: 0, cls: 'tintbar', get: () => l.tint * 100, set: v => { l.tint = v / 100; up(); } } ) ] ) );

	}

	b.append( sec( 'Environment', [ chips( [ [ 'studio', 'Studio dome' ], [ 'hdri', 'HDRI' ] ], () => S.env.base, v => { if ( v === 'hdri' && ! R.envBase ) { $( '#fileHdr' ).click(); return; } S.env.base = v; ctx.E.updateEnvironment(); renderRight(); } ),
		slider( { label: 'Ambient', min: 0, max: 3, def: 0.35, get: () => S.env.ambient, set: v => { S.env.ambient = v; ctx.E.updateEnvironment(); } } ),
		slider( { label: 'Ambient K', unit: 'K', min: 2000, max: 12000, step: 50, dec: 0, def: 6500, cls: 'tempbar', get: () => S.env.ambientK, set: v => { S.env.ambientK = v; ctx.E.updateEnvironment(); } } ),
		...( S.env.base === 'hdri' ? [ slider( { label: 'HDRI power', min: 0, max: 4, def: 1, get: () => S.env.hdriIntensity, set: v => { S.env.hdriIntensity = v; ctx.E.updateEnvironment(); } } ), slider( { label: 'HDRI rotate', unit: '°', min: 0, max: 360, step: 1, dec: 0, def: 0, get: () => S.env.rotation, set: v => { S.env.rotation = v; ctx.E.updateEnvironment(); } } ) ] : [] ),
		full( btn( R.envBase ? 'Replace HDRI…' : 'Import HDRI (.hdr / .exr)', () => $( '#fileHdr' ).click(), 'sm', 'hdr' ) ),
		hint( 'Lights are baked into the environment, so they show in reflections and give soft physical shadows in Render.' ) ] ) );

}

function addLight( type ) {

	const l = newLight( type === 'strip' ? { name: 'Strip', type, w: 0.25, h: 1.4, intensity: 12, az: - 100, el: 25 } : type === 'disc' ? { name: 'Disc', type, w: 0.45, soft: 0.12, intensity: 120, az: 70, el: 30, dist: 3 } : { name: 'Softbox', type } );
	S.lights.push( l ); R.selLight = l.id; ctx.E.updateEnvironment(); renderRight();

}

// ---- Camera
function tabCamera( b ) {

	const C = S.camera, relens = () => { ctx.E.applyLens(); ctx.E.ptDirty.cam = true; ctx.E.invalidate(); };
	b.append( sec( 'Lens', [ slider( { label: 'Focal length', unit: 'mm', min: 14, max: 200, step: 1, dec: 0, def: 70, get: () => C.focal, set: v => { C.focal = v; relens(); } } ),
		chips( [ [ 24, '24' ], [ 35, '35' ], [ 50, '50' ], [ 85, '85' ], [ 135, '135' ] ], () => C.focal, v => { C.focal = v; relens(); renderRight(); } ) ] ) );
	b.append( sec( 'Frame', [ chips( Object.keys( aspects ).map( k => [ k, k === 'free' ? 'Free' : k ] ), () => S.aspect, v => { S.aspect = v; ctx.E.resize(); } ),
		slider( { label: 'Margin', unit: '%', min: 100, max: 250, step: 1, dec: 0, def: 125, get: () => ( C.margin || 1.25 ) * 100, set: v => { C.margin = v / 100; ctx.E.frame(); } } ),
		h( 'div.split', btn( 'Auto-center & frame', () => { ctx.E.frame(); renderRight(); }, 'sm', 'frame' ), btn( 'Top view', () => { const c = ctx.E.bounds().getCenter( new ( ctx.E.camera.position.constructor )() ); ctx.E.setCamera( [ c.x, c.y + ctx.E.span * 3, c.z + 0.001 ], c.toArray() ); }, 'sm', 'camera' ) ) ] ) );
	b.append( sec( 'Depth of field', [ chips( [ [ false, 'Off' ], [ true, 'On' ] ], () => C.dof, v => { C.dof = v; relens(); renderRight(); } ),
		...( C.dof ? [ slider( { label: 'Aperture', unit: 'f/', min: 1.2, max: 22, step: 0.1, dec: 1, def: 5.6, get: () => C.fStop, set: v => { C.fStop = v; relens(); } } ),
			slider( { label: 'Focus', unit: 'cm', min: 5, max: 400, step: 0.5, dec: 1, def: 70, get: () => C.focusDist * 100, set: v => { C.focusDist = v / 100; relens(); } } ),
			full( btn( 'Focus on selection', () => { ctx.E.focusOnSelection(); renderRight(); }, 'sm', 'focus' ) ), hint( 'Depth of field shows only in Render.' ) ] : [] ) ] ) );
	const bm = C.bookmarks.map( ( q, i ) => h( 'div.lightrow', { onclick: () => { ctx.E.setCamera( q.pos, q.target ); C.focal = q.focal; relens(); renderRight(); } }, ic( 'camera' ), h( 'span.nm', q.name ), h( 'button.mini', { onclick: e => { e.stopPropagation(); C.bookmarks.splice( i, 1 ); renderRight(); } }, ic( 'trash' ) ) ) );
	b.append( sec( 'Saved views', [ ...bm, full( btn( 'Save current view', () => { ctx.E.syncCameraState(); C.bookmarks.push( { name: 'View ' + ( C.bookmarks.length + 1 ), pos: [ ...C.pos ], target: [ ...C.target ], focal: C.focal } ); renderRight(); }, 'sm', 'plus' ) ) ] ) );

}

// ---- Scene (stage)
const SCENARIOS = [
	{ id: 'clean', name: 'Clean studio', sub: 'White sweep, hero light', kit: 'sweep', color: '#e3e0da', bg: 'match', lights: 'hero', look: 'clean', css: 'linear-gradient(#f4f2ee,#d9d5cd)' },
	{ id: 'podium', name: 'Podium', sub: 'Warm plinth, soft top', kit: 'podium', color: '#e7ddd1', color2: '#cdb9a0', bg: 'match', lights: 'top', look: 'warm', css: 'radial-gradient(circle at 50% 75%,#f3e9dc 0 28%,#d9c9b3 30%)' },
	{ id: 'steps', name: 'Steps', sub: 'Pastel blocks', kit: 'steps', color: '#b9d3ea', color2: '#e9c9a5', bg: 'match', lights: 'three', look: 'clean', css: 'linear-gradient(135deg,#b9d3ea 0 50%,#e9c9a5 50%)' },
	{ id: 'ribbed', name: 'Ribbed wall', sub: 'Fluted backdrop', kit: 'ribbed', color: '#d9a9a0', color2: '#c98e84', bg: 'match', lights: 'rim', look: 'warm', css: 'repeating-linear-gradient(90deg,#d9a9a0 0 6px,#e8c0b8 6px 12px)' },
	{ id: 'dark', name: 'Dark gallery', sub: 'Rim-lit on charcoal', kit: 'sweep', color: '#23252a', bg: 'match', lights: 'rim', look: 'punch', css: 'linear-gradient(#34373d,#16171a)' },
	{ id: 'sun', name: 'Sunlit', sub: 'Hard sun on stone', kit: 'sweep', color: '#e8dcc8', bg: 'match', lights: 'sun', look: 'warm', css: 'linear-gradient(#f6e7c8,#d8c2a0)' },
	{ id: 'catcher', name: 'Cut-out', sub: 'Transparent, no floor', kit: 'none', bg: 'transparent', lights: 'soft', look: 'neutral', css: 'repeating-conic-gradient(#ccc 0 25%,#eee 0 50%) 50%/16px 16px' },
];

function applyScenario( s ) {

	S.stage.kit = s.kit; if ( s.color ) { S.stage.color = s.color; S.stage.bgColor = s.color; } if ( s.color2 ) S.stage.color2 = s.color2; S.stage.bg = s.bg;
	S.lights = lightPreset( s.lights ); R.selLight = S.lights[ 0 ]?.id; S.post.look = s.look; S.post.tone = LOOKS[ s.look ]?.tone ?? 0; if ( s.id === 'sun' ) S.env.ambient = 0.6; else S.env.ambient = 0.35;
	const m = R.models[ 0 ]; ctx.E.rebuildStage(); if ( m ) R.models.forEach( q => ctx.E.dropToFloor( q ) ); ctx.E.rebuildStage(); ctx.E.updateEnvironment( true ); renderRight();

}

function tabStage( b ) {

	b.append( sec( 'Scenarios', h( 'div.cards', SCENARIOS.map( s => h( 'button.card', { type: 'button', onclick: () => applyScenario( s ) }, h( 'div.th', { style: { background: s.css } } ), h( 'div.t', s.name ), h( 'div.s', s.sub ) ) ) ) ) );
	const st = S.stage, rebuild = () => { ctx.E.rebuildStage(); R.models.forEach( m => ctx.E.dropToFloor( m ) ); ctx.E.rebuildStage(); ctx.E.updateEnvironment( true ); };
	b.append( sec( 'Backdrop', [ h( 'div.cards', Object.entries( KITS ).map( ( [ id, k ] ) => h( 'button.card' + ( st.kit === id ? '.on' : '' ), { type: 'button', onclick: () => { st.kit = id; rebuild(); renderRight(); } }, h( 'div.th', { style: { background: k.css, height: '30px' } } ), h( 'div.t', k.name ) ) ) ),
		row( 'Surface', color( () => st.color, v => { st.color = v; if ( st.bg === 'match' ) ctx.E.applyBackground(); ctx.E.rebuildStage(); } ) ), row( 'Secondary', color( () => st.color2, v => { st.color2 = v; ctx.E.rebuildStage(); } ) ),
		slider( { label: 'Roughness', min: 0.05, max: 1, def: 0.9, get: () => st.rough, set: v => { st.rough = v; ctx.E.rebuildStage(); } } ) ] ) );
	b.append( sec( 'Background', [ chips( [ [ 'match', 'Match' ], [ 'color', 'Colour' ], [ 'env', 'Environment' ], [ 'transparent', 'Transparent' ] ], () => st.bg, v => { if ( v === 'transparent' ) ctx.E.setTransparent( true ); else if ( st.bg === 'transparent' ) ctx.E.setTransparent( false, v ); else { st.bg = v; ctx.E.applyBackground(); } renderRight(); } ), st.bg === 'transparent' ? hint( 'The backdrop is removed so the background can be transparent. Pick another background to bring it back.' ) : null,
		...( st.bg === 'color' ? [ row( 'Colour', color( () => st.bgColor, v => { st.bgColor = v; ctx.E.applyBackground(); } ) ) ] : [] ) ] ) );

}

// ---------------------------------------------------------------- right: Render
function sizeFor( tier ) { const a = ctx.E.aspectValue || 1, l = tierPx[ tier ]; return a >= 1 ? [ l, Math.round( l / a ) ] : [ Math.round( l * a ), l ]; }

function tabOutput( b ) {

	const r = S.render, [ w, hh ] = sizeFor( r.tier );
	b.append( sec( 'Hardware', [ row( 'Profile', sel( Object.entries( PROFILES ).map( ( [ k, p ] ) => [ k, p.name ] ), () => r.profile, v => { ctx.E.applyProfile( v ); ctx.onProfile(); renderRight(); } ) ), hint( 'Sets memory budget, texture cap, preview size and GPU load together. Integrated graphics is the default.' ) ] ) );
	b.append( sec( 'Resolution', [ slider( { label: 'Size', min: 0, max: 4, step: 1, dec: 0, def: 1, get: () => r.tier, set: v => { r.tier = v; const [ ww, h2 ] = sizeFor( v ); lab.textContent = `${tierLabels[ v ]} · ${ww} × ${h2} px`; } } ),
		h( 'div.hint', { style: { display: 'flex', justifyContent: 'space-between' } }, ...tierLabels.map( t => h( 'span', t ) ) ) ] ) );
	const lab = h( 'div.kv', { id: 'sizeLab' }, `${tierLabels[ r.tier ]} · ${w} × ${hh} px` ); b.children[ b.children.length - 1 ].append( lab );
	const tiled = Math.max( w, hh ) > 1024; b.append( h( 'div.hint', tiled ? 'Large sizes render in tiles and are stitched in system memory, so GPU use stays flat.' : 'Fits in one pass.' ) );
	b.append( sec( 'Quality', [ slider( { label: 'Samples', min: 8, max: 1024, step: 8, dec: 0, def: 64, get: () => r.samples, set: v => { r.samples = v; ctx.E.target = v; } } ),
		slider( { label: 'Bounces', min: 2, max: 12, step: 1, dec: 0, def: 5, get: () => r.bounces, set: v => { r.bounces = v; ctx.E.applyPTOptions(); ctx.E.resetPT(); } } ),
		slider( { label: 'Denoise', min: 0, max: 1, def: 0.5, get: () => r.denoise, set: v => { r.denoise = v; } } ),
		hint( 'Denoising keeps sample counts low. Raise it for fast drafts, lower it for crisp final detail.' ) ] ) );
	b.append( sec( 'GPU load', [ chips( [ [ 'low', 'Gentle' ], [ 'balanced', 'Balanced' ], [ 'max', 'Full speed' ] ], () => r.gpuLoad, v => { r.gpuLoad = v; ctx.E.applyPTOptions(); } ),
		row( 'Memory', sel( [ [ 1024, '1 GB' ], [ 2048, '2 GB' ], [ 4096, '4 GB' ], [ 8192, '8 GB' ] ], () => r.budgetMB, v => { r.budgetMB = + v; ctx.change( 'budget' ); } ) ),
		row( 'Texture cap', sel( [ [ 512, '512 px' ], [ 1024, '1024 px' ], [ 2048, '2048 px' ], [ 4096, '4096 px' ] ], () => r.maxTex, v => { r.maxTex = + v; ctx.E.applyTextureCap(); toast( 'Textures re-capped to ' + v + ' px' ); } ) ),
		row( 'Live preview', sel( [ [ 0.5, 'Half res' ], [ 1, 'Full res' ] ], () => r.preview, v => { r.preview = + v; ctx.E.resize(); } ) ) ] ) );
	b.append( sec( 'File', [ row( 'Format', sel( [ [ 'png', 'PNG' ], [ 'jpeg', 'JPEG' ], [ 'webp', 'WebP' ] ], () => r.format, v => { r.format = v; renderRight(); } ) ),
		...( r.format !== 'png' ? [ slider( { label: 'Quality', min: 0.5, max: 1, step: 0.01, def: 0.92, get: () => r.quality, set: v => { r.quality = v; } } ) ] : [] ),
		chips( [ [ false, 'Opaque' ], [ true, 'Transparent' ] ], () => r.transparent || S.stage.bg === 'transparent', v => { ctx.E.setTransparent( v ); renderRight(); } ),
		hint( 'EXR, TIFF and AVIF arrive with the standalone app. This page can only save PNG, JPEG and WebP.' ) ] ) );
	b.append( sec( 'Render', [ full( btn( 'Render final image', () => ctx.renderFinal(), 'primary block', 'play' ) ), full( btn( 'Save scene', () => ctx.saveScene(), 'block', 'save' ) ) ] ) );

}

// ---- Adjust (Lightroom-style)
let histCv, histTimer;
export function drawHist( bins ) {

	if ( ! histCv || ! bins ) return; const c = histCv, g = c.getContext( '2d' ), W = c.width = c.clientWidth * 2, H = c.height = c.clientHeight * 2;
	g.clearRect( 0, 0, W, H ); const mx = Math.max( 1, ...bins[ 3 ].slice( 1, 63 ), ...bins[ 0 ].slice( 1, 63 ), ...bins[ 1 ].slice( 1, 63 ), ...bins[ 2 ].slice( 1, 63 ) );
	const cols = [ 'rgba(255,90,80,.55)', 'rgba(80,220,130,.5)', 'rgba(90,150,255,.55)' ];
	g.globalCompositeOperation = 'lighter';
	for ( let k = 0; k < 3; k ++ ) { g.fillStyle = cols[ k ]; g.beginPath(); g.moveTo( 0, H ); for ( let i = 0; i < 64; i ++ ) g.lineTo( i / 63 * W, H - Math.min( 1, bins[ k ][ i ] / mx ) * H * 0.95 ); g.lineTo( W, H ); g.fill(); }

}

function tabPost( b ) {

	const p = S.post, d = defaultPost(), P_ = ( k, label, r = {} ) => slider( Object.assign( { label, min: - 1, max: 1, step: 0.01, def: d[ k ], get: () => p[ k ], set: v => { p[ k ] = v; ctx.E.invalidate(); } }, r ) );
	histCv = h( 'canvas.hist' ); b.append( histCv );
	b.append( h( 'div.split', btn( 'Auto tone', () => { const a = ctx.E.autoPost(); if ( ! a ) { toast( 'Wait for the first samples, then try again' ); return; } Object.assign( p, a ); renderRight(); }, 'sm primary', 'auto' ), btn( 'Auto-center subject', () => { ctx.E.frame(); toast( 'Subject centred and framed' ); }, 'sm', 'frame' ) ) );
	b.append( full( btn( 'Reset adjustments', () => { const l = p.look, t = p.tone; Object.assign( p, defaultPost(), { look: l, tone: t } ); renderRight(); }, 'sm', 'reset' ) ) );
	b.append( sec( 'White balance', [ P_( 'temp', 'Temp', { min: - 100, max: 100, step: 1, dec: 0, cls: 'tempbar' } ), P_( 'tint', 'Tint', { min: - 100, max: 100, step: 1, dec: 0, cls: 'tintbar' } ) ] ) );
	b.append( sec( 'Tone', [ P_( 'exposure', 'Exposure', { min: - 5, max: 5, step: 0.01 } ), P_( 'contrast', 'Contrast' ), P_( 'highlights', 'Highlights' ), P_( 'shadows', 'Shadows' ), P_( 'whites', 'Whites' ), P_( 'blacks', 'Blacks' ) ] ) );
	b.append( sec( 'Presence', [ P_( 'vibrance', 'Vibrance' ), P_( 'saturation', 'Saturation' ), P_( 'sharpen', 'Sharpening', { min: 0, max: 1 } ) ] ) );
	b.append( sec( 'Effects', [ P_( 'vignette', 'Vignette', { min: 0, max: 1 } ), P_( 'vignetteRound', 'Roundness', { min: 0, max: 1, def: 0.5 } ), P_( 'grain', 'Grain', { min: 0, max: 1 } ) ] ) );
	clearInterval( histTimer ); histTimer = setInterval( () => { if ( R.mode === 'render' && histCv?.isConnected ) drawHist( ctx.E.analyse() ); }, 700 );

}

function tabLook( b ) {

	const p = S.post;
	b.append( sec( 'Tone mapping', [ row( 'Profile', sel( TONES.map( ( t, i ) => [ i, t ] ), () => p.tone, v => { p.tone = + v; ctx.E.invalidate(); } ) ), hint( 'Khronos Neutral keeps brand colours closest to the model. ACES and AgX roll highlights off more.' ) ] ) );
	b.append( sec( 'Looks', h( 'div.cards', Object.entries( LOOKS ).map( ( [ id, l ] ) => h( 'button.card' + ( p.look === id ? '.on' : '' ), { type: 'button', onclick: () => { p.look = id; p.tone = l.tone; ctx.E.invalidate(); renderRight(); } }, h( 'div.th', { style: { background: l.css, height: '30px' } } ), h( 'div.t', l.name ) ) ) ) ) );
	const post = ctx.E.post;
	b.append( sec( 'LUT', [ full( btn( post.lut ? 'Replace .cube LUT' : 'Import .cube LUT', () => $( '#fileLut' ).click(), 'sm', 'import' ) ), ...( post.lut ? [ h( 'div.kv', h( 'span', 'Active' ), h( 'b', post.lutName ) ), slider( { label: 'Strength', min: 0, max: 1, def: 1, get: () => p.lutStrength, set: v => { p.lutStrength = v; ctx.E.invalidate(); } } ), full( btn( 'Remove LUT', () => { post.clearLut(); renderRight(); ctx.E.invalidate(); }, 'sm', 'trash' ) ) ] : [] ) ] ) );

}

// ---------------------------------------------------------------- scenes list (render view)
export async function renderScenes( el ) {

	el.replaceChildren( h( 'div.pane-h', h( 'span', 'Scenes' ), btn( '', () => ctx.saveScene(), 'sm ghost icon', 'plus' ) ) );
	const list = await P.listScenes();
	if ( ! list.length ) el.append( h( 'div.empty', 'No saved scenes yet. Set up a shot, then press Save scene to keep it.' ) );
	ctx.checked ||= new Set();
	list.forEach( sc => el.append( h( 'div.sc' + ( ctx.curScene === sc.id ? '.sel' : '' ),
		h( 'input', { type: 'checkbox', checked: ctx.checked.has( sc.id ), title: 'Include in batch', onchange: e => { e.target.checked ? ctx.checked.add( sc.id ) : ctx.checked.delete( sc.id ); } } ),
		sc.thumb ? h( 'img', { src: sc.thumb, alt: '', onclick: () => ctx.loadScene( sc ) } ) : h( 'div.ph' ),
		h( 'div.meta', h( 'input.nm', { value: sc.name, 'aria-label': 'Scene name', onchange: async e => { sc.name = e.target.value; await P.putScene( sc ); } } ), h( 'small', new Date( sc.t ).toLocaleTimeString( [], { hour: '2-digit', minute: '2-digit' } ) + ' · ' + sc.snap.models.length + ' model' + ( sc.snap.models.length === 1 ? '' : 's' ) ) ),
		h( 'div', { style: { display: 'flex', flexDirection: 'column', gap: '2px' } }, h( 'button.mini.tb', { title: 'Load', onclick: () => ctx.loadScene( sc ) }, ic( 'eye' ) ), h( 'button.mini.tb', { title: 'Delete', onclick: async () => { await P.delScene( sc.id ); renderLeft(); } }, ic( 'trash' ) ) ) ) ) );
	el.append( sec( 'Batch', [ full( btn( 'Render checked as ZIP', () => ctx.renderBatch(), 'block', 'layers' ) ), hint( 'Renders each checked scene at the chosen size and saves one ZIP of images.' ) ] ) );
	el.append( sec( 'Project', [ h( 'div.split', btn( 'Export', () => ctx.exportProject(), 'sm', 'download' ), btn( 'Import', () => $( '#fileProject' ).click(), 'sm', 'import' ) ) ] ) );

}
