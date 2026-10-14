import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { ObservedEntity, PlayerView, Position } from '../../../packages/game-core/src/types.ts';

const colors = { steel: 0x68715e, dark: 0x1c241c, ivory: 0xcbd0b5, signal: 0xdce52b, amber: 0xd3ae79, red: 0xed8165, marker: 0xd4e0c3 };
const equal = (a: Position, b: Position) => a.x === b.x && a.y === b.y;

/** A view of player knowledge. Never loads the authoritative level entities. */
export class StationRenderer {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-10, 10, 10, -10, .1, 100);
  private readonly controls: OrbitControls;
  private readonly terrain = new THREE.Group();
  private readonly objects = new THREE.Group();
  private readonly robot = new THREE.Group();
  private readonly human = new THREE.Group();
  private readonly selection = new THREE.Group();
  private readonly hover = new THREE.Group();
  private readonly cube = new THREE.BoxGeometry(1, 1, 1);
  private readonly cylinder = new THREE.CylinderGeometry(.5, .5, 1, 8);
  private readonly materials = new Map<number, THREE.MeshStandardMaterial>();
  private readonly surfaces = new Map<string, THREE.MeshStandardMaterial>();
  private readonly textures = new Map<string, THREE.CanvasTexture>();
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -.04);
  private readonly observer: ResizeObserver;
  private readonly reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  private floor: THREE.InstancedMesh | null = null;
  private walls: THREE.InstancedMesh | null = null;
  private wallCells: Position[] = [];
  private state: PlayerView | null = null;
  private signature = '';
  private levelKey = '';
  private readonly gestures = new Map<number, { x: number; y: number }>();
  private suppressSelection = false;
  private animation = 0;
  private width = 12;
  private height = 12;
  private disposed = false;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true, powerPreference: 'low-power' });
    this.renderer.setPixelRatio(1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.BasicShadowMap;
    this.scene.add(this.terrain, this.objects, this.robot, this.human, this.selection, this.hover);
    this.scene.add(new THREE.HemisphereLight(0xe3e8c9, 0x252e20, 1.8));
    const light = new THREE.DirectionalLight(0xf5edce, 2.8);
    light.position.set(-8, 18, 6);
    light.castShadow = true;
    light.shadow.mapSize.set(1024, 1024);
    Object.assign(light.shadow.camera, { left: -10, right: 10, top: 10, bottom: -10, near: .5, far: 50 });
    light.shadow.bias = -.001;
    light.shadow.normalBias = .04;
    this.scene.add(light);
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
    this.buildRobot();
    this.buildHuman();
    this.buildReticle(this.selection, colors.signal, .94);
    this.buildReticle(this.hover, colors.ivory, .9);
    for (const group of [this.robot, this.human, this.selection, this.hover]) this.batchMeshes(group);
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

  private material(color: number) {
    let material = this.materials.get(color);
    if (!material) {
      material = new THREE.MeshStandardMaterial({ color, roughness: .88, metalness: .16, flatShading: true });
      this.materials.set(color, material);
    }
    return material;
  }

  private box(group: THREE.Group, size: [number, number, number], position: [number, number, number], color: number) {
    const mesh = new THREE.Mesh(this.cube, this.material(color));
    mesh.scale.set(...size);
    mesh.position.set(...position);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  }

  private tank(group: THREE.Group, size: [number, number, number], position: [number, number, number], color: number) {
    const mesh = new THREE.Mesh(this.cylinder, this.material(color));
    mesh.scale.set(...size); mesh.position.set(...position);
    mesh.castShadow = true; mesh.receiveShadow = true;
    group.add(mesh); return mesh;
  }

  /** Batch shared primitives in local space; moving a character still moves every part. */
  private batchMeshes(group: THREE.Group) {
    const batches = new Map<string, { source: THREE.Mesh; matrices: THREE.Matrix4[] }>();
    const meshes: THREE.Mesh[] = [];
    group.updateWorldMatrix(true, true);
    const inverse = group.matrixWorld.clone().invert();
    group.traverse(object => {
      if (!(object instanceof THREE.Mesh) || object instanceof THREE.InstancedMesh || Array.isArray(object.material)) return;
      if (object.geometry !== this.cube && object.geometry !== this.cylinder) return;
      const key = `${object.geometry.uuid}:${object.material.uuid}:${object.castShadow}:${object.receiveShadow}`;
      let batch = batches.get(key);
      if (!batch) { batch = { source: object, matrices: [] }; batches.set(key, batch); }
      batch.matrices.push(inverse.clone().multiply(object.matrixWorld)); meshes.push(object);
    });
    for (const mesh of meshes) mesh.removeFromParent();
    for (const { source, matrices } of batches.values()) {
      const mesh = new THREE.InstancedMesh(source.geometry, source.material, matrices.length);
      matrices.forEach((matrix, i) => mesh.setMatrixAt(i, matrix));
      mesh.castShadow = source.castShadow; mesh.receiveShadow = source.receiveShadow;
      mesh.computeBoundingSphere(); group.add(mesh);
    }
  }

  private surface(kind: 'deck' | 'vent', color: number) {
    const key = `${kind}:${color}`;
    let material = this.surfaces.get(key);
    if (material) return material;
    let texture = this.textures.get(kind);
    if (!texture) {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
      const context = canvas.getContext('2d')!;
      context.fillStyle = '#d9ddcf'; context.fillRect(0, 0, 64, 64);
      // Deterministic wear, without external assets or hidden world data.
      for (let i = 0; i < 64; i++) {
        context.fillStyle = i % 3 ? '#c8cdbd' : '#e4e6da';
        context.fillRect((i * 17 + 13) % 60 + 2, (i * 23 + 7) % 60 + 2, 2, 1);
      }
      context.strokeStyle = '#8a927a'; context.lineWidth = 2; context.strokeRect(3, 3, 58, 58);
      context.strokeStyle = '#eef0de'; context.lineWidth = 1; context.strokeRect(6.5, 6.5, 51, 51);
      context.fillStyle = '#7a836b';
      for (const x of [9, 53]) for (const y of [9, 53]) context.fillRect(x, y, 3, 3);
      if (kind === 'vent') {
        context.fillStyle = '#65705c';
        for (let y = 20; y <= 44; y += 6) context.fillRect(17, y, 30, 3);
      } else {
        context.fillStyle = '#bec5ae'; context.fillRect(16, 15, 32, 2); context.fillRect(16, 47, 32, 2);
        context.fillStyle = '#8d957b'; context.fillRect(13, 40, 10, 2); context.fillRect(13, 44, 6, 2);
      }
      texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
      // Filter distant plate details to prevent shimmer; magnified texels stay crisp.
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.magFilter = THREE.NearestFilter; texture.generateMipmaps = true;
      this.textures.set(kind, texture);
    }
    material = new THREE.MeshStandardMaterial({ color, map: texture, roughness: .94, metalness: .12 });
    this.surfaces.set(key, material); return material;
  }

  private glow(group: THREE.Group, size: [number, number, number], position: [number, number, number], color: number) {
    const mesh = this.box(group, size, position, color);
    // Small luminous inserts, rather than full-screen bloom, preserve pixel edges.
    const key = color + 0x1000000;
    let material = this.materials.get(key);
    if (!material) {
      material = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: .55, roughness: 1 });
      this.materials.set(key, material);
    }
    mesh.material = material;
    mesh.castShadow = false;
    return mesh;
  }

  private label(group: THREE.Group, text: string, color: string, y: number, scale = .7) {
    const key = `${text}:${color}`;
    let texture = this.textures.get(key);
    if (!texture) {
      const canvas = document.createElement('canvas');
      canvas.height = 32;
      const context = canvas.getContext('2d')!;
      context.font = 'bold 22px monospace';
      canvas.width = Math.ceil(context.measureText(text).width) + 16;
      context.fillStyle = '#161e15e8'; context.fillRect(0, 0, canvas.width, 32);
      context.fillStyle = color; context.font = 'bold 22px monospace';
      context.textAlign = 'center'; context.textBaseline = 'middle';
      context.fillText(text, canvas.width / 2, 17);
      texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.minFilter = THREE.NearestFilter; texture.magFilter = THREE.NearestFilter;
      texture.generateMipmaps = false;
      this.textures.set(key, texture);
    }
    const material = new THREE.SpriteMaterial({ map: texture, depthTest: false });
    const sprite = new THREE.Sprite(material);
    sprite.position.y = y;
    sprite.scale.set(scale * .65 * texture.image.width / 32, scale * .65, 1);
    sprite.renderOrder = 5;
    group.add(sprite);
  }

  private world(position: Position) {
    return new THREE.Vector3(position.x - (this.width - 1) / 2, 0, position.y - (this.height - 1) / 2);
  }

  private buildRobot() {
    for (const x of [-.22, .22]) {
      this.box(this.robot, [.23, .2, .4], [x, .14, 0], colors.dark);
      this.box(this.robot, [.17, .045, .3], [x, .26, 0], colors.steel);
      this.box(this.robot, [.12, .13, .13], [x, .31, 0], colors.dark);
      this.box(this.robot, [.1, .34, .15], [x * 1.6, .5, 0], colors.ivory);
      this.box(this.robot, [.12, .09, .18], [x * 1.6, .35, .06], colors.dark);
    }
    this.box(this.robot, [.56, .4, .38], [0, .51, 0], colors.ivory);
    this.box(this.robot, [.36, .23, .035], [0, .52, .212], colors.dark);
    this.glow(this.robot, [.22, .045, .045], [0, .56, .23], colors.signal);
    this.box(this.robot, [.28, .29, .16], [0, .53, -.27], colors.steel);
    this.box(this.robot, [.46, .3, .39], [0, .87, .015], colors.ivory);
    this.box(this.robot, [.39, .15, .035], [0, .88, .224], colors.dark);
    for (const x of [-.11, .11]) this.glow(this.robot, [.09, .055, .04], [x, .9, .249], colors.signal);
    this.box(this.robot, [.38, .025, .3], [0, 1.04, .015], colors.steel);
    this.box(this.robot, [.035, .19, .035], [.16, 1.13, -.04], colors.steel);
    this.glow(this.robot, [.075, .05, .075], [.16, 1.25, -.04], colors.signal);
    this.label(this.robot, 'R-07', '#e5ed78', 1.52, .62);
  }

  private buildHuman() {
    this.box(this.human, [.61, .08, .91], [0, .08, .01], colors.dark);
    this.box(this.human, [.45, .075, .77], [0, .15, .01], 0x5f6953);
    this.box(this.human, [.38, .2, .4], [0, .28, .05], colors.steel);
    this.box(this.human, [.4, .035, .095], [0, .4, -.05], colors.amber);
    this.box(this.human, [.29, .24, .28], [0, .3, -.3], colors.ivory);
    this.box(this.human, [.21, .1, .04], [0, .34, -.456], colors.dark);
    this.glow(this.human, [.08, .035, .03], [.07, .42, -.44], colors.amber);
    for (const x of [-.14, .14]) {
      this.box(this.human, [.13, .12, .25], [x, .23, .4], colors.dark);
      this.box(this.human, [.1, .12, .34], [x * 1.9, .23, .05], colors.steel);
    }
    this.label(this.human, 'YOU', '#e5c294', .85, .55);
  }

  private buildReticle(group: THREE.Group, color: number, size: number) {
    for (const x of [-1, 1]) for (const z of [-1, 1]) {
      this.glow(group, [.25, .025, .045], [x * (size / 2 - .1), .075, z * size / 2], color);
      this.glow(group, [.045, .025, .25], [x * size / 2, .075, z * (size / 2 - .1)], color);
    }
  }

  private clear(group: THREE.Group) {
    group.traverse(object => {
      if (object instanceof THREE.Sprite) object.material.dispose();
      if (object instanceof THREE.InstancedMesh) object.dispose();
    });
    group.clear();
  }

  private buildTerrain(p: PlayerView) {
    this.clear(this.terrain);
    this.width = p.level.width; this.height = p.level.height;
    const count = this.width * this.height;
    this.floor = new THREE.InstancedMesh(this.cube, this.surface('deck', 0xffffff), count);
    this.floor.receiveShadow = true;
    this.terrain.add(this.floor);
    this.wallCells = [];
    for (let y = 0; y < this.height; y++) for (let x = 0; x < this.width; x++) {
      if (p.level.tiles[y][x] === '#') this.wallCells.push({ x, y });
    }
    this.walls = new THREE.InstancedMesh(this.cube, this.material(0xffffff), this.wallCells.length);
    this.walls.castShadow = true; this.walls.receiveShadow = true;
    this.terrain.add(this.walls);
    const transform = new THREE.Object3D();
    for (let y = 0; y < this.height; y++) for (let x = 0; x < this.width; x++) {
      transform.position.copy(this.world({ x, y })); transform.position.y = -.075;
      transform.scale.set(.96, .15, .96); transform.updateMatrix();
      this.floor.setMatrixAt(y * this.width + x, transform.matrix);
    }
    this.wallCells.forEach((cell, i) => {
      const boundary = cell.x === 0 || cell.y === 0 || cell.x === this.width - 1 || cell.y === this.height - 1;
      const height = boundary ? .34 : .55;
      transform.position.copy(this.world(cell)); transform.position.y = height / 2;
      transform.scale.set(.98, height, .98); transform.updateMatrix();
      this.walls!.setMatrixAt(i, transform.matrix);
      this.walls!.setColorAt(i, new THREE.Color(boundary ? 0x303a2b : 0x414a36));
      // Riveted metal wall caps are map geometry, not hidden gameplay objects.
      const cap = new THREE.Group(); cap.position.copy(this.world(cell));
      const lid = this.box(cap, [.86, .035, .86], [0, height + .012, 0], colors.ivory);
      lid.material = this.surface('vent', boundary ? 0x788067 : 0x9da38a);
      if ((cell.x * 3 + cell.y) % 7 === 0) {
        this.box(cap, [.65, .015, .075], [0, height + .035, .32], 0xa3ab44);
        for (const x of [-.23, 0, .23]) this.box(cap, [.075, .016, .075], [x, height + .04, .32], colors.dark);
      }
      for (const x of [-.38, .38]) this.box(cap, [.08, height * .8, .09], [x, height / 2, .47], 0x5b6550);
      this.terrain.add(cap);
    });
    this.box(this.terrain, [this.width + .38, .37, this.height + .38], [0, -.35, 0], colors.dark);
    this.box(this.terrain, [this.width + .52, .075, this.height + .52], [0, -.58, 0], 0x60684a);
    for (const sign of [-1, 1]) {
      this.box(this.terrain, [this.width + .3, .08, .065], [0, -.22, sign * (this.height / 2 + .17)], 0x7e8764);
      this.box(this.terrain, [.065, .08, this.height + .3], [sign * (this.width / 2 + .17), -.22, 0], 0x7e8764);
      for (let n = -4; n <= 4; n += 2) {
        this.glow(this.terrain, [.21, .055, .035], [n, -.36, sign * (this.height / 2 + .21)], 0x8b9540);
        this.glow(this.terrain, [.035, .055, .21], [sign * (this.width / 2 + .21), -.36, n], 0x8b9540);
      }
    }
    const exit = new THREE.Group(); exit.position.copy(this.world(p.level.exit));
    this.box(exit, [.87, .04, .87], [0, .035, 0], colors.dark);
    for (const x of [-.29, .29]) this.glow(exit, [.055, .02, .64], [x, .07, 0], colors.signal);
    for (const z of [-.27, .27]) this.glow(exit, [.28, .02, .045], [0, .07, z], colors.signal);
    this.label(exit, 'EXIT', '#e5ed91', .52, .48);
    this.terrain.add(exit);
    for (const [text, position] of [['N', { x: this.width / 2 - .5, y: -.9 }], ['E', { x: this.width + .3, y: this.height / 2 - .5 }]] as const) {
      const label = new THREE.Group(); label.position.copy(this.world(position));
      this.label(label, text, '#8d9976', 0, .38); this.terrain.add(label);
    }
    this.batchMeshes(this.terrain);
    this.fitCamera();
  }

  private buildEntity(entity: ObservedEntity, sensed: boolean) {
    const group = new THREE.Group(); group.position.copy(this.world(entity.position));
    group.name = `observed:${entity.id}`;
    const steel = sensed ? 0x929c7d : 0x5b664c;
    if (entity.type === 'supply') {
      if (entity.itemType === 'oxygen') {
        this.box(group, [.48, .065, .37], [0, .075, 0], colors.dark);
        for (const x of [-.13, .13]) {
          this.tank(group, [.19, .44, .19], [x, .31, 0], colors.ivory);
          this.tank(group, [.2, .07, .2], [x, .33, 0], colors.steel);
          this.tank(group, [.11, .06, .11], [x, .56, 0], colors.dark);
        }
        this.box(group, [.35, .035, .04], [0, .57, 0], colors.steel);
      } else {
        const color = entity.itemType === 'battery' ? colors.signal : colors.ivory;
        this.box(group, [.52, .3, .4], [0, .24, 0], colors.dark);
        this.box(group, [.54, .06, .42], [0, .43, 0], steel);
        this.box(group, [.4, .17, .02], [0, .26, .215], color);
        for (const x of [-.19, .19]) this.box(group, [.055, .31, .42], [x, .26, 0], steel);
        this.box(group, [.24, .045, .045], [0, .53, 0], colors.dark);
        for (const x of [-.1, .1]) this.box(group, [.035, .09, .045], [x, .48, 0], colors.dark);
        if (entity.itemType === 'repair') {
          this.box(group, [.2, .045, .025], [0, .28, .232], colors.dark);
          this.box(group, [.045, .15, .025], [0, .28, .236], colors.dark);
        } else this.glow(group, [.16, .025, .025], [0, .28, .235], colors.signal);
      }
    } else if (entity.type === 'door') {
      this.box(group, [.12, .88, .46], [-.38, .45, 0], steel);
      this.box(group, [.12, .88, .46], [.38, .45, 0], steel);
      this.box(group, [.88, .13, .48], [0, .92, 0], colors.dark);
      if (entity.state !== 'opened') {
        for (const x of [-.15, .15]) {
          this.box(group, [.27, .7, .17], [x, .41, 0], steel);
          this.box(group, [.2, .055, .025], [x, .32, .1], colors.dark);
        }
        this.box(group, [.035, .64, .025], [0, .4, .11], colors.dark);
      }
      for (const x of [-.38, .38]) this.box(group, [.07, .17, .03], [x, .2, .25], colors.amber);
      this.glow(group, [.29, .045, .03], [0, .94, .26], entity.state === 'opened' ? colors.signal : colors.amber);
    } else if (entity.type === 'cabinet') {
      this.box(group, [.61, .87, .43], [0, .46, 0], steel);
      this.box(group, [.48, .7, .04], [0, .46, .236], colors.dark);
      if (entity.state === 'opened') {
        this.box(group, [.42, .035, .03], [0, .35, .27], colors.ivory);
        const door = this.box(group, [.4, .7, .035], [.35, .46, .4], steel); door.rotation.y = -.8;
      } else {
        const face = this.box(group, [.48, .72, .025], [0, .46, .267], steel);
        face.material = this.surface('vent', steel);
        this.box(group, [.04, .18, .035], [.15, .47, .297], colors.dark);
      }
      this.glow(group, [.12, .035, .03], [-.12, .78, .29], colors.signal);
      this.box(group, [.64, .06, .46], [0, .94, 0], colors.dark);
    } else if (entity.type === 'obstacle') {
      const bar = this.box(group, [.87, .16, .24], [0, .19, 0], steel); bar.rotation.y = .6;
      const beam = this.box(group, [.19, .31, .7], [.08, .23, .08], 0x7e8267); beam.rotation.z = .35;
      this.box(group, [.3, .2, .3], [-.23, .17, -.2], colors.dark);
      const stripe = this.box(group, [.26, .018, .2], [0, .286, 0], colors.amber); stripe.rotation.y = .6;
    } else if (entity.type === 'hazard') {
      this.box(group, [.77, .065, .62], [0, .07, 0], colors.dark);
      for (const x of [-.31, .31]) this.box(group, [.09, .03, .57], [x, .12, 0], colors.amber);
      for (let i = 0; i < 3; i++) {
        const cable = this.box(group, [.055, .04, .48], [-.18 + i * .18, .15, 0], steel); cable.rotation.y = -.18;
        this.glow(group, [.07, .04, .13], [-.18 + i * .18, .17, .09], entity.state === 'active' ? colors.red : 0x657147);
      }
    } else if (entity.type === 'airlock') {
      this.box(group, [.67, .15, .5], [0, .12, 0], colors.dark);
      this.box(group, [.45, .51, .36], [0, .43, 0], steel);
      const screen = this.box(group, [.55, .31, .085], [0, .77, .05], colors.dark); screen.rotation.x = -.2;
      this.glow(group, [.42, .15, .035], [0, .8, .108], entity.state === 'repaired' ? colors.signal : colors.amber);
      for (const x of [-.15, 0, .15]) this.box(group, [.065, .025, .06], [x, .7, .16], colors.ivory);
      this.box(group, [.52, .05, .03], [0, .3, .205], colors.amber);
    } else {
      this.box(group, [.54, .54, .37], [0, .3, 0], steel);
      this.box(group, [.39, .37, .035], [0, .32, .205], colors.dark);
      this.box(group, [.21, .16, .03], [0, .39, .23], colors.ivory);
      const handle = this.box(group, [.045, .2, .055], [0, .38, .27], colors.dark);
      handle.rotation.z = entity.state === 'on' ? -.6 : .6;
      this.glow(group, [.15, .035, .035], [0, .18, .235], entity.state === 'on' ? colors.signal : colors.amber);
      this.box(group, [.59, .06, .4], [0, .6, 0], colors.dark);
    }
    this.objects.add(group);
  }

  update(p: PlayerView, selected: Position | null) {
    const levelKey = JSON.stringify([p.level.id, p.level.tiles]);
    const changedLevel = levelKey !== this.levelKey;
    if (changedLevel) { this.buildTerrain(p); this.levelKey = levelKey; this.signature = ''; }
    const sensed = new Set(p.sensorCells.map(cell => `${cell.x},${cell.y}`));
    const signature = JSON.stringify([p.observed, p.radar, p.markers, p.sensorCells, p.robot.position, p.circuitOn]);
    if (signature !== this.signature) {
      this.clear(this.objects);
      for (let y = 0; y < this.height; y++) for (let x = 0; x < this.width; x++) {
        const near = sensed.has(`${x},${y}`);
        const radar = Math.abs(x - p.robot.position.x) + Math.abs(y - p.robot.position.y) <= p.rules.radarRadius;
        const wall = p.level.tiles[y][x] === '#';
        const color = wall ? 0x30372b : near ? (x + y) % 2 ? 0x687345 : 0x737d4b : radar ? (x + y) % 2 ? 0x454e35 : 0x4b543b : (x + y) % 2 ? 0x353e2c : 0x3b4331;
        this.floor!.setColorAt(y * this.width + x, new THREE.Color(color));
      }
      this.floor!.instanceColor!.needsUpdate = true;
      // Outline the actual sensor footprint. Decorations never imply unseen objects.
      for (const cell of p.sensorCells) {
        if (p.level.tiles[cell.y]?.[cell.x] !== '.') continue;
        const group = new THREE.Group(); group.position.copy(this.world(cell));
        for (const [dx, dz] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
          if (sensed.has(`${cell.x + dx},${cell.y + dz}`) && p.level.tiles[cell.y + dz]?.[cell.x + dx] === '.') continue;
          this.glow(group, dx ? [.025, .012, .87] : [.87, .012, .025], [dx * .445, .02, dz * .445], 0x929d49);
        }
        this.objects.add(group);
      }
      const observed = p.observed.filter(entity => !['cleared', 'inventory'].includes(entity.state));
      for (const entity of observed) this.buildEntity(entity, sensed.has(`${entity.position.x},${entity.position.y}`));
      for (const echo of p.radar) {
        if (observed.some(entity => equal(entity.position, echo.position))) continue;
        const group = new THREE.Group(); group.position.copy(this.world(echo.position));
        group.name = `echo:${echo.id}`;
        const color = echo.historical ? 0x6f7652 : colors.signal;
        this.buildReticle(group, color, echo.strength === 'strong' ? .54 : .38);
        this.label(group, echo.shape === 'flickering' ? '? !' : '?', echo.historical ? '#8e9875' : '#e2e8a0', .55, .36);
        this.objects.add(group);
      }
      for (const marker of p.markers) {
        const group = new THREE.Group(); group.position.copy(this.world(marker.position));
        const color = marker.shared ? colors.marker : 0x798765;
        this.box(group, [.04, .6, .04], [-.34, .31, -.34], color);
        this.glow(group, [.24, .16, .025], [-.23, .56, -.34], color);
        this.objects.add(group);
      }
      this.batchMeshes(this.objects);
      this.signature = signature;
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
    this.canvas.style.cursor = 'grab';
    this.draw();
  };
  private onPointerLeave = () => { if (this.hover.visible) { this.hover.visible = false; this.draw(); } };
  private onContextLost = (event: Event) => {
    event.preventDefault(); cancelAnimationFrame(this.animation);
    this.canvas.dataset.renderMode = 'recovering';
    document.getElementById('map-render-status')!.textContent = '画面暂时中断，正在恢复…';
  };
  private onContextRestored = () => { this.canvas.dataset.renderMode = '3d'; document.getElementById('map-render-status')!.textContent = '点击选格 · 拖动观察 · 滚轮缩放'; this.resize(); };
  private onVisibilityChange = () => {
    if (document.hidden) { cancelAnimationFrame(this.animation); this.cancelGesture(); }
    else if (this.state) { this.robot.position.copy(this.world(this.state.robot.position)); this.signature = ''; this.update(this.state, this.selection.visible ? { x: Math.round(this.selection.position.x + (this.width - 1) / 2), y: Math.round(this.selection.position.z + (this.height - 1) / 2) } : null); }
  };

  private resize() {
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height || this.disposed) return;
    // Keep pixel edges, with enough samples to read metal plates and character silhouettes.
    this.renderer.setSize(Math.max(1, Math.round(rect.width * .75)), Math.max(1, Math.round(rect.height * .75)), false);
    this.fitCamera(); this.draw();
  }

  private draw() {
    if (this.disposed || document.hidden) return;
    this.renderer.render(this.scene, this.camera);
    this.canvas.dataset.drawCalls = String(this.renderer.info.render.calls);
  }

  dispose() {
    this.disposed = true; cancelAnimationFrame(this.animation); this.observer.disconnect();
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
    for (const group of [this.terrain, this.objects, this.robot, this.human, this.selection, this.hover]) this.clear(group);
    this.cube.dispose(); this.cylinder.dispose();
    this.materials.forEach(material => material.dispose()); this.surfaces.forEach(material => material.dispose());
    this.textures.forEach(texture => texture.dispose());
    this.renderer.dispose();
  }
}
