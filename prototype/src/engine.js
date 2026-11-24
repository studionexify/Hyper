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
		this.detectCaps(); this.watchContext();
		this.setupPicking();
		this.buildComposer();
		this.resize();
		new ResizeObserver( () => this.resize() ).observe( container );
		this.loop = this.loop.bind( this ); requestAnimationFrame( this.loop );

	}

	// ---------------------------------------------------------------- GPU capabilities, context loss, diagnostics
	detectCaps() {

		const r = this.renderer, gl = r.getContext(), dbg = gl.getExtension( 'WEBGL_debug_renderer_info' );
		this.caps = {
			gpu: dbg ? gl.getParameter( dbg.UNMASKED_RENDERER_WEBGL ) : 'unknown', maxTex: gl.getParameter( gl.MAX_TEXTURE_SIZE ), maxRB: gl.getParameter( gl.MAX_RENDERBUFFER_SIZE ),
			floatRT: !! gl.getExtension( 'EXT_color_buffer_float' ), floatBlend: !! gl.getExtension( 'EXT_float_blend' ), floatLinear: !! gl.getExtension( 'OES_texture_float_linear' ),
			maxSamples: gl.getParameter( gl.MAX_SAMPLES ), webgl2: r.capabilities.isWebGL2,
		};
		this.diag = { resets: 0, lastTile: 0, retries: 0, errors: 0, lastError: '' };
		this.ptFailed = this.caps.floatRT ? '' : 'This GPU or browser does not expose float render targets, so path tracing is unavailable. The raster renderer is used instead.';
		r.debug.onShaderError = ( g, program, vs, fs ) => { this.diag.lastError = 'shader compile failed'; if ( fs.length > 20000 && ! this.ptFailed ) this.ptFailed = 'The path-tracing shader could not be compiled on this GPU. The raster renderer is used instead.'; };

	}

	watchContext() {

		this.canvas.addEventListener( 'webglcontextlost', e => { e.preventDefault(); this.lost = true; this.diag.resets ++; emit( 'gl-lost' ); } );
		this.canvas.addEventListener( 'webglcontextrestored', () => {

			this.lost = false; this.envKey = ''; this.ptReady = false; this.ptDirty = { geo: true, mat: true, env: true, cam: true };
			try { this.detectCaps(); this.updateEnvironment( true ); this.resize(); } catch ( e ) { console.warn( e ); }
			this.invalidate(); emit( 'gl-restored' );

		} );

	}

	waitForContext( ms = 20000 ) {

		return new Promise( ( res, rej ) => { const t0 = performance.now(); const tick = () => { if ( ! this.lost && ! this.renderer.getContext().isContextLost() ) res(); else if ( performance.now() - t0 > ms ) rej( new Error( 'The graphics context was reset and did not recover' ) ); else setTimeout( tick, 100 ); }; tick(); } );

	}

	diagnostics() {

		const c = this.caps, d = this.diag;
		return [ `GPU: ${c.gpu}`, `WebGL2: ${c.webgl2}  max texture: ${c.maxTex}  max renderbuffer: ${c.maxRB}`, `float render targets: ${c.floatRT}  float blend: ${c.floatBlend}  float linear: ${c.floatLinear}`, `last tile size: ${d.lastTile}  render retries: ${d.retries}  context resets: ${d.resets}`, `profile: ${S.render.profile}  path tracer: ${this.ptFailed ? 'unavailable (' + this.ptFailed + ')' : 'ok'}` ].join( '\n' );

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
		Object.assign( S.render, { profile: key, maxTex: p.maxTex, gpuLoad: p.gpuLoad, preview: p.preview, samples: p.samples, denoise: p.denoise } );
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

	/** Transparent output needs an empty stage: remember the backdrop and restore it when switching back. */
	setTransparent( on, bg = 'match' ) {

		const st = S.stage;
		if ( on ) { if ( st.kit !== 'none' ) { st._prevKit = st.kit; st.kit = 'none'; } st.bg = 'transparent'; S.render.transparent = true; }
		else { S.render.transparent = false; st.bg = bg; if ( st.kit === 'none' && st._prevKit ) { st.kit = st._prevKit; delete st._prevKit; } }
		this.rebuildStage(); R.models.forEach( m => this.dropToFloor( m ) ); this.rebuildStage(); this.updateEnvironment( true );

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
		if ( this.lost ) return;
		try { this.tick(); this.errRun = 0; } catch ( e ) {

			this.diag.errors ++; this.diag.lastError = String( e.message || e ); this.errRun = ( this.errRun || 0 ) + 1;
			if ( this.errRun === 1 ) console.warn( 'Hyper frame error', e );
			if ( this.errRun >= 4 && this.mode === 'render' && ! this.ptFailed ) { this.ptFailed = 'The path tracer stopped after repeated errors (' + this.diag.lastError.slice( 0, 80 ) + '). The raster renderer is used instead.'; emit( 'engine-error', this.ptFailed ); }
			if ( this.errRun >= 4 && this.mode === 'prepare' && R.ao ) { R.ao = false; emit( 'engine-error', 'Ambient occlusion was turned off after a graphics error.' ); }

		}

	}

	tick() {

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
		if ( this.ptFailed ) { if ( this.dirty || this.fpsN % 30 === 0 ) { this.dirty = false; this.renderRasterBare(); } return; }
		if ( now < ( this.showRasterUntil || 0 ) ) { this.renderRasterBare(); this.dirty = false; return; }
		if ( this.ptDirty.geo || this.ptDirty.mat || this.ptDirty.env || this.ptDirty.cam || ! this.ptReady ) { const rebuilt = this.syncPT(); if ( rebuilt ) { this.renderRasterBare(); return; } }
		const pt = this.pt;
		const running = ! this.paused && pt.samples < this.target && ! pt.isCompiling;
		pt.pausePathTracing = ! running;
		const t0 = performance.now();
		pt.renderSample();
		this.displayPT();
		this.governLive( performance.now() - now, running );

	}

	/** Live preview pacing: if frames get slow, split each sample into more tiles; relax again when there is headroom. */
	governLive( ms, running ) {

		if ( ! running ) return;
		this.liveEma = this.liveEma ? this.liveEma * 0.85 + ms * 0.15 : ms;
		const pt = this.pt, n = pt.tiles.x, atBoundary = Math.abs( pt.samples - Math.round( pt.samples ) ) < 1e-6;
		if ( ! atBoundary ) return;
		const base = { low: 4, balanced: 2, max: 1 }[ S.render.gpuLoad ] || 2;
		if ( this.liveEma > 70 && n < 10 ) { pt.tiles.set( n + 1, n + 1 ); this.liveEma = 0; }
		else if ( this.liveEma < 10 && n > base ) { this.calm = ( this.calm || 0 ) + 1; if ( this.calm > 90 ) { pt.tiles.set( n - 1, n - 1 ); this.calm = 0; } } else this.calm = 0;

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

	// ---------------------------------------------------------------- final-quality export
	/** Largest tile edge the GPU can safely allocate (not tied to any memory budget; retries shrink it if the driver refuses). */
	pickTile( W, H ) {

		const m = 16, cap = Math.min( 2048, this.caps.maxTex, this.caps.maxRB );
		if ( S.render.tile ) return S.render.tile;
		if ( W <= cap && H <= cap ) return Math.max( W, H );
		return Math.floor( ( cap - m * 2 ) / 64 ) * 64;

	}

	/**
	 * Render the current scene at tier resolution. Tiles keep GPU use flat; every tile is graded and copied into a
	 * 2D canvas in system RAM. The engine paces the GPU, recovers from context loss, and retries with smaller tiles
	 * and safer settings before giving up. Resolves { canvas, notes, suspect, tile }.
	 */
	async renderFinal( opts ) {

		const long = tierPx[ opts.tier ], a = this.aspectValue || 1;
		const W = a >= 1 ? long : Math.round( long * a ), H = a >= 1 ? Math.round( long / a ) : long;
		const notes = []; let T = this.pickTile( W, H ), safe = false;
		for ( let attempt = 0; ; attempt ++ ) {

			try {

				const res = this.ptFailed ? await this.renderFinalRaster( opts, W, H, T ) : await this.renderFinalOnce( opts, W, H, T, safe );
				if ( res.blank && attempt < 1 && ! this.ptFailed ) { notes.push( 'The first pass came out blank, so it was re-rendered with safer settings.' ); safe = true; T = Math.max( 256, Math.floor( T / 2 / 64 ) * 64 ); this.diag.retries ++; continue; }
				return { canvas: res.canvas, notes, suspect: res.blank, tile: T, W, H, raster: !! this.ptFailed };

			} catch ( e ) {

				if ( e.message === 'cancelled' ) throw e;
				if ( attempt >= 3 ) throw new Error( 'Rendering failed after several attempts: ' + ( e.message || e ) + '. Try a smaller size or fewer samples.' );
				this.diag.retries ++; this.diag.lastError = String( e.message || e );
				notes.push( `Attempt ${attempt + 1} failed (${String( e.message || e ).slice( 0, 70 )}); retrying with smaller tiles.` );
				T = Math.max( 256, Math.floor( T / 2 / 64 ) * 64 ); safe = attempt >= 1;
				try { await this.waitForContext(); } catch ( err ) { throw err; }

			}

		}

	}

	async yieldFrame() { await new Promise( r => { const c = new MessageChannel(); c.port1.onmessage = () => r(); c.port2.postMessage( 0 ); } ); }

	async renderFinalOnce( { samples, onProgress, shouldCancel }, W, H, T, safe ) {

		const single = W <= T && H <= T, m = single ? 0 : 16;
		const bw = single ? W : T + m * 2, bh = single ? H : T + m * 2;
		const out = document.createElement( 'canvas' ); out.width = W; out.height = H;
		const ctx = out.getContext( '2d', { alpha: true } );
		if ( ! ctx ) throw new Error( `This browser cannot allocate a ${W} × ${H} image` );
		const r = this.renderer, gl = r.getContext(), cam = this.camera, pt = this.pt;
		const saved = { pr: r.getPixelRatio(), size: r.getSize( new THREE.Vector2() ), denoise: S.render.denoise };
		const transparent = S.stage.bg === 'transparent' || S.render.transparent;
		const tx = single ? 1 : Math.ceil( W / T ), ty = single ? 1 : Math.ceil( H / T ), total = tx * ty;
		this.exporting = true; this.applyPTOptions(); this.diag.lastTile = single ? Math.max( W, H ) : T;
		if ( safe ) { S.render.denoise = 0; pt.tiles.set( 6, 6 ); }
		let done = 0, ema = 0, lastYield = performance.now();
		try {

			this.applyLens(); this.scene.updateMatrixWorld( true ); this.vis( 'pt' );
			r.setPixelRatio( 1 ); r.setSize( bw, bh, false );
			pt.setScene( this.scene, cam ); this.ptReady = true; pt.pausePathTracing = false;
			for ( let j = 0; j < ty; j ++ ) for ( let i = 0; i < tx; i ++ ) {

				const x = i * T, y = j * T, tw = single ? W : Math.min( T, W - x ), th = single ? H : Math.min( T, H - y );
				cam.setViewOffset( W, H, x - m, y - m, bw, bh ); cam.updateProjectionMatrix(); cam.updateMatrixWorld();
				pt.updateCamera();
				let guard = 0;
				while ( pt.isCompiling ) { onProgress?.( { done, total, tile: 0, status: 'Compiling shaders…' } ); await this.yieldFrame(); await new Promise( q => setTimeout( q, 50 ) ); if ( shouldCancel?.() ) throw new Error( 'cancelled' ); if ( ++ guard > 4000 ) throw new Error( 'shader compile timed out' ); }
				while ( pt.samples < samples ) {

					if ( this.lost || gl.isContextLost() ) throw new Error( 'graphics context lost' );
					const t0 = performance.now(); pt.renderSample(); gl.finish(); const dt = performance.now() - t0;
					ema = ema ? ema * 0.7 + dt * 0.3 : dt;
					const nt = pt.tiles.x;
					if ( Math.abs( pt.samples - Math.round( pt.samples ) ) < 1e-6 ) { if ( ema > 120 && nt < 12 ) { pt.tiles.set( nt + 1, nt + 1 ); ema = 0; } }
					if ( performance.now() - lastYield > 30 ) { onProgress?.( { done, total, tile: Math.min( 1, pt.samples / samples ), samples: pt.samples } ); await this.yieldFrame(); lastYield = performance.now(); if ( shouldCancel?.() ) throw new Error( 'cancelled' ); }

				}

				const err = gl.getError(); if ( err === 0x0505 ) throw new Error( 'the GPU ran out of memory' );
				this.post.setParams( S.post, { alpha: transparent, sample: 1 } );
				const map = this.post.denoise( pt.target.texture, pt.target.width, pt.target.height, transparent ? 0 : S.render.denoise );
				r.toneMapping = THREE.NoToneMapping; r.setRenderTarget( null ); r.setClearColor( 0, 0 ); r.clear();
				this.post.draw( map, { w: bw, h: bh, full: [ W, H ], origin: [ x - m, H - ( y - m ) - bh ], grainScale: Math.max( 1, H / 1080 ) }, null );
				gl.finish();
				ctx.drawImage( this.canvas, m, m, tw, th, x, y, tw, th );
				done ++; onProgress?.( { done, total, tile: 0 } ); await this.yieldFrame();

			}

			return { canvas: out, blank: ! transparent && this.looksBlank( out ) };

		} finally { this.endExport( saved ); }

	}

	/** Fallback when the path tracer cannot run: render with the raster pipeline, tile by tile. */
	async renderFinalRaster( { onProgress, shouldCancel }, W, H, T ) {

		const single = W <= T && H <= T, m = single ? 0 : 16, bw = single ? W : T + m * 2, bh = single ? H : T + m * 2;
		const out = document.createElement( 'canvas' ); out.width = W; out.height = H; const ctx = out.getContext( '2d' );
		if ( ! ctx ) throw new Error( `This browser cannot allocate a ${W} × ${H} image` );
		const r = this.renderer, cam = this.camera, saved = { pr: r.getPixelRatio(), size: r.getSize( new THREE.Vector2() ), denoise: S.render.denoise };
		const tx = single ? 1 : Math.ceil( W / T ), ty = single ? 1 : Math.ceil( H / T ); let done = 0;
		this.exporting = true;
		try {

			this.applyLens(); this.vis( 'bare' ); r.setPixelRatio( 1 ); r.setSize( bw, bh, false ); this.composer.setPixelRatio( 1 ); this.composer.setSize( bw, bh ); this.gtao.enabled = true;
			for ( let j = 0; j < ty; j ++ ) for ( let i = 0; i < tx; i ++ ) {

				const x = i * T, y = j * T, tw = single ? W : Math.min( T, W - x ), th = single ? H : Math.min( T, H - y );
				cam.setViewOffset( W, H, x - m, y - m, bw, bh ); cam.updateProjectionMatrix();
				this.rasterTone(); this.vis( 'raster' ); this.composer.render(); r.getContext().finish();
				ctx.drawImage( this.canvas, m, m, tw, th, x, y, tw, th );
				done ++; onProgress?.( { done, total: tx * ty, tile: 0, status: 'Rendering with the raster engine' } ); if ( shouldCancel?.() ) throw new Error( 'cancelled' ); await this.yieldFrame();

			}

			return { canvas: out, blank: false };

		} finally { this.endExport( saved ); this.composer.setPixelRatio( this.renderer.getPixelRatio() ); }

	}

	endExport( saved ) {

		const r = this.renderer;
		this.camera.clearViewOffset(); S.render.denoise = saved.denoise;
		try { r.setPixelRatio( saved.pr ); r.setSize( saved.size.x, saved.size.y, false ); } catch ( e ) { console.warn( e ); }
		this.exporting = false; this.vis( this.mode === 'prepare' ? 'raster' : 'bare' ); this.applyLens();
		this.ptDirty = { geo: true, mat: true, env: true, cam: true }; this.applyPTOptions(); this.resize();

	}

	/** True when the finished image is one flat near-white or near-black colour (a typical symptom of a GPU numeric failure). */
	looksBlank( cv ) {

		const k = document.createElement( 'canvas' ); k.width = k.height = 48; const g = k.getContext( '2d' ); g.drawImage( cv, 0, 0, 48, 48 );
		const d = g.getImageData( 0, 0, 48, 48 ).data; let sum = 0, sq = 0, n = 0;
		for ( let i = 0; i < d.length; i += 4 ) { const l = ( d[ i ] + d[ i + 1 ] + d[ i + 2 ] ) / 3; sum += l; sq += l * l; n ++; }
		const mean = sum / n, varc = sq / n - mean * mean;
		return varc < 0.6 && ( mean > 251 || mean < 3 );

	}

	thumbnail( w = 160 ) {

		const c = document.createElement( 'canvas' ), a = this.canvas.width / this.canvas.height; c.width = w; c.height = Math.round( w / a );
		c.getContext( '2d' ).drawImage( this.canvas, 0, 0, c.width, c.height ); return c.toDataURL( 'image/jpeg', 0.7 );

	}

	forceRaster() { this.renderRaster(); }

}
