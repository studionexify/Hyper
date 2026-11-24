import { S, R, on, emit } from './state.js';
import { h, ic, icon, toast, fmtBytes, tierPx, tierLabels, aspects, clamp } from './util.js';
import { Engine } from './engine.js';
import * as P from './project.js';
import * as UI from './ui.js';

const $ = s => document.querySelector( s );
const ctx = UI.ctx;
let E, busy = false, cancel = false;

// ---------------------------------------------------------------- files out (artifact `downloads` capability, anchor fallback when run standalone)
async function saveFile( filename, data ) {

	let dl = null;
	try { dl = await window.claude?.use?.( 'downloads' ); } catch { dl = null; }
	if ( dl ) {

		try { await dl.save( { filename, data } ); toast( 'Saved ' + filename ); } catch ( e ) { if ( e?.code === 'declined' ) toast( 'Save cancelled' ); else toast( 'Could not save: ' + ( e?.message || e?.code || 'unknown' ), 4500 ); }
		return;

	}

	if ( window.claude ) { toast( 'Saving files is not available in this view. Open the artifact in claude.ai to export.', 6000 ); return; }
	const url = URL.createObjectURL( data instanceof Blob ? data : new Blob( [ data ] ) );
	const a = h( 'a', { href: url, download: filename } ); document.body.append( a ); a.click(); a.remove(); setTimeout( () => URL.revokeObjectURL( url ), 4000 );

}

const mime = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };
const ext = { png: 'png', jpeg: 'jpg', webp: 'webp' };
const toBlob = ( cv, f ) => new Promise( r => cv.toBlob( r, mime[ f ], S.render.quality ) );
const slug = s => s.toLowerCase().replace( /[^a-z0-9]+/g, '-' ).replace( /^-|-$/g, '' ) || 'render';

// ---------------------------------------------------------------- final render + batch
function setBusy( on, text ) {

	busy = on; const sb = $( '#statusbar' );
	$( '#toolbar' ).style.opacity = on ? 0.5 : 1; $( '#toolbar' ).style.pointerEvents = on ? 'none' : '';
	if ( ! on ) sb.dataset.busy = ''; else sb.dataset.busy = text || '1';

}

let prog = { done: 0, total: 1, tile: 0, label: '', t0: 0 };

function onProg( p ) { prog = Object.assign( prog, p, { label: p.status || ( p.total > 1 ? `Rendering tile ${Math.min( p.total, p.done + 1 )} of ${p.total}` : 'Rendering' ) } ); }

/** Render at the chosen size. Resolves { blob, canvas, res } without saving; the viewer decides when to download. */
async function renderToBlob() {

	const res = await E.renderFinal( { tier: S.render.tier, samples: S.render.samples, shouldCancel: () => cancel, onProgress: onProg } );
	const blob = await toBlob( res.canvas, S.render.format );
	if ( ! blob ) throw new Error( 'The browser could not encode this image. Try a smaller size or another format.' );
	return { blob, canvas: res.canvas, res };

}

async function renderFinalFlow() {

	if ( busy ) return;
	cancel = false; setBusy( true, 'Rendering' ); prog = { done: 0, total: 1, tile: 0, label: 'Rendering', t0: performance.now() };
	try {

		const { blob, canvas, res } = await renderToBlob();
		setBusy( false );
		const name = `hyper-${slug( R.models[ 0 ]?.name || 'render' )}-${tierLabels[ S.render.tier ].toLowerCase()}.${ext[ S.render.format ]}`;
		const notes = [ ...res.notes ];
		if ( res.raster ) notes.push( 'Path tracing was unavailable on this GPU, so this image was made with the raster engine.' );
		if ( res.suspect ) notes.push( 'The image looks blank. Check the lights, backdrop and exposure before saving.' );
		showResult( { title: res.suspect ? 'Render finished, check the image' : 'Render complete', canvas, info: `${res.W} × ${res.H} px  ·  ${S.render.format.toUpperCase()}  ·  ${fmtBytes( blob.size )}`, notes, saveLabel: 'Save image', onSave: () => saveFile( name, blob ) } );

	} catch ( e ) {

		if ( e.message === 'cancelled' ) toast( 'Render cancelled' ); else { console.warn( e ); toast( e.message || 'Render failed', 7000 ); }

	} finally { setBusy( false ); }

}

async function renderBatchFlow() {

	if ( busy ) return;
	const all = await P.listScenes(), pick = all.filter( s => ctx.checked?.has( s.id ) );
	if ( ! pick.length ) { toast( 'Tick the scenes you want to render first' ); return; }
	const files = {}; cancel = false; setBusy( true, 'Rendering' ); let first = null, total = 0;
	try {

		for ( let i = 0; i < pick.length; i ++ ) {

			await loadScene( pick[ i ], true ); await new Promise( r => setTimeout( r, 250 ) );
			prog = { done: 0, total: 1, tile: 0, label: `Scene ${i + 1} of ${pick.length}: ${pick[ i ].name}`, t0: performance.now() };
			const { blob, canvas } = await renderToBlob(); first ||= canvas; total += blob.size;
			files[ `${String( i + 1 ).padStart( 2, '0' )}-${slug( pick[ i ].name )}.${ext[ S.render.format ]}` ] = new Uint8Array( await blob.arrayBuffer() );

		}

		setBusy( false );
		const zip = new Blob( [ P.zipFiles( files ) ], { type: 'application/zip' } );
		showResult( { title: `${pick.length} render${pick.length === 1 ? '' : 's'} ready`, canvas: first, info: `${Object.keys( files ).join( ', ' )}  ·  ${fmtBytes( zip.size )}`, notes: [], saveLabel: 'Save ZIP', onSave: () => saveFile( 'hyper-renders.zip', zip ) } );

	} catch ( e ) {

		if ( e.message === 'cancelled' ) toast( 'Batch cancelled' ); else { console.warn( e ); toast( e.message || 'Batch failed', 7000 ); }

	} finally { setBusy( false ); }

}

/** Result dialog: the finished image is shown first; nothing is downloaded until the viewer presses Save. */
function showResult( { title, canvas, info, notes, saveLabel, onSave } ) {

	document.getElementById( 'result' )?.remove();
	const pv = document.createElement( 'canvas' ), k = Math.min( 1, 1000 / Math.max( canvas.width, canvas.height ) );
	pv.width = Math.max( 1, Math.round( canvas.width * k ) ); pv.height = Math.max( 1, Math.round( canvas.height * k ) ); pv.getContext( '2d' ).drawImage( canvas, 0, 0, pv.width, pv.height );
	const close = () => dlg.remove();
	const save = h( 'button.btn.primary', { type: 'button', onclick: async () => { save.disabled = true; try { await onSave(); } finally { save.disabled = false; } } }, ic( 'download' ), saveLabel );
	const dlg = h( 'div#result', { role: 'dialog', 'aria-modal': 'true', 'aria-label': title, onclick: e => { if ( e.target === dlg ) close(); } },
		h( 'div.panel', h( 'div.rh', h( 'b', title ), h( 'button.btn.ghost.icon', { type: 'button', 'aria-label': 'Close', onclick: close }, ic( 'x' ) ) ),
			h( 'div.rv', pv ), h( 'div.ri.num', info ), ...( notes || [] ).map( n => h( 'div.rn', n ) ),
			h( 'div.ra', h( 'button.btn', { type: 'button', onclick: close }, 'Keep editing' ), save ) ) );
	document.body.append( dlg ); save.focus();

}

// ---------------------------------------------------------------- scenes
async function saveScene() {

	const list = await P.listScenes();
	const name = 'Scene ' + ( list.length + 1 );
	E.forceRaster ? null : null;
	const sc = await P.saveScene( name, E ); ctx.curScene = sc.id; toast( `Saved “${name}”` ); UI.renderLeft();

}

async function loadScene( sc, quiet ) {

	try {

		await P.restore( sc.snap ); ctx.curScene = sc.id; syncAfterRestore(); if ( ! quiet ) toast( 'Loaded ' + sc.name );

	} catch ( e ) { console.error( e ); toast( 'Could not load scene: ' + e.message, 4500 ); }

}

function syncAfterRestore() {

	$( '#vpOver' ).replaceChildren(); R.sel = { model: null, part: null }; E.attachGizmo(); buildToolbar(); UI.renderLeft(); UI.renderRight(); E.invalidate();

}

async function exportProject() { await saveFile( 'hyper-project.json', new Blob( [ await P.exportProject() ], { type: 'application/json' } ) ); }

// ---------------------------------------------------------------- toolbar
const tb = ( icn, title, fn, on ) => { const b = h( 'button.tb' + ( on ? '.on' : '' ), { type: 'button', title, 'aria-label': title, onclick: e => { fn( e ); } }, ic( icn ) ); return b; };

function buildToolbar() {

	const el = $( '#toolbar' ); el.replaceChildren();
	const aspectSel = h( 'select.tbsel', { title: 'Frame aspect', 'aria-label': 'Frame aspect', onchange: e => { S.aspect = e.target.value; E.resize(); UI.renderRight(); } }, Object.keys( aspects ).map( k => h( 'option', { value: k, selected: S.aspect === k }, k === 'free' ? 'Free' : k ) ) );
	if ( R.mode === 'prepare' ) {

		const gz = ( m, icn, t ) => { const b = tb( icn, t, () => { R.gizmo = m; [ ...el.querySelectorAll( '[data-g]' ) ].forEach( x => x.classList.toggle( 'on', x.dataset.g === m ) ); E.attachGizmo(); }, R.gizmo === m ); b.dataset.g = m; return b; };
		const aoB = tb( 'ao', 'Ambient occlusion', () => { R.ao = ! R.ao; aoB.classList.toggle( 'on', R.ao ); E.invalidate(); }, R.ao );
		const grB = tb( 'grid', 'Grid', () => { R.grid = ! R.grid; grB.classList.toggle( 'on', R.grid ); E.grid.visible = R.grid; E.invalidate(); }, R.grid );
		const liB = tb( 'light', 'Show lights', () => { R.showLights = R.showLights === false; liB.classList.toggle( 'on', R.showLights !== false ); E.lightHelpers.visible = R.showLights !== false; E.invalidate(); }, R.showLights !== false );
		el.append( h( 'div.grp', gz( 'translate', 'move', 'Move (W)' ), gz( 'rotate', 'rotate', 'Rotate (E)' ), gz( 'scale', 'scale', 'Scale (R)' ), gz( 'none', 'eye', 'No gizmo (Q)' ) ),
			h( 'div.grp', tb( 'floor', 'Drop to floor', () => { R.models.forEach( m => E.dropToFloor( m ) ); UI.renderRight(); } ), tb( 'frame', 'Frame model (F)', () => { E.frame(); UI.renderRight(); } ) ),
			h( 'div.grp', aoB, grB, liB ), h( 'div.grp', aspectSel ) );

	} else {

		const pb = tb( 'pause', 'Pause / resume (Space)', () => { E.paused = ! E.paused; pb.replaceChildren( ic( E.paused ? 'play' : 'pause' ) ); } );
		const cmp = tb( 'compare', 'Hold to compare without adjustments', () => {} ); cmp.addEventListener( 'pointerdown', () => { E.compare = true; } ); [ 'pointerup', 'pointerleave' ].forEach( ev => cmp.addEventListener( ev, () => { E.compare = false; } ) );
		el.append( h( 'div.grp', pb, tb( 'reset', 'Restart render', () => { E.ptDirty.cam = true; E.invalidate(); } ), cmp ), h( 'div.grp', tb( 'frame', 'Frame model', () => { E.frame(); } ) ), h( 'div.grp', aspectSel ) );

	}

}

// ---------------------------------------------------------------- status + memory
function updateStatus() {

	const sb = $( '#statusbar' ), m = E.memory(), total = Math.max( m.total, 1 );
	const pct = ( v ) => ( v / total * 100 ).toFixed( 1 ) + '%';
	const mem = $( '#mem' ); mem.replaceChildren(
		h( 'span.lbl', 'GPU memory' ),
		h( 'div.bar', { title: `Geometry ${fmtBytes( m.geometry )} · Textures ${fmtBytes( m.textures )} · Buffers ${fmtBytes( m.targets )} · BVH ${fmtBytes( m.bvh )}` },
			h( 'i', { style: { width: pct( m.geometry ), background: 'var(--accent)' } } ), h( 'i', { style: { width: pct( m.textures ), background: '#e8a35a' } } ), h( 'i', { style: { width: pct( m.targets ), background: '#6aa3ff' } } ), h( 'i', { style: { width: pct( m.bvh ), background: '#9b8cff' } } ) ),
		h( 'span', h( 'b.num', '≈ ' + fmtBytes( m.total ) ) ) );
	const items = [];
	if ( sb.dataset.busy ) {

		const f = ( prog.done + prog.tile ) / prog.total, el = ( performance.now() - prog.t0 ) / 1000;
		items.push( h( 'span', h( 'b', prog.label ) ), h( 'div.prog', h( 'i', { style: { width: ( f * 100 ).toFixed( 1 ) + '%' } } ) ), h( 'span.num', Math.round( f * 100 ) + '%  ·  ' + el.toFixed( 0 ) + ' s' ), h( 'span.grow' ), btn( 'Cancel', () => { cancel = true; } ) );

	} else if ( R.mode === 'render' && E.ptFailed ) {

		items.push( h( 'span', { style: { color: 'var(--warn)' } }, E.ptFailed ), h( 'span.grow' ), h( 'span.num', E.stats.fps + ' fps' ) );

	} else if ( R.mode === 'render' ) {

		const [ w, hh ] = ( () => { const a = E.aspectValue || 1, l = tierPx[ S.render.tier ]; return a >= 1 ? [ l, Math.round( l / a ) ] : [ Math.round( l * a ), l ]; } )();
		items.push( h( 'span', E.compiling ? h( 'b', 'Compiling shaders…' ) : [ h( 'b.num', Math.min( Math.floor( E.samples ), S.render.samples ) ), ' / ' + S.render.samples + ' samples' ] ),
			h( 'div.prog', h( 'i', { style: { width: clamp( E.samples / S.render.samples * 100, 0, 100 ) + '%' } } ) ), h( 'span.grow' ), h( 'span', 'Output ', h( 'b.num', `${w} × ${hh}` ) ), h( 'span.num', E.stats.fps + ' fps' ) );

	} else {

		const sel = R.sel.part?.name || R.sel.model?.name;
		items.push( h( 'span', h( 'b.num', Math.round( E.stats.tris ).toLocaleString() ), ' triangles' ), h( 'span.num', E.stats.fps + ' fps' ), h( 'span.grow' ), h( 'span', sel ? [ 'Selected ', h( 'b', sel ) ] : 'Click a part to select' ) );

	}

	sb.replaceChildren( ...items );

}

function btn( label, fn ) { return h( 'button.btn.sm', { type: 'button', onclick: fn }, label ); }

// ---------------------------------------------------------------- views
function setView( v ) {

	R.mode = v; S.view = v;
	document.querySelectorAll( '#viewSwitch button' ).forEach( b => { const on_ = b.dataset.view === v; b.classList.toggle( 'on', on_ ); b.setAttribute( 'aria-selected', on_ ); } );
	E.setMode( v ); buildToolbar(); UI.renderLeft(); UI.renderRight(); $( '#vp' ).dataset.mode = v;

}

// ---------------------------------------------------------------- boot
function boot() {

	E = new Engine( $( '#cv' ), $( '#vp' ) ); ctx.E = E; P.bind( E ); window.__hyper = { E, S, R, P, tierPx }; // handle for debugging
	ctx.change = kind => { UI.renderLeft(); if ( kind === 'budget' ) updateStatus(); };
	ctx.onProfile = () => { buildToolbar(); E.grid.visible = R.mode === 'prepare' && R.grid; E.invalidate(); updateStatus(); };
	ctx.renderFinal = renderFinalFlow; ctx.renderBatch = renderBatchFlow; ctx.saveScene = saveScene; ctx.loadScene = loadScene; ctx.exportProject = exportProject;

	// theme
	let dark = matchMedia( '(prefers-color-scheme: dark)' ).matches;
	try { const t = localStorage.getItem( 'hyper-theme' ); if ( t ) dark = t === 'dark'; } catch { /* storage unavailable */ }
	const themeBtn = $( '#btnTheme' );
	const applyTheme = () => { document.documentElement.dataset.theme = dark ? 'dark' : 'light'; themeBtn.replaceChildren( ic( dark ? 'sun' : 'moon' ) ); };
	themeBtn.onclick = () => { dark = ! dark; applyTheme(); try { localStorage.setItem( 'hyper-theme', dark ? 'dark' : 'light' ); } catch { /* ignore */ } };
	applyTheme();
	$( '#btnSaveScene' ).replaceChildren( ic( 'save' ), h( 'span', 'Save scene' ) ); $( '#btnSaveScene' ).onclick = saveScene;
	document.querySelectorAll( '#viewSwitch button' ).forEach( b => b.onclick = () => setView( b.dataset.view ) );
	$( '#fileProject' ).onchange = async e => { const f = e.target.files[ 0 ]; e.target.value = ''; if ( ! f ) return; try { const sc = await P.importProject( await f.text() ); toast( `Imported ${sc.length} scene${sc.length === 1 ? '' : 's'}` ); UI.renderLeft(); if ( sc[ 0 ] ) loadScene( sc[ sc.length - 1 ] ); } catch ( err ) { toast( 'Import failed: ' + err.message, 4500 ); } };

	on( 'pick', e => { const p = e.detail; if ( ! p ) { UI.select( null, null ); return; } UI.select( p.userData.model || R.models[ 0 ], p ); if ( ctx.tab.prepare === 'lights' ) { ctx.tab.prepare = 'material'; UI.renderRight(); } } );
	on( 'pick-light', e => { R.selLight = e.detail; ctx.tab.prepare = 'lights'; E.refreshLightHelpers(); UI.renderRight(); E.invalidate(); } );
	let tt; on( 'transform', () => { clearTimeout( tt ); tt = setTimeout( () => { if ( ctx.tab.prepare === 'transform' ) UI.renderRight(); E.updateEnvironment( true ); }, 50 ); } );
	on( 'restored', () => { buildToolbar(); } );
	on( 'gl-lost', () => { $( '#vpOver' ).innerHTML = '<div class="overlay-msg show"><div>The browser reset the graphics device.<br>Recovering, nothing is lost…</div></div>'; } );
	on( 'gl-restored', () => { $( '#vpOver' ).replaceChildren(); toast( 'Graphics recovered' ); UI.renderRight(); } );
	on( 'engine-error', e => { toast( e.detail, 6000 ); UI.renderRight(); buildToolbar(); } );
	addEventListener( 'error', e => { console.warn( e.error || e.message ); } ); addEventListener( 'unhandledrejection', e => { console.warn( e.reason ); e.preventDefault(); } );

	addEventListener( 'keydown', e => {

		if ( /input|select|textarea/i.test( e.target.tagName ) ) return;
		const k = e.key.toLowerCase();
		if ( k === 'f' ) { E.frame(); UI.renderRight(); }
		if ( R.mode === 'prepare' ) {

			const g = { w: 'translate', e: 'rotate', r: 'scale', q: 'none' }[ k ]; if ( g ) { R.gizmo = g; buildToolbar(); E.attachGizmo(); }
			if ( ( k === 'delete' || k === 'backspace' ) && R.sel.model ) { E.removeModel( R.sel.model ); R.sel = { model: null, part: null }; E.rebuildStage(); E.attachGizmo(); UI.renderLeft(); UI.renderRight(); }

		} else if ( k === ' ' ) { e.preventDefault(); E.paused = ! E.paused; buildToolbar(); }

	} );

	[ 'dragover', 'drop' ].forEach( ev => addEventListener( ev, e => { if ( ! e.dataTransfer?.types?.includes( 'Files' ) ) return; e.preventDefault(); if ( ev === 'drop' ) { const f = [ ...e.dataTransfer.files ]; if ( f.length && R.mode === 'prepare' ) UI.importFiles( f ); else if ( f.length ) toast( 'Switch to Prepare to import models' ); } } ) );
	setView( 'prepare' );
	( async () => {

		try {

			const m = await P.addSample( 'lamp' ); E.rebuildStage(); R.models.forEach( q => E.dropToFloor( q ) ); E.rebuildStage();
			E.updateEnvironment( true ); E.frame( 1.35 ); R.selLight = S.lights[ 0 ]?.id; UI.renderLeft(); UI.renderRight(); E.invalidate();

		} catch ( e ) { console.error( e ); toast( 'Startup error: ' + e.message, 6000 ); }

	} )();

	setInterval( updateStatus, 250 ); updateStatus();

}

if ( document.readyState === 'loading' ) document.addEventListener( 'DOMContentLoaded', boot ); else boot();
