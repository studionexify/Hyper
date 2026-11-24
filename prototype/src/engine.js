import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { WebGLPathTracer, PhysicalCamera } from 'three-gpu-pathtracer';
import { S, R, emit, PROFILES } from './state.js';
import { aspects, tierPx, clamp, deg, hexToLinear } from './util.js';
import { bakeEnvironment, lightDir } from './envbake.js';
import { buildStage } from './stage.js';
import { PostFX, THREE_TONE } from './post.js';
import { defaultPost } from './state.js';
import { buildMaterial, projectUVs, patternTexture, capTextureInPlace } from './materials.js';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

export class Engine {

	constructor( canvas, container ) {

		this.canvas = canvas; this.box = container;
		this.renderer = new THREE.WebGLRenderer( { canvas, antialias: false, alpha: true, preserveDrawingBuffer: true, powerPreference: 'default', premultipliedAlpha: true } );
		this.renderer.shadowMap.enabled = true; this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
		this.renderer.outputColorSpace = THREE.SRGBColorSpace;
		this.dpr = Math.min( window.devicePixelRatio || 1, PROFILES[ S.render.profile ]?.dpr || 1 );
		RectAreaLightUniformsLib.init();

		this.scene = new THREE.Scene(); this.helpers = new THREE.Scene();
		this.modelRoot = new THREE.Group(); this.modelRoot.name = 'Models'; this.scene.add( this.modelRoot );
		this.stageRoot = new THREE.Group(); this.scene.add( this.stageRoot );
		this.shadowProxy = new THREE.Group(); this.scene.add( this.shadowProxy );
		this.camera = new PhysicalCamera( 30, 1, 0.01, 200 ); this.camera.filmGauge = 36;
		this.camera.position.set( ...S.camera.pos );
		this.controls = new OrbitControls( this.camera, canvas );
		this.controls.enableDamping = false; this.controls.target.set( ...S.camera.target ); this.controls.update();
		this.controls.addEventListener( 'change', () => { this.camDirty = true; this.invalidate(); } );
		this.controls.addEventListener( 'end', () => this.syncCameraState() );

		this.tc = new TransformControls( this.camera, canvas );
		this.tc.size = 0.7;
		this.tc.addEventListener( 'dragging-changed', e => { this.controls.enabled = ! e.value; this.dragging = e.value; if ( ! e.value ) { this.geoDirty = true; emit( 'transform' ); } } );
		this.tc.addEventListener( 'objectChange', () => { this.geoDirty = true; this.invalidate(); emit( 'transform-live' ); } );
		this.helpers.add( this.tc.getHelper() );
		this.selBox = new THREE.Box3Helper( new THREE.Box3(), 0xff6a3d ); this.selBox.visible = false; this.helpers.add( this.selBox );
		this.grid = new THREE.GridHelper( 2, 40, 0x666b75, 0x3a3e46 ); this.grid.material.transparent = true; this.grid.material.opacity = 0.16; this.grid.material.depthWrite = false; this.grid.userData.noPT = true; this.scene.add( this.grid );
		this.lightHelpers = new THREE.Group(); this.helpers.add( this.lightHelpers );

		this.post = new PostFX( this.renderer );
		this.pt = new WebGLPathTracer( this.renderer );
		this.pt.renderDelay = 0; this.pt.renderToCanvas = false; this.pt.rasterizeScene = false; this.pt.textureSize.set( PROFILES[ S.render.profile ]?.ptTex || 512, PROFILES[ S.render.profile ]?.ptTex || 512 ); this.pt.minSamples = 0; this.pt.fadeDuration = 0;
		this.pt.filterGlossyFactor = 0.5; this.pt.multipleImportanceSampling = true; this.pt.transmissiveBounces = 6;
		this.ptReady = false; this.ptDirty = { geo: true, mat: true, env: true, cam: true };
		this.ptBusy = false; this.paused = false; this.target = 96;

		this.dirty = true; this.camDirty = false; this.geoDirty = false; this.lastMove = 0;
		this.floorY = 0; this.floors = []; this.span = 0.3;
		this.raycaster = new THREE.Raycaster();
		this.envTex = null; this.envKey = '';
		this.stats = { tris: 0, fps: 0 };
		this.mode = 'prepare';
		this.ray = { down: null };
		this.setupPicking();
		this.buildComposer();
		this.resize();
		new ResizeObserver( () => this.resize() ).observe( container );
		this.loop = this.loop.bind( this ); requestAnimationFrame( this.loop );

	}

	// ---------------------------------------------------------------- sizing
	frameSize() {

		const bw = this.box.clientWidth - 24, bh = this.box.clientHeight - 24;
		const a = aspects[ S.aspect ] || bw / Math.max( 1, bh );
		let w = bw, h = bw / a; if ( h > bh ) { h = bh; w = bh * a; }
		return [ Math.max( 64, Math.floor( w ) ), Math.max( 64, Math.floor( h ) ), a ];

	}

	resize() {

		const [ w, h, a ] = this.frameSize();
		this.aspectValue = a;
		this.renderer.setPixelRatio( this.mode === 'render' ? Math.min( this.dpr, 1 ) * S.render.preview : this.dpr );
		this.renderer.setSize( w, h, false );
		this.canvas.style.width = w + 'px'; this.canvas.style.height = h + 'px';
		this.camera.aspect = a; this.applyLens(); this.camera.updateProjectionMatrix();
		this.composer?.setPixelRatio( this.renderer.getPixelRatio() ); this.composer?.setSize( w, h );
		this.gtao?.setSize( w * this.renderer.getPixelRatio(), h * this.renderer.getPixelRatio() );
		this.ptDirty.cam = true; this.invalidate();

	}

	applyLens() {

		const c = this.camera, f = S.camera.focal;
		c.fov = 2 * Math.atan( ( 36 / Math.max( c.aspect, 0.5 ) / ( c.aspect >= 1 ? 1 : 1 ) ) / 2 / f ) / deg;
		// 36 mm sensor on the long edge
		const long = 36, sensorH = c.aspect >= 1 ? long / c.aspect : long;
		c.fov = 2 * Math.atan( sensorH / 2 / f ) / deg;
		c.fStop = S.camera.fStop; c.focusDistance = S.camera.focusDist; c.apertureBlades = 6;
		c.bokehSize = S.camera.dof ? c.getFocalLength() / S.camera.fStop : 0;
		if ( ! S.camera.dof ) c.fStop = 1e5;
		c.updateProjectionMatrix();

	}

	buildComposer() {

		const rt = new THREE.WebGLRenderTarget( 64, 64, { type: THREE.HalfFloatType, samples: PROFILES[ S.render.profile ]?.aa ? 4 : 0 } );
		this.composer = new EffectComposer( this.renderer, rt );
		this.rp = new RenderPass( this.scene, this.camera );
		this.gtao = new GTAOPass( this.scene, this.camera, 64, 64 );
		this.gtao.output = GTAOPass.OUTPUT.Default;
		try { this.gtao.updateGtaoMaterial( { radius: 0.08, distanceExponent: 1.5, thickness: 1, scale: 1.1, samples: 12, distanceFallOff: 1, screenSpaceRadius: false } ); this.gtao.blendIntensity = 1; } catch { /* defaults */ }
		this.outPass = new OutputPass();
		this.composer.addPass( this.rp ); this.composer.addPass( this.gtao ); this.composer.addPass( this.outPass );

	}

	/** Apply a hardware profile (integrated / discrete / high-end): budgets, quality defaults and buffer sizes. */
	applyProfile( key ) {

		const p = PROFILES[ key ]; if ( ! p ) return;
		Object.assign( S.render, { profile: key, budgetMB: p.budgetMB, maxTex: p.maxTex, gpuLoad: p.gpuLoad, preview: p.preview, samples: p.samples, denoise: p.denoise } );
		R.ao = p.ao; this.dpr = Math.min( window.devicePixelRatio || 1, p.dpr );
		this.pt.textureSize.set( p.ptTex, p.ptTex );
		for ( const rt of [ this.composer.renderTarget1, this.composer.renderTarget2 ] ) { rt.samples = p.aa ? 4 : 0; rt.dispose(); }
		if ( this.sun ) { this.sun.shadow.mapSize.set( p.shadow, p.shadow ); this.sun.shadow.map?.dispose(); this.sun.shadow.map = null; }
		this.applyTextureCap(); this.applyPTOptions(); this.ptDirty.mat = true; this.resize();

	}

	/** Re-cap every texture to the current limit (imported maps shrink in place, image wraps rebuild). */
	applyTextureCap() {

		const cap = S.render.maxTex;
		this.meshes().forEach( m => {

			for ( const k of [ 'map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap' ] ) { const t = m.material[ k ]; if ( t && ! m.userData.spec?.image && t.image && ! t.image.data ) capTextureInPlace( t, cap ); }
			if ( m.userData.spec?.image ) this.applySpec( m );

		} );
		this.ptDirty.mat = true; this.invalidate();

	}

	/** Which stage helpers are visible: raster viewport, raster while orbiting in Render, or the path tracer's scene. */
	vis( kind ) {

		this.shadowProxy.visible = kind === 'raster';
		if ( this.sun ) this.sun.visible = kind === 'raster' && S.lights.some( l => l.on );
		this.stageRoot.traverse( o => { if ( o.userData.catcher ) o.visible = kind === 'pt'; } );
		this.grid.visible = kind === 'raster' && R.grid && this.mode === 'prepare';

	}

	invalidate() { this.dirty = true; }

	// ---------------------------------------------------------------- scene content
	models() { return R.models; }

	addModel( m ) {

		this.modelRoot.add( m.group ); R.models.push( m );
		m.group.traverse( o => { if ( o.isMesh ) o.userData.model = m; } );
		this.geoDirty = true; this.updateTris(); this.invalidate();

	}

	removeModel( m ) {

		if ( this.tc.object && ( this.tc.object === m.group || m.group.getObjectById( this.tc.object.id ) ) ) { this.tc.detach(); this.selBox.visible = false; }
		this.modelRoot.remove( m.group ); R.models = R.models.filter( x => x !== m );
		m.group.traverse( o => { if ( o.isMesh ) { o.geometry.disposeBoundsTree?.(); o.geometry.dispose(); [ o.material ].flat().forEach( q => q.dispose() ); } } );
		this.geoDirty = true; this.updateTris(); this.invalidate();

	}

	clearModels() { this.tc.detach(); this.selBox.visible = false; [ ...R.models ].forEach( m => this.removeModel( m ) ); }

	meshes() { const a = []; this.modelRoot.traverse( o => { if ( o.isMesh ) a.push( o ); } ); return a; }

	bounds() { const b = new THREE.Box3().setFromObject( this.modelRoot ); if ( b.isEmpty() ) b.set( new THREE.Vector3( - 0.1, 0, - 0.1 ), new THREE.Vector3( 0.1, 0.2, 0.1 ) ); return b; }

	updateTris() {

		let t = 0; this.meshes().forEach( m => { const g = m.geometry; t += ( g.index ? g.index.count : g.attributes.position.count ) / 3; } );
		this.stats.tris = t;

	}

	/** Place a model's lowest point on the stage floor and centre it over the origin. */
	dropToFloor( m, centre = false ) {

		m.group.updateMatrixWorld( true );
		const b = new THREE.Box3().setFromObject( m.group );
		if ( centre ) { m.group.position.x -= ( b.min.x + b.max.x ) / 2; m.group.position.z -= ( b.min.z + b.max.z ) / 2; }
		m.group.position.y += this.floorY - b.min.y;
		this.geoDirty = true; this.invalidate();

	}

	/** Put a freshly added model beside the existing ones instead of on top of them. */
	placeBeside( m ) {

		const others = R.models.filter( x => x !== m ); if ( ! others.length ) return;
		const ob = new THREE.Box3(); others.forEach( o => ob.expandByObject( o.group ) );
		m.group.updateMatrixWorld( true ); const mb = new THREE.Box3().setFromObject( m.group );
		m.group.position.x += ob.max.x + 0.04 + ( mb.max.x - mb.min.x ) / 2 - ( mb.min.x + mb.max.x ) / 2;
		this.geoDirty = true; this.invalidate();

	}

	/** Normalise imported size: scale a fresh import so its longest side is sensible for the chosen units. */
	normaliseImport( group, units ) {

		const b = new THREE.Box3().setFromObject( group ), s = new THREE.Vector3(); b.getSize( s );
		const m = Math.max( s.x, s.y, s.z ) || 1;
		const f = { mm: 0.001, cm: 0.01, m: 1, in: 0.0254 }[ units ];
		group.scale.multiplyScalar( f ? f : 0.22 / m );
		group.updateMatrixWorld( true );

	}

	rebuildStage() {

		this.stageRoot.clear(); this.shadowProxy.clear();
		const b = this.bounds(), s = new THREE.Vector3(); b.getSize( s );
		this.span = Math.max( s.x, s.y, s.z, 0.05 );
		const st = buildStage( S.stage.kit, S.stage, this.span );
		this.stageRoot.add( st.group ); this.floorY = st.floorY; this.floors = st.floors;
		// raster-only contact shadow overlay (the path tracer renders real shadows from the emitters)
		const shadowMat = new THREE.ShadowMaterial( { opacity: 0.32, color: 0x000000 } ); shadowMat.polygonOffset = true; shadowMat.polygonOffsetFactor = - 2;
		for ( const f of st.floors ) { const o = new THREE.Mesh( f.geometry, shadowMat ); o.position.copy( f.position ); o.rotation.copy( f.rotation ); o.receiveShadow = true; o.userData.rasterOnly = true; this.shadowProxy.add( o ); }
		this.sun = this.sun || new THREE.DirectionalLight( 0xffffff, 0 ); this.sun.castShadow = true;
		this.scene.add( this.sun ); this.scene.add( this.sun.target );
		this.sun.shadow.mapSize.set( PROFILES[ S.render.profile ]?.shadow || 1024, PROFILES[ S.render.profile ]?.shadow || 1024 ); this.sun.shadow.radius = 6; this.sun.shadow.bias = - 0.0004;
		this.sun.userData.noPT = true;
		this.updateShadowProxy();
		this.grid.position.y = this.floorY + 0.0005; this.grid.scale.setScalar( Math.max( 0.5, this.span * 4 ) / 2 );
		this.applyBackground(); this.ptDirty.geo = true; this.invalidate();

	}

	updateShadowProxy() {

		const key = S.lights.find( l => l.on ) ; if ( ! key ) { this.sun.visible = false; return; }
		const b = this.bounds(), c = b.getCenter( new THREE.Vector3() ), d = lightDir( key.az, Math.max( key.el, 15 ) );
		const r = this.span * 1.4;
		this.sun.visible = true; this.sun.position.set( c.x + d[ 0 ] * r * 3, c.y + d[ 1 ] * r * 3, c.z + d[ 2 ] * r * 3 ); this.sun.target.position.copy( c );
		const sc = this.sun.shadow.camera; sc.left = sc.bottom = - r * 1.6; sc.right = sc.top = r * 1.6; sc.near = 0.01; sc.far = r * 10; sc.updateProjectionMatrix();
		this.sun.shadow.radius = 3 + key.w * 4 / Math.max( 0.6, key.dist );

	}

	applyBackground() {

		const st = S.stage;
		const sc = this.scene;
		if ( st.bg === 'transparent' ) sc.background = null;
		else if ( st.bg === 'env' ) { sc.background = this.envTex; sc.backgroundBlurriness = 0.7; sc.backgroundIntensity = 0.7; }
		else sc.background = new THREE.Color( st.bg === 'match' ? st.color : st.bgColor );
		sc.backgroundIntensity ??= 1;
		this.ptDirty.env = true; this.invalidate();

	}

	updateEnvironment( force = false ) {

		const key = JSON.stringify( [ S.env, S.lights.map( l => [ l.on, l.type, l.az, l.el, l.dist, l.w, l.h, l.soft, l.K, l.tint, l.intensity, l.roll ] ) ] ) + ( R.envBase ? R.envBase.id : '' );
		if ( key === this.envKey && ! force ) return;
		this.envKey = key;
		const tex = bakeEnvironment( S.env, S.lights, R.envBase?.data );
		this.envTex?.dispose();
		this.envTex = tex; this.scene.environment = tex; this.scene.environmentIntensity = 1;
		this.applyBackground(); this.updateShadowProxy(); this.refreshLightHelpers();
		this.ptDirty.env = true; this.invalidate();

	}

	refreshLightHelpers() {

		this.lightHelpers.clear();
		const c = this.bounds().getCenter( new THREE.Vector3() );
		for ( const l of S.lights ) {

			const d = lightDir( l.az, l.el ), disc = l.type === 'disc';
			const geo = disc ? new THREE.CircleGeometry( l.w / 2, 32 ) : new THREE.PlaneGeometry( l.w, l.h );
			const sel = R.selLight === l.id;
			const m = new THREE.Mesh( geo, new THREE.MeshBasicMaterial( { color: sel ? 0xff6a3d : 0xffffff, transparent: true, opacity: l.on ? ( sel ? 0.55 : 0.28 ) : 0.08, side: THREE.DoubleSide, depthWrite: false } ) );
			const e = new THREE.LineSegments( new THREE.EdgesGeometry( geo ), new THREE.LineBasicMaterial( { color: sel ? 0xff6a3d : 0xaab0bb } ) ); m.add( e );
			const dist = l.dist;
			m.position.set( c.x + d[ 0 ] * dist, c.y + d[ 1 ] * dist, c.z + d[ 2 ] * dist ); m.lookAt( c ); m.rotateZ( l.roll * deg );
			m.userData.lightId = l.id;
			this.lightHelpers.add( m );

		}

		this.lightHelpers.visible = this.mode === 'prepare' && R.showLights !== false;

	}

	// ---------------------------------------------------------------- materials
	async applySpec( mesh ) {

		const sp = mesh.userData.spec; if ( ! sp ) return;
		mesh.material = await buildMaterial( sp, S.render.maxTex, mesh.material.isMeshPhysicalMaterial ? mesh.material : undefined );
		if ( ! mesh.geometry.attributes.uv || sp.image || sp.pattern?.id !== 'none' ) {

			const mapping = sp.image?.mapping || ( mesh.geometry.userData.uvBackup !== undefined && mesh.geometry.userData.uvBackup ? 'uv' : mesh.geometry.attributes.uv ? 'uv' : 'box' );
			projectUVs( mesh, { mapping: sp.image ? sp.image.mapping : mapping, scale: sp.image ? sp.image.scale : 1, rot: sp.image?.rot || 0, ox: sp.image?.ox || 0, oy: sp.image?.oy || 0 } );

		}

		mesh.castShadow = mesh.receiveShadow = true;
		this.ptDirty.mat = true; if ( mesh.userData.spec?.pattern?.id === 'perf' ) this.ptDirty.geo = true;
		this.invalidate();

	}

	// ---------------------------------------------------------------- selection + picking
	setupPicking() {

		const el = this.canvas;
		el.addEventListener( 'pointerdown', e => { this.ray.down = [ e.clientX, e.clientY, performance.now() ]; } );
		el.addEventListener( 'pointerup', e => {

			const d = this.ray.down; this.ray.down = null;
			if ( ! d || this.dragging || Math.hypot( e.clientX - d[ 0 ], e.clientY - d[ 1 ] ) > 4 || performance.now() - d[ 2 ] > 500 ) return;
			if ( this.mode !== 'prepare' ) return;
			const r = el.getBoundingClientRect();
			this.raycaster.setFromCamera( new THREE.Vector2( ( e.clientX - r.left ) / r.width * 2 - 1, - ( e.clientY - r.top ) / r.height * 2 + 1 ), this.camera );
			const lh = this.raycaster.intersectObjects( this.lightHelpers.children, false )[ 0 ];
			if ( lh ) { emit( 'pick-light', lh.object.userData.lightId ); return; }
			const hit = this.raycaster.intersectObjects( this.meshes().filter( m => m.visible ), false )[ 0 ];
			emit( 'pick', hit ? hit.object : null );

		} );

	}

	attachGizmo() {

		const tgt = R.gizmoTarget === 'part' ? R.sel.part : R.sel.model?.group;
		if ( tgt && this.mode === 'prepare' && R.gizmo !== 'none' ) { this.tc.attach( tgt ); this.tc.setMode( R.gizmo ); this.tc.showX = this.tc.showY = this.tc.showZ = true; } else this.tc.detach();
		const o = R.sel.part || R.sel.model?.group;
		if ( o ) { this.selBox.box.setFromObject( o ); this.selBox.visible = this.mode === 'prepare'; } else this.selBox.visible = false;
		this.invalidate();

	}

	// ---------------------------------------------------------------- camera helpers
	syncCameraState() {

		S.camera.pos = this.camera.position.toArray().map( v => + v.toFixed( 4 ) ); S.camera.target = this.controls.target.toArray().map( v => + v.toFixed( 4 ) );
		if ( S.camera.focusAuto !== false ) { /* focus distance follows target if enabled by UI */ }

	}

	setCamera( pos, target ) {

		this.camera.position.set( ...pos ); this.controls.target.set( ...target ); this.controls.update(); this.syncCameraState(); this.camDirty = true; this.invalidate();

	}

	frame( padding = S.camera.margin || 1.25 ) {

		const b = this.bounds(), c = b.getCenter( new THREE.Vector3() ), sz = b.getSize( new THREE.Vector3() );
		const r = sz.length() / 2 * padding;
		const vf = this.camera.fov * deg, hf = 2 * Math.atan( Math.tan( vf / 2 ) * this.camera.aspect );
		const dist = r / Math.sin( Math.min( vf, hf ) / 2 );
		const dir = this.camera.position.clone().sub( this.controls.target ).normalize();
		this.setCamera( c.clone().add( dir.multiplyScalar( dist ) ).toArray(), c.toArray() );
		S.camera.focusDist = + dist.toFixed( 3 ); this.applyLens(); this.ptDirty.cam = true;

	}

	/** Pull the camera back until the model and every light helper are inside the frame. */
	frameLights() {

		const b = this.bounds(); this.lightHelpers.children.forEach( l => b.expandByObject( l ) );
		const c = b.getCenter( new THREE.Vector3() ), r = b.getSize( new THREE.Vector3() ).length() / 2 * 1.15;
		const vf = this.camera.fov * deg, hf = 2 * Math.atan( Math.tan( vf / 2 ) * this.camera.aspect );
		const dir = this.camera.position.clone().sub( this.controls.target ).normalize();
		this.setCamera( c.clone().add( dir.multiplyScalar( r / Math.sin( Math.min( vf, hf ) / 2 ) ) ).toArray(), c.toArray() );

	}

	focusOnSelection() {

		const o = R.sel.part || R.sel.model?.group; if ( ! o ) return;
		const c = new THREE.Box3().setFromObject( o ).getCenter( new THREE.Vector3() );
		S.camera.focusDist = + this.camera.position.distanceTo( c ).toFixed( 3 ); this.applyLens(); this.ptDirty.cam = true; this.invalidate();

	}

	// ---------------------------------------------------------------- mode switching
	setMode( mode ) {

		this.mode = mode; R.mode = mode;
		this.tc.enabled = mode === 'prepare';
		this.attachGizmo(); this.grid.visible = mode === 'prepare' && R.grid;
		this.lightHelpers.visible = mode === 'prepare';
		this.vis( mode === 'prepare' ? 'raster' : 'bare' );
		this.resize();
		if ( mode === 'render' ) { this.ptDirty = { geo: true, mat: true, env: true, cam: true }; this.paused = false; this.pt.pausePathTracing = false; }
		this.invalidate();

	}

	// ---------------------------------------------------------------- path tracer plumbing
	syncPT() {

		const pt = this.pt;
		if ( this.ptDirty.geo || ! this.ptReady ) {

			this.vis( 'pt' );
			this.scene.updateMatrixWorld( true ); this.applyLens();
			pt.setScene( this.scene, this.camera ); this.ptReady = true;
			this.ptDirty = { geo: false, mat: false, env: false, cam: false };
			this.applyPTOptions(); return true;

		}

		if ( this.ptDirty.mat ) { pt.updateMaterials(); this.ptDirty.mat = false; }
		if ( this.ptDirty.env ) { pt.updateEnvironment(); pt.updateLights(); this.ptDirty.env = false; }
		if ( this.ptDirty.cam ) { this.applyLens(); this.camera.updateMatrixWorld(); pt.updateCamera(); this.ptDirty.cam = false; }
		return false;

	}

	applyPTOptions() {

		const pt = this.pt, r = S.render;
		pt.bounces = r.bounces; pt.transmissiveBounces = Math.max( 4, r.bounces );
		const t = { low: [ 4, 4 ], balanced: [ 2, 2 ], max: [ 1, 1 ] }[ r.gpuLoad ] || [ 2, 2 ]; pt.tiles.set( ...t );
		this.target = r.samples;

	}

	resetPT() { this.ptDirty.cam = true; this.invalidate(); }

	get samples() { return this.pt.samples; }
	get compiling() { return this.pt.isCompiling; }

	// ---------------------------------------------------------------- frame loop
	rasterTone() {

		const p = S.post;
		this.renderer.toneMapping = THREE_TONE[ p.tone ]; this.renderer.toneMappingExposure = Math.pow( 2, p.exposure );

	}

	renderRaster() {

		this.rasterTone(); this.vis( 'raster' );
		const useAO = R.ao && this.mode === 'prepare';
		this.gtao.enabled = useAO;
		const r = this.renderer;
		if ( useAO || true ) { this.composer.render(); } else r.render( this.scene, this.camera );
		r.autoClear = false; r.clearDepth(); r.toneMapping = THREE.NoToneMapping;
		this.tc.getHelper().visible = this.mode === 'prepare';
		r.render( this.helpers, this.camera );
		r.autoClear = true;

	}

	loop( t ) {

		requestAnimationFrame( this.loop );
		this.controls.update();
		const now = performance.now();
		if ( this.fpsT === undefined ) { this.fpsT = now; this.fpsN = 0; }
		this.fpsN ++; if ( now - this.fpsT > 700 ) { this.stats.fps = Math.round( this.fpsN * 1000 / ( now - this.fpsT ) ); this.fpsT = now; this.fpsN = 0; }
		if ( this.exporting ) return;

		if ( this.mode === 'prepare' ) {

			if ( this.geoDirty ) { this.geoDirty = false; this.ptDirty.geo = true; this.updateShadowProxy(); }
			if ( this.selBox.visible && ( R.sel.part || R.sel.model ) ) this.selBox.box.setFromObject( R.sel.part || R.sel.model.group );
			if ( this.dirty ) { this.dirty = false; this.renderRaster(); }
			return;

		}

		// render mode
		if ( this.geoDirty ) { this.geoDirty = false; this.ptDirty.geo = true; }
		if ( this.camDirty ) { this.camDirty = false; this.ptDirty.cam = true; this.lastMove = now; this.showRasterUntil = now + 220; }
		if ( now < ( this.showRasterUntil || 0 ) ) { this.renderRasterBare(); this.dirty = false; return; }
		if ( this.ptDirty.geo || this.ptDirty.mat || this.ptDirty.env || this.ptDirty.cam || ! this.ptReady ) { const rebuilt = this.syncPT(); if ( rebuilt ) { this.renderRasterBare(); return; } }
		const pt = this.pt;
		if ( ! this.paused && pt.samples < this.target && ! pt.isCompiling ) { pt.pausePathTracing = false; } else pt.pausePathTracing = true;
		pt.renderSample();
		this.displayPT();
		this.maybeStats();

	}

	renderRasterBare() {

		this.rasterTone(); this.vis( 'bare' );
		this.renderer.render( this.scene, this.camera );

	}

	displayPT() {

		const r = this.renderer, p = this.post, size = r.getDrawingBufferSize( new THREE.Vector2() );
		p.setParams( this.compare ? Object.assign( defaultPost(), { tone: S.post.tone } ) : S.post, { alpha: S.stage.bg === 'transparent' || S.render.transparent, sample: this.pt.samples } );
		const map = this.post.denoise( this.pt.target.texture, this.pt.target.width, this.pt.target.height, S.stage.bg === 'transparent' ? 0 : S.render.denoise * 1 );
		r.toneMapping = THREE.NoToneMapping;
		r.setRenderTarget( null ); r.setClearColor( 0x000000, 0 ); r.clear();
		p.draw( map, { w: size.x, h: size.y, grainScale: Math.max( 1, size.y / 1080 ) }, null );

	}

	maybeStats() { /* histogram requests come from the UI via analyse() */ }

	analyse() {

		if ( ! this.ptReady || this.pt.samples < 1 ) return null;
		return this.post.analyse( this.pt.target.texture, S.post ).hist;

	}

	autoPost() { return this.ptReady && this.pt.samples >= 1 ? this.post.auto( this.pt.target.texture, S.post ) : null; }

	// ---------------------------------------------------------------- memory estimate
	memory() {

		const geo = new Set(), tex = new Set(); let gB = 0, tB = 0;
		this.scene.traverse( o => {

			if ( ! o.isMesh ) return;
			if ( ! geo.has( o.geometry ) ) { geo.add( o.geometry ); for ( const k in o.geometry.attributes ) gB += o.geometry.attributes[ k ].array.byteLength; if ( o.geometry.index ) gB += o.geometry.index.array.byteLength; }
			for ( const k in o.material ) { const v = o.material[ k ]; if ( v && v.isTexture && ! tex.has( v ) ) { tex.add( v ); const im = v.image; if ( im ) tB += ( im.width || 1 ) * ( im.height || 1 ) * 4 * ( v.generateMipmaps ? 1.34 : 1 ); } }

		} );
		const d = this.renderer.getDrawingBufferSize( new THREE.Vector2() );
		const px = d.x * d.y;
		let targets = px * ( 8 + 8 + 4 ) + px * 24 * ( this.mode === 'prepare' && R.ao ? 1 : 0 ) + ( 160 * 90 * 16 );
		let rt = 0;
		if ( this.mode === 'render' && this.ptReady ) { const t = this.pt.target; rt = t.width * t.height * 16 * 2 + ( S.render.denoise > 0 ? t.width * t.height * 8 : 0 ); }
		const env = 1024 * 512 * 8 * 1.34 + 6 * 256 * 256 * 8 * 1.34, bvh = this.stats.tris * 56 + this.stats.tris * 40;
		const ptTex = this.mode === 'render' ? tex.size * 1024 * 1024 * 4 : 0;
		return { geometry: gB, textures: tB + env + ptTex, targets: targets + rt, bvh: this.mode === 'render' ? bvh : 0, total: gB + tB + env + targets + rt + ( this.mode === 'render' ? bvh + ptTex : 0 ) };

	}

	// ---------------------------------------------------------------- final-quality export (tiled, host-RAM stitched)
	/**
	 * Render the current scene at tier resolution. Tiles keep GPU memory bounded; each finished tile is
	 * graded and copied into a 2D canvas that lives in system RAM.
	 */
	async renderFinal( { tier, samples, onProgress, shouldCancel } ) {

		const long = tierPx[ tier ], a = this.aspectValue || 1;
		const W = a >= 1 ? long : Math.round( long * a ), H = a >= 1 ? Math.round( long / a ) : long;
		const budget = S.render.budgetMB, T = S.render.tile || ( budget <= 1024 ? 768 : budget <= 2048 ? 1024 : 1536 );
		const margin = ( W <= T && H <= T ) ? 0 : 16;
		const out = document.createElement( 'canvas' ); out.width = W; out.height = H;
		const ctx = out.getContext( '2d', { willReadFrequently: false, alpha: true } );
		const r = this.renderer, cam = this.camera, pt = this.pt;
		const saved = { pr: r.getPixelRatio(), size: r.getSize( new THREE.Vector2() ) };
		this.exporting = true; this.applyPTOptions();
		const tx = Math.ceil( W / T ), ty = Math.ceil( H / T ), total = tx * ty;
		const transparent = S.stage.bg === 'transparent' || S.render.transparent;
		let done = 0;
		try {

			this.applyLens(); this.scene.updateMatrixWorld( true ); this.vis( 'pt' );
			pt.setScene( this.scene, cam ); this.ptReady = true;
			for ( let j = 0; j < ty; j ++ ) for ( let i = 0; i < tx; i ++ ) {

				const x = i * T, y = j * T, tw = Math.min( T, W - x ), th = Math.min( T, H - y );
				const x0 = x - margin, y0 = y - margin, bw = tw + margin * 2, bh = th + margin * 2;
				r.setPixelRatio( 1 ); r.setSize( bw, bh, false );
				cam.setViewOffset( W, H, x0, y0, bw, bh ); cam.updateProjectionMatrix(); cam.updateMatrixWorld();
				pt.pausePathTracing = false; pt.updateCamera();
				while ( pt.isCompiling ) { onProgress?.( { done, total, tile: 0, status: 'Compiling shaders…' } ); await new Promise( q => setTimeout( q, 60 ) ); if ( shouldCancel?.() ) throw new Error( 'cancelled' ); }
				let n = 0;
				while ( pt.samples < samples ) {

					pt.renderSample(); n ++;
					if ( n % 2 === 0 ) { onProgress?.( { done, total, tile: Math.min( 1, pt.samples / samples ), samples: pt.samples } ); await new Promise( q => setTimeout( q, 0 ) ); }
					if ( shouldCancel?.() ) throw new Error( 'cancelled' );

				}

				this.post.setParams( S.post, { alpha: transparent, sample: 1 } );
				const map = this.post.denoise( pt.target.texture, pt.target.width, pt.target.height, transparent ? 0 : S.render.denoise );
				r.toneMapping = THREE.NoToneMapping; r.setRenderTarget( null ); r.setClearColor( 0, 0 ); r.clear();
				this.post.draw( map, { w: bw, h: bh, full: [ W, H ], origin: [ x0, H - y0 - bh ], grainScale: Math.max( 1, H / 1080 ) }, null );
				ctx.drawImage( this.canvas, margin, margin, tw, th, x, y, tw, th );
				done ++; onProgress?.( { done, total, tile: 0 } );

			}

		} finally {

			cam.clearViewOffset(); r.setPixelRatio( saved.pr ); r.setSize( saved.size.x, saved.size.y, false );
			this.exporting = false; this.vis( this.mode === 'prepare' ? 'raster' : 'bare' ); this.applyLens(); this.ptDirty = { geo: true, mat: true, env: true, cam: true }; this.resize();

		}

		return out;

	}

	thumbnail( w = 160 ) {

		const c = document.createElement( 'canvas' ), a = this.canvas.width / this.canvas.height; c.width = w; c.height = Math.round( w / a );
		c.getContext( '2d' ).drawImage( this.canvas, 0, 0, c.width, c.height ); return c.toDataURL( 'image/jpeg', 0.7 );

	}

	forceRaster() { this.renderRaster(); }

}
