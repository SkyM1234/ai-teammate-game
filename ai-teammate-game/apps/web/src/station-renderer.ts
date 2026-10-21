import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { PlayerView, Position } from '../../../packages/game-core/src/types.ts';

import { ArtResources } from './art/resources.ts';
import { createRobot, createHuman } from './art/characters.ts';
import { createProp } from './art/props.ts';
import { createTerrain } from './art/terrain.ts';
import { wallHeightAt } from './art/dimensions.ts';
import { buildReticle, createExitLeak } from './art/effects.ts';
import { colors, levelTheme } from './art/themes.ts';
import type { StationTheme } from './art/themes.ts';

const equal = (a: Position, b: Position) => a.x === b.x && a.y === b.y;
export interface RouteOverlay { path: Position[]; color: string; label: string }

/** A view of player knowledge. Never loads the authoritative level entities. */
export class StationRenderer {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-10, 10, 10, -10, .1, 100);
  private readonly controls: OrbitControls;
  private readonly terrain = new THREE.Group();
  private readonly objects = new THREE.Group();
  private readonly robot: THREE.Group;
  private readonly human: THREE.Group;
  private readonly selection = new THREE.Group();
  private readonly hover = new THREE.Group();
  private readonly routes = new THREE.Group();
  private routeOverlays: RouteOverlay[] = [];
  private routeSignature = '';
  private readonly routeGeometry = new THREE.BoxGeometry(1, 1, 1);
  private readonly routeMaterials = new Map<string, THREE.MeshBasicMaterial>();
  private readonly exitLeak: THREE.Group;
  private readonly exitGas: THREE.Sprite[];
  private readonly art: ArtResources;
  private theme: StationTheme;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -.04);
  private readonly observer: ResizeObserver;
  private readonly reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  private floor: THREE.InstancedMesh | null = null;
  private walls: THREE.InstancedMesh | null = null;
  private wallCells: Position[] = [];
  private roomLabels: THREE.Sprite[] = [];
  private state: PlayerView | null = null;
  private signature = '';
  private levelKey = '';
  private readonly gestures = new Map<number, { x: number; y: number }>();
  private suppressSelection = false;
  private animation = 0;
  private leakAnimation = 0;
  private width = 12;
  private height = 12;
  private disposed = false;

  constructor(private readonly canvas: HTMLCanvasElement, private readonly themeOverride?: StationTheme) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'low-power' });
    this.art = new ArtResources(this.renderer.capabilities.getMaxAnisotropy());
    this.theme = themeOverride ?? levelTheme('station-01');
    this.robot = createRobot(this.art); this.human = createHuman(this.art);
    const leak = createExitLeak(this.art); this.exitLeak = leak.group; this.exitGas = leak.sprites;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.scene.add(this.terrain, this.objects, this.robot, this.human, this.selection, this.hover, this.exitLeak, this.routes);
    this.scene.add(new THREE.HemisphereLight(0xe8eee9, 0x25332c, 1.6));
    const light = new THREE.DirectionalLight(0xf5f1e7, 2.8);
    light.position.set(-8, 18, 6);
    light.castShadow = true;
    light.shadow.mapSize.set(2048, 2048);
    light.shadow.radius = 3;
    light.shadow.intensity = .8;
    Object.assign(light.shadow.camera, { left: -10, right: 10, top: 10, bottom: -10, near: .5, far: 50 });
    light.shadow.bias = -.001;
    light.shadow.normalBias = .04;
    this.scene.add(light);
    const fill = new THREE.DirectionalLight(0xc7ddd5, .8);
    fill.position.set(8, 6, -10);
    this.scene.add(fill);
    this.camera.position.set(Math.SQRT1_2 * 18, 23.45, Math.SQRT1_2 * 18);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.set(0, .45, 0);
    this.controls.enableDamping = false;
    this.controls.rotateSpeed = .7;
    this.controls.zoomSpeed = .8;
    this.controls.panSpeed = .8;
    this.controls.screenSpacePanning = false;
    this.controls.minPolarAngle = Math.PI / 18;
    this.controls.maxPolarAngle = Math.PI * 5 / 12;
    this.controls.minZoom = .65;
    this.controls.maxZoom = 3;
    this.controls.maxTargetRadius = 8;
    this.controls.update();
    this.controls.addEventListener('change', this.onCameraChange);
    buildReticle(this.art, this.selection, colors.signal, .94);
    buildReticle(this.art, this.hover, colors.ivory, .9);
    for (const group of [this.selection, this.hover]) this.art.batchMeshes(group);
    this.selection.visible = false;
    this.hover.visible = false;
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(canvas.parentElement!);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointercancel', this.onPointerCancel);
    canvas.addEventListener('lostpointercapture', this.onLostPointerCapture);
    canvas.addEventListener('pointerleave', this.onPointerLeave);
    canvas.addEventListener('contextmenu', this.onContextMenu);
    canvas.addEventListener('webglcontextlost', this.onContextLost);
    canvas.addEventListener('webglcontextrestored', this.onContextRestored);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    document.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('blur', this.cancelGesture);
    this.resize();
  }

  private world(position: Position) {
    return new THREE.Vector3(position.x - (this.width - 1) / 2, 0, position.y - (this.height - 1) / 2);
  }

  update(p: PlayerView, selected: Position | null, routes: RouteOverlay[] = []) {
    this.exitLeak.visible = p.exitStatus === 'leaking';
    this.canvas.dataset.exitStatus = p.exitStatus;
    if (!this.exitLeak.visible) { cancelAnimationFrame(this.leakAnimation); this.leakAnimation = 0; }
    const levelKey = JSON.stringify([p.level.id, p.level.width, p.level.height, p.level.tiles, p.level.rooms, p.level.exit]);
    const changedLevel = levelKey !== this.levelKey;
    if (changedLevel) {
      this.art.clear(this.terrain);
      this.theme = this.themeOverride ?? levelTheme(p.level.id);
      const terrain = createTerrain(this.art, p.level, this.theme);
      this.terrain.add(terrain.group); this.floor = terrain.floor; this.walls = terrain.walls;
      this.wallCells = terrain.wallCells; this.roomLabels = terrain.roomLabels;
      this.width = p.level.width; this.height = p.level.height;
      this.fitCamera(); this.levelKey = levelKey; this.signature = '';
    }
    this.exitLeak.position.copy(this.world(p.level.exit));
    const sensed = new Set(p.sensorCells.map(cell => `${cell.x},${cell.y}`));
    const signature = JSON.stringify([p.observed, p.radar, p.markers, p.sensorCells, p.robot.position]);
    if (signature !== this.signature) {
      this.art.clear(this.objects);
      for (let y = 0; y < this.height; y++) for (let x = 0; x < this.width; x++) {
        const near = sensed.has(`${x},${y}`);
        const radar = Math.abs(x - p.robot.position.x) + Math.abs(y - p.robot.position.y) <= p.rules.radarRadius;
        const wall = p.level.tiles[y][x] === '#';
        const color = new THREE.Color(wall ? this.theme.floorWall : near ? this.theme.floorNear : radar ? this.theme.floorRadar : this.theme.floorUnknown);
        if ((Math.floor((x - 1) / 2) + Math.floor((y - 1) / 2)) % 2) color.multiplyScalar(.96);
        this.floor!.setColorAt(y * this.width + x, color);
      }
      this.floor!.instanceColor!.needsUpdate = true;
      // Outline the actual sensor footprint. Decorations never imply unseen objects.
      for (const cell of p.sensorCells) {
        if (p.level.tiles[cell.y]?.[cell.x] !== '.') continue;
        const group = new THREE.Group(); group.position.copy(this.world(cell));
        for (const [dx, dz] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
          if (sensed.has(`${cell.x + dx},${cell.y + dz}`) && p.level.tiles[cell.y + dz]?.[cell.x + dx] === '.') continue;
          this.art.glow(group, dx ? [.025, .012, .87] : [.87, .012, .025], [dx * .445, .02, dz * .445], 0x929d49);
        }
        this.objects.add(group);
      }
      const observed = p.observed.filter(entity => !['cleared', 'inventory'].includes(entity.state));
      for (const entity of observed) {
        const group = createProp(this.art, entity, sensed.has(`${entity.position.x},${entity.position.y}`), wallHeightAt(p.level, entity.position));
        const contact = this.art.decal(group, 'contact', entity.type === 'door' ? [1.06, 1.02] : [.88, .7], [0, .008, 0]);
        contact.rotation.x = -Math.PI / 2;
        group.position.copy(this.world(entity.position)); this.objects.add(group);
      }
      for (const echo of p.radar) {
        if (observed.some(entity => equal(entity.position, echo.position))) continue;
        const group = new THREE.Group(); group.position.copy(this.world(echo.position));
        group.name = `echo:${echo.id}`;
        const color = echo.historical ? 0x6f7652 : colors.signal;
        buildReticle(this.art, group, color, echo.strength === 'strong' ? .54 : .38);
        this.art.label(group, echo.shape === 'flickering' ? '? !' : '?', echo.historical ? '#8e9875' : '#e2e8a0', .55, .36);
        this.objects.add(group);
      }
      for (const marker of p.markers) {
        const group = new THREE.Group(); group.position.copy(this.world(marker.position));
        const color = marker.shared ? colors.marker : 0x798765;
        this.art.box(group, [.04, .6, .04], [-.34, .31, -.34], color);
        this.art.glow(group, [.24, .16, .025], [-.23, .56, -.34], color);
        this.objects.add(group);
      }
      this.art.batchMeshes(this.objects);
      this.signature = signature;
    }
    const routeSignature = JSON.stringify([levelKey, routes]);
    this.routeOverlays = routes;
    if (routeSignature !== this.routeSignature) {
      this.art.clear(this.routes);
      for (const route of routes) {
        let material = this.routeMaterials.get(route.color);
        if (!material) {
          material = new THREE.MeshBasicMaterial({ color: new THREE.Color(route.color).multiplyScalar(.75), toneMapped: false });
          this.routeMaterials.set(route.color, material);
        }
        for (let i = 1; i < route.path.length; i++) {
          const from = this.world(route.path[i - 1]), to = this.world(route.path[i]);
          const length = from.distanceTo(to), dashes = Math.ceil(length * 3);
          for (let dash = 0; dash < dashes; dash++) {
            const segment = new THREE.Mesh(this.routeGeometry, material);
            segment.position.copy(from).lerp(to, (dash + .5) / dashes); segment.position.y = .12;
            segment.scale.set(.075, .025, length / dashes * .65);
            segment.rotation.y = Math.atan2(to.x - from.x, to.z - from.z);
            this.routes.add(segment);
          }
          if (i !== route.path.length - 1) continue;
          const direction = to.clone().sub(from).normalize();
          const sideways = new THREE.Vector3(direction.z, 0, -direction.x);
          const tip = to;
          for (const side of [-1, 1]) {
            const wing = new THREE.Mesh(this.routeGeometry, material);
            wing.position.copy(tip).addScaledVector(direction, -.09).addScaledVector(sideways, side * .09); wing.position.y = .12;
            wing.scale.set(.05, .025, Math.SQRT2 * .18);
            wing.rotation.y = Math.atan2(direction.x, direction.z) - side * Math.PI / 4;
            this.routes.add(wing);
          }
        }
        const point = route.path[1];
        if (point) {
          const label = new THREE.Group(); label.position.copy(this.world(point));
          const sprite = this.art.label(label, route.label, route.color, .65, .45);
          sprite.material.depthTest = true;
          sprite.material.depthWrite = false;
          this.routes.add(label);
        }
      }
      this.routeSignature = routeSignature;
    }
    this.selection.visible = !!selected;
    if (selected) this.selection.position.copy(this.world(selected));
    const targetRobot = this.world(p.robot.position);
    const targetHuman = this.world(p.human.position);
    if (p.human.carried) { targetHuman.y = .68; targetHuman.x -= .16; targetHuman.z -= .15; }
    const animate = !changedLevel && !!this.state && p.elapsedTU > this.state.elapsedTU && p.elapsedTU - this.state.elapsedTU <= 2 && !this.reducedMotion.matches && !document.hidden;
    const robotFrom = this.robot.position.clone();
    const humanFrom = this.human.position.clone();
    if (this.state && !equal(p.robot.position, this.state.robot.position)) this.robot.rotation.y = Math.atan2(targetRobot.x - robotFrom.x, targetRobot.z - robotFrom.z);
    this.state = p;
    cancelAnimationFrame(this.animation);
    if (animate) {
      const started = performance.now();
      const frame = (time: number) => {
        const t = Math.min((time - started) / 180, 1);
        const eased = t * t * (3 - 2 * t);
        this.robot.position.lerpVectors(robotFrom, targetRobot, eased);
        this.human.position.lerpVectors(humanFrom, targetHuman, eased);
        this.draw();
        if (t < 1 && !this.disposed) this.animation = requestAnimationFrame(frame);
      };
      this.animation = requestAnimationFrame(frame);
    } else { this.robot.position.copy(targetRobot); this.human.position.copy(targetHuman); this.draw(); }
    this.canvas.dataset.renderMode = '3d';
    this.canvas.dataset.drawCalls = String(this.renderer.info.render.calls);
  }

  private fitCamera() {
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    this.camera.updateMatrixWorld(true);
    const bounds = new THREE.Box3(new THREE.Vector3(-this.width / 2 - .8, -.7, -this.height / 2 - .8), new THREE.Vector3(this.width / 2 + .8, 1.6, this.height / 2 + .8));
    const cameraBounds = new THREE.Box3();
    for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) cameraBounds.expandByPoint(new THREE.Vector3(x, y, z).applyMatrix4(this.camera.matrixWorldInverse));
    const aspect = rect.width / rect.height;
    const size = cameraBounds.getSize(new THREE.Vector3());
    const height = Math.max(size.y, size.x / aspect) * 1.04;
    this.camera.left = -height * aspect / 2; this.camera.right = height * aspect / 2;
    this.camera.top = height / 2; this.camera.bottom = -height / 2;
    this.camera.updateProjectionMatrix();
  }

  rotate() {
    const offset = this.camera.position.clone().sub(this.controls.target);
    offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
    this.camera.position.copy(this.controls.target).add(offset);
    this.controls.update();
  }
  zoomBy(amount: number) {
    this.camera.zoom = THREE.MathUtils.clamp(this.camera.zoom + amount, this.controls.minZoom, this.controls.maxZoom);
    this.camera.updateProjectionMatrix(); this.controls.update();
    // OrbitControls does not emit change for an externally assigned zoom.
    this.draw();
  }
  reset() {
    this.controls.target.set(0, .45, 0);
    this.camera.position.set(Math.SQRT1_2 * 18, 23.45, Math.SQRT1_2 * 18);
    this.camera.zoom = 1;
    this.camera.updateProjectionMatrix(); this.controls.update(); this.fitCamera(); this.draw();
  }

  selectionClickAllowed(event: MouseEvent) { return event.detail === 0 || !this.suppressSelection; }

  private onCameraChange = () => { this.hover.visible = false; this.fitCamera(); this.draw(); };
  private onPointerDown = (event: PointerEvent) => {
    if (!this.gestures.size) this.suppressSelection = event.button !== 0;
    this.gestures.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (this.gestures.size > 1) this.suppressSelection = true;
  };
  private trackGesture(event: PointerEvent) {
    const start = this.gestures.get(event.pointerId);
    if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5) this.suppressSelection = true;
  }
  private onPointerUp = (event: PointerEvent) => {
    this.trackGesture(event); this.gestures.delete(event.pointerId);
    if (!this.gestures.size) delete this.canvas.dataset.dragging;
  };
  private cancelGesture = () => {
    if (!this.gestures.size) return;
    const pointers = [...this.gestures.keys()];
    this.gestures.clear(); this.suppressSelection = true; delete this.canvas.dataset.dragging;
    this.controls.disconnect(); this.controls.connect(this.canvas);
    for (const pointer of pointers) if (this.canvas.hasPointerCapture(pointer)) this.canvas.releasePointerCapture(pointer);
    this.hover.visible = false; this.draw();
  };
  private onPointerCancel = () => this.cancelGesture();
  private onLostPointerCapture = (event: PointerEvent) => { if (this.gestures.has(event.pointerId)) this.cancelGesture(); };
  private onContextMenu = (event: Event) => event.preventDefault();

  pick(clientX: number, clientY: number): Position | null {
    if (!this.state) return null;
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    this.pointer.set((clientX - rect.left) / rect.width * 2 - 1, -(clientY - rect.top) / rect.height * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    // Pick wall tops before the ground plane, so walls select their own grid cell.
    const wall = this.walls && this.raycaster.intersectObject(this.walls)[0];
    if (wall && wall.instanceId !== undefined) return this.wallCells[wall.instanceId];
    const point = this.raycaster.ray.intersectPlane(this.plane, new THREE.Vector3());
    if (!point) return null;
    const x = Math.floor(point.x + this.width / 2), y = Math.floor(point.z + this.height / 2);
    return x >= 0 && y >= 0 && x < this.width && y < this.height ? { x, y } : null;
  }

  private onPointerMove = (event: PointerEvent) => {
    if (this.gestures.has(event.pointerId)) {
      this.trackGesture(event);
      if (this.suppressSelection) this.canvas.dataset.dragging = 'true';
      return;
    }
    if (event.pointerType === 'touch') return;
    const cell = this.pick(event.clientX, event.clientY);
    if (this.hover.visible === !!cell && (!cell || this.hover.position.equals(this.world(cell)))) return;
    this.hover.visible = !!cell;
    if (cell) this.hover.position.copy(this.world(cell));
    this.draw();
  };
  private onPointerLeave = () => { if (this.hover.visible) { this.hover.visible = false; this.draw(); } };
  private onContextLost = (event: Event) => {
    event.preventDefault(); cancelAnimationFrame(this.animation);
    cancelAnimationFrame(this.leakAnimation); this.leakAnimation = 0;
    this.canvas.dataset.renderMode = 'recovering';
    document.getElementById('map-render-status')!.textContent = '画面暂时中断，正在恢复…';
  };
  private onContextRestored = () => { this.canvas.dataset.renderMode = '3d'; document.getElementById('map-render-status')!.textContent = '点击选格 · 拖动观察 · 滚轮缩放'; this.resize(); };
  private onVisibilityChange = () => {
    if (document.hidden) { cancelAnimationFrame(this.animation); cancelAnimationFrame(this.leakAnimation); this.leakAnimation = 0; this.cancelGesture(); }
    else if (this.state) { this.robot.position.copy(this.world(this.state.robot.position)); this.signature = ''; this.update(this.state, this.selection.visible ? { x: Math.round(this.selection.position.x + (this.width - 1) / 2), y: Math.round(this.selection.position.z + (this.height - 1) / 2) } : null, this.routeOverlays); }
  };

  private resize() {
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height || this.disposed) return;
    // Match the display while bounding GPU cost on high-density screens.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(Math.max(1, Math.round(rect.width)), Math.max(1, Math.round(rect.height)), false);
    this.fitCamera(); this.draw();
  }

  private draw() {
    if (this.disposed || document.hidden || this.canvas.dataset.renderMode === 'recovering') return;
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.height) return;
    const labelHeight = (this.camera.top - this.camera.bottom) / this.camera.zoom / rect.height * 14;
    for (const label of this.roomLabels) {
      const texture = label.material.map as THREE.CanvasTexture;
      label.scale.set(labelHeight * texture.image.width / texture.image.height, labelHeight, 1);
    }
    if (this.exitLeak.visible) {
      const time = this.reducedMotion.matches ? 0 : performance.now() / 1050;
      this.exitGas.forEach((sprite, i) => {
        const phase = (time + (i % 6) / 6 + Math.floor(i / 6) * .13) % 1;
        const stream = Math.floor(i / 6) - 1;
        sprite.position.set(stream * (.18 + phase * .12) + Math.sin(phase * 7 + i) * phase * .08, .12 + phase * 1.7, -.25 + phase * .65);
        sprite.scale.setScalar(.24 + phase * .85);
        sprite.material.opacity = (1 - phase) * .9;
      });
      if (!this.reducedMotion.matches && !this.leakAnimation) this.leakAnimation = requestAnimationFrame(() => { this.leakAnimation = 0; this.draw(); });
    }
    this.renderer.render(this.scene, this.camera);
    this.canvas.dataset.drawCalls = String(this.renderer.info.render.calls);
  }

  dispose() {
    this.disposed = true; cancelAnimationFrame(this.animation); cancelAnimationFrame(this.leakAnimation); this.observer.disconnect();
    this.controls.removeEventListener('change', this.onCameraChange); this.controls.dispose();
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointercancel', this.onPointerCancel);
    this.canvas.removeEventListener('lostpointercapture', this.onLostPointerCapture);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerleave', this.onPointerLeave);
    this.canvas.removeEventListener('contextmenu', this.onContextMenu);
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    document.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('blur', this.cancelGesture);
    for (const group of [this.terrain, this.objects, this.robot, this.human, this.selection, this.hover, this.exitLeak, this.routes]) this.art.clear(group);
    this.routeGeometry.dispose(); this.routeMaterials.forEach(material => material.dispose());
    this.art.dispose();
    this.scene.traverse(object => { if (object instanceof THREE.DirectionalLight) object.shadow.dispose(); });
    this.renderer.dispose();
  }
}
