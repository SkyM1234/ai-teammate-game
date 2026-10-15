import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import type { ObservedEntity, PlayerView, Position } from '../../../packages/game-core/src/types.ts';

const colors = { steel: 0x718174, dark: 0x1c2724, ivory: 0xcdd1c4, signal: 0xe4eb1c, amber: 0xd3ae79, red: 0xed8165, marker: 0xd4e0c3 };
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
  private readonly cube = new RoundedBoxGeometry(1, 1, 1, 1, .08);
  private readonly deck = new THREE.BoxGeometry(1, 1, 1);
  private readonly cylinder = new THREE.CylinderGeometry(.5, .5, 1, 20);
  private readonly sphere = new THREE.SphereGeometry(.5, 16, 10);
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
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'low-power' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.scene.add(this.terrain, this.objects, this.robot, this.human, this.selection, this.hover);
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
      material = new THREE.MeshStandardMaterial({ color, roughness: .68, metalness: .25 });
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

  private ball(group: THREE.Group, size: [number, number, number], position: [number, number, number], color: number) {
    const mesh = new THREE.Mesh(this.sphere, this.material(color));
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
      if (object.geometry !== this.cube && object.geometry !== this.cylinder && object.geometry !== this.sphere) return;
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
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256;
      const context = canvas.getContext('2d')!;
      const finish = context.createLinearGradient(0, 0, 256, 256);
      finish.addColorStop(0, '#eef0eb'); finish.addColorStop(1, '#cbd2c9');
      context.fillStyle = finish; context.fillRect(0, 0, 256, 256);
      if (kind === 'vent') {
        context.strokeStyle = '#aeb8ac'; context.lineWidth = 2; context.strokeRect(5, 5, 246, 246);
        context.strokeStyle = '#f2f4ed'; context.lineWidth = 1; context.strokeRect(8.5, 8.5, 239, 239);
        context.fillStyle = '#a7b2a5'; context.fillRect(65, 63, 126, 130);
        for (let y = 76; y <= 172; y += 16) {
          context.fillStyle = '#657669'; context.fillRect(76, y, 104, 5);
          context.fillStyle = '#dae0d5'; context.fillRect(76, y + 5, 104, 2);
        }
        context.fillStyle = '#849180';
        for (const x of [27, 229]) for (const y of [27, 229]) {
          context.beginPath(); context.arc(x, y, 3, 0, Math.PI * 2); context.fill();
        }
      } else {
        // Fine brushed finish; larger panel seams are built from public map geometry.
        context.fillStyle = '#d8dfd7'; context.fillRect(0, 0, 256, 256);
        for (let y = 0; y < 256; y += 4) {
          context.fillStyle = y % 12 ? '#ffffff06' : '#52675a06';
          context.fillRect(0, y, 256, 1);
        }
      }
      texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.magFilter = THREE.LinearFilter; texture.generateMipmaps = true;
      texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
      this.textures.set(kind, texture);
    }
    material = new THREE.MeshStandardMaterial({ color, map: texture, roughness: .8, metalness: .2 });
    this.surfaces.set(key, material); return material;
  }

  private glow(group: THREE.Group, size: [number, number, number], position: [number, number, number], color: number) {
    const mesh = this.box(group, size, position, color);
    // Keep luminous inserts restrained so nearby surfaces retain their contrast.
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
      canvas.height = 96;
      const context = canvas.getContext('2d')!;
      context.font = '600 66px "Segoe UI", sans-serif';
      canvas.width = Math.ceil(context.measureText(text).width) + 48;
      context.fillStyle = '#19241fe8'; context.fillRect(0, 0, canvas.width, 96);
      context.fillStyle = color; context.font = '600 66px "Segoe UI", sans-serif';
      context.textAlign = 'center'; context.textBaseline = 'middle';
      context.fillText(text, canvas.width / 2, 51);
      texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.minFilter = THREE.LinearFilter; texture.magFilter = THREE.LinearFilter;
      texture.generateMipmaps = false;
      this.textures.set(key, texture);
    }
    const material = new THREE.SpriteMaterial({ map: texture, depthTest: false, toneMapped: false });
    const sprite = new THREE.Sprite(material);
    sprite.position.y = y;
    sprite.scale.set(scale * .65 * texture.image.width / 96, scale * .65, 1);
    sprite.renderOrder = 5;
    group.add(sprite);
  }

  private world(position: Position) {
    return new THREE.Vector3(position.x - (this.width - 1) / 2, 0, position.y - (this.height - 1) / 2);
  }

  private buildRobot() {
    for (const x of [-.27, .27]) {
      this.box(this.robot, [.23, .25, .65], [x, .17, 0], colors.dark);
      for (const z of [-.2, 0, .2]) {
        const wheel = this.tank(this.robot, [.17, .025, .17], [x * 1.43, .17, z], colors.steel);
        wheel.rotation.z = Math.PI / 2;
      }
      for (const z of [-.24, -.12, 0, .12, .24]) this.box(this.robot, [.235, .025, .045], [x, .3, z], colors.steel);
      this.box(this.robot, [.2, .08, .51], [x, .34, 0], colors.ivory);
      this.ball(this.robot, [.17, .17, .17], [x * 1.3, .66, 0], colors.steel);
      const arm = this.box(this.robot, [.12, .25, .16], [x * 1.42, .5, .035], colors.ivory);
      arm.rotation.z = -Math.sign(x) * .16;
      this.box(this.robot, [.13, .08, .17], [x * 1.48, .37, .065], colors.dark);
      for (const dz of [-.055, .055]) this.box(this.robot, [.08, .1, .04], [x * 1.48, .3, .075 + dz], colors.steel);
    }
    this.box(this.robot, [.55, .16, .43], [0, .34, 0], colors.steel);
    this.box(this.robot, [.5, .32, .36], [0, .57, 0], colors.ivory);
    const breastplate = this.box(this.robot, [.42, .23, .065], [0, .58, .19], colors.steel);
    breastplate.rotation.x = -.18;
    this.glow(this.robot, [.2, .035, .025], [0, .61, .235], colors.signal);
    this.box(this.robot, [.31, .29, .16], [0, .55, -.25], colors.dark);
    for (const x of [-.1, .1]) this.tank(this.robot, [.1, .26, .1], [x, .55, -.34], colors.steel);
    this.tank(this.robot, [.18, .09, .18], [0, .77, 0], colors.dark);
    this.box(this.robot, [.5, .25, .39], [0, .92, .025], colors.ivory);
    this.box(this.robot, [.43, .13, .04], [0, .93, .225], colors.dark);
    this.glow(this.robot, [.25, .045, .02], [0, .94, .252], colors.signal);
    this.box(this.robot, [.41, .035, .32], [0, 1.06, .025], colors.steel);
    this.tank(this.robot, [.03, .18, .03], [.18, 1.15, -.065], colors.steel);
    this.ball(this.robot, [.065, .065, .065], [.18, 1.26, -.065], colors.signal);
    this.label(this.robot, 'R-07', '#e5ed78', 1.52, .62);
  }

  private buildHuman() {
    this.box(this.human, [.61, .07, .97], [0, .08, .01], colors.dark);
    this.box(this.human, [.45, .07, .79], [0, .15, .01], 0x5f6953);
    for (const x of [-.27, .27]) {
      this.tank(this.human, [.045, .94, .045], [x, .15, .01], colors.ivory).rotation.x = Math.PI / 2;
      for (const z of [-.39, .39]) this.box(this.human, [.06, .08, .13], [x, .1, z], colors.dark);
    }
    this.box(this.human, [.34, .18, .4], [0, .27, .06], colors.steel);
    for (const z of [-.03, .23]) this.box(this.human, [.37, .035, .065], [0, .37, z], colors.amber);
    this.ball(this.human, [.28, .25, .28], [0, .3, -.3], colors.ivory);
    this.box(this.human, [.21, .1, .035], [0, .33, -.433], colors.dark);
    this.glow(this.human, [.07, .025, .025], [.07, .4, -.41], colors.amber);
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
    this.floor = new THREE.InstancedMesh(this.deck, this.surface('deck', 0xffffff), count);
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
      transform.scale.set(.998, .15, .998); transform.updateMatrix();
      this.floor.setMatrixAt(y * this.width + x, transform.matrix);
      if (p.level.tiles[y][x] === '#') continue;
      const plate = new THREE.Group(); plate.position.copy(this.world({ x, y }));
      // Two-by-two inspection plates span movement cells; cell colors still show sensor knowledge.
      if (x % 2 === 0 && p.level.tiles[y][x + 1] !== '#' && x + 1 < this.width) {
        this.box(plate, [.012, .006, 1], [.5, .003, 0], 0x35483e);
        this.box(plate, [.008, .004, 1], [.518, .002, 0], 0x77877a);
      }
      if (y % 2 === 0 && p.level.tiles[y + 1]?.[x] !== '#' && y + 1 < this.height) {
        this.box(plate, [1, .006, .012], [0, .003, .5], 0x35483e);
        this.box(plate, [1, .004, .008], [0, .002, .518], 0x77877a);
      }
      if (x % 2 === 1 && y % 2 === 1) {
        this.box(plate, [.15, .009, .055], [-.33, .006, -.35], colors.steel);
        this.box(plate, [.09, .012, .018], [-.33, .012, -.35], colors.dark);
      }
      for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        if (p.level.tiles[y + dz]?.[x + dx] !== '#') continue;
        this.box(plate, dx ? [.1, .035, 1] : [1, .035, .1], [dx * .45, .02, dz * .45], 0x718174);
      }
      this.terrain.add(plate);
    }
    this.wallCells.forEach((cell, i) => {
      const boundary = cell.x === 0 || cell.y === 0 || cell.x === this.width - 1 || cell.y === this.height - 1;
      const height = boundary ? .34 : .55;
      transform.position.copy(this.world(cell)); transform.position.y = height / 2;
      transform.scale.set(.998, height, .998); transform.updateMatrix();
      this.walls!.setMatrixAt(i, transform.matrix);
      this.walls!.setColorAt(i, new THREE.Color(boundary ? 0x35463d : 0x4c5c51));
      // Wall cladding follows public floor-plan edges, never hidden gameplay objects.
      const cap = new THREE.Group(); cap.position.copy(this.world(cell));
      this.box(cap, [.99, .065, .99], [0, height + .018, 0], boundary ? 0x8b9586 : 0xb1b9aa);
      if ((cell.x + cell.y) % 3 === 0) {
        const vent = this.box(cap, [.61, .018, .55], [0, height + .058, 0], colors.steel);
        vent.material = this.surface('vent', 0x8b9586);
      }
      for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        if (!p.level.tiles[cell.y + dz]?.[cell.x + dx] || p.level.tiles[cell.y + dz][cell.x + dx] === '#') continue;
        this.box(cap, dx ? [.06, height * .7, .82] : [.82, height * .7, .06], [dx * .51, height * .48, dz * .51], colors.steel);
        this.box(cap, dx ? [.075, .035, .92] : [.92, .035, .075], [dx * .52, height * .82, dz * .52], colors.ivory);
        if ((cell.x + cell.y) % 2 === 0) {
          this.box(cap, dx ? [.09, height * .85, .085] : [.085, height * .85, .09], [dx * .535, height / 2, dz * .535], colors.dark);
        }
      }
      if ((cell.x * 3 + cell.y) % 7 === 0) {
        this.box(cap, [.32, .014, .09], [0, height + .061, .32], colors.amber);
        for (const x of [-.09, .03]) {
          const stripe = this.box(cap, [.04, .016, .1], [x, height + .064, .32], colors.dark); stripe.rotation.y = -.5;
        }
      }
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
    const steel = sensed ? 0xa3b0a2 : 0x617567;
    if (entity.type === 'supply') {
      if (entity.itemType === 'oxygen') {
        this.box(group, [.55, .07, .4], [0, .075, 0], colors.dark);
        for (const x of [-.14, .14]) {
          this.tank(group, [.22, .38, .22], [x, .34, 0], colors.ivory);
          this.ball(group, [.22, .15, .22], [x, .53, 0], colors.ivory);
          this.ball(group, [.22, .13, .22], [x, .15, 0], colors.ivory);
          this.tank(group, [.226, .07, .226], [x, .36, 0], colors.steel);
          this.tank(group, [.07, .09, .07], [x, .63, 0], colors.dark);
          this.box(group, [.14, .025, .04], [x, .68, 0], colors.amber);
          this.box(group, [.08, .11, .02], [x, .45, .115], steel);
        }
        this.box(group, [.44, .04, .035], [0, .39, .14], colors.dark);
        this.box(group, [.44, .04, .035], [0, .39, -.14], colors.dark);
      } else {
        if (entity.itemType === 'repair') {
          this.box(group, [.64, .31, .46], [0, .24, 0], steel);
          this.box(group, [.66, .085, .48], [0, .44, 0], colors.ivory);
          this.box(group, [.5, .025, .035], [0, .39, .244], colors.dark);
          for (const x of [-.23, .23]) this.box(group, [.065, .15, .035], [x, .39, .26], colors.dark);
          this.box(group, [.26, .045, .06], [0, .58, 0], colors.dark);
          for (const x of [-.1, .1]) this.box(group, [.04, .11, .06], [x, .52, 0], colors.dark);
          this.box(group, [.2, .045, .025], [0, .25, .245], colors.amber);
          this.box(group, [.045, .15, .025], [0, .25, .249], colors.amber);
        } else {
          this.box(group, [.45, .5, .35], [0, .33, 0], colors.dark);
          for (const x of [-.21, .21]) this.box(group, [.075, .47, .39], [x, .33, 0], steel);
          this.box(group, [.36, .24, .025], [0, .33, .19], colors.signal);
          this.box(group, [.38, .07, .38], [0, .6, 0], steel);
          for (const x of [-.11, .11]) this.tank(group, [.07, .065, .07], [x, .67, 0], colors.amber);
          for (const x of [-.09, 0, .09]) this.glow(group, [.04, .07, .025], [x, .32, .215], colors.ivory);
        }
      }
    } else if (entity.type === 'door') {
      group.rotation.y = Math.PI / 2;
      this.box(group, [.94, .045, .55], [0, .035, 0], colors.dark);
      for (const x of [-.39, .39]) {
        this.box(group, [.16, .96, .46], [x, .52, 0], steel);
        for (const side of [-1, 1]) {
          this.box(group, [.075, .75, .035], [x, .55, side * .25], colors.dark);
          this.box(group, [.1, .15, .045], [x, .2, side * .26], colors.amber);
        }
      }
      this.box(group, [.96, .15, .5], [0, 1.02, 0], colors.ivory);
      for (const sign of [-1, 1]) {
        const x = sign * (entity.state === 'opened' ? .34 : .15);
        this.box(group, [entity.state === 'opened' ? .09 : .28, .77, .18], [x, .49, 0], steel);
        if (entity.state !== 'opened') {
          for (const side of [-1, 1]) this.box(group, [.21, .075, .025], [x, .48, side * .11], colors.dark);
        }
      }
      for (const side of [-1, 1]) this.glow(group, [.32, .045, .03], [0, 1.03, side * .27], entity.state === 'opened' ? colors.signal : colors.amber);
    } else if (entity.type === 'cabinet') {
      this.box(group, [.68, .91, .5], [0, .51, 0], steel);
      this.box(group, [.53, .77, .045], [0, .52, .265], colors.dark);
      for (const x of [-.3, .3]) this.box(group, [.05, .82, .04], [x, .5, .29], colors.ivory);
      if (entity.state === 'opened') {
        for (const y of [.3, .55]) this.box(group, [.48, .025, .16], [0, y, .29], colors.ivory);
        const door = this.box(group, [.49, .77, .045], [.39, .52, .45], steel); door.rotation.y = -.95;
      } else {
        const face = this.box(group, [.52, .77, .04], [0, .52, .3], steel);
        face.material = this.surface('vent', steel);
        this.box(group, [.04, .2, .05], [.17, .48, .345], colors.dark);
      }
      this.glow(group, [.12, .035, .03], [-.13, .85, .33], colors.signal);
      this.box(group, [.71, .07, .53], [0, 1.01, 0], colors.dark);
      this.box(group, [.71, .07, .53], [0, .06, 0], colors.dark);
    } else if (entity.type === 'obstacle') {
      const bar = this.box(group, [.87, .16, .24], [0, .19, 0], steel); bar.rotation.y = .6;
      const beam = this.box(group, [.19, .31, .7], [.08, .23, .08], 0x7e8267); beam.rotation.z = .35;
      this.box(group, [.3, .2, .3], [-.23, .17, -.2], colors.dark);
      const stripe = this.box(group, [.26, .018, .2], [0, .286, 0], colors.amber); stripe.rotation.y = .6;
      const panel = this.box(group, [.47, .035, .36], [-.18, .33, -.05], steel); panel.rotation.set(.3, -.5, .25);
      for (const z of [-.24, .24]) {
        const brace = this.box(group, [.72, .06, .06], [0, .13, z], colors.dark); brace.rotation.y = .6;
      }
    } else if (entity.type === 'hazard') {
      this.box(group, [.77, .065, .62], [0, .07, 0], colors.dark);
      for (const x of [-.31, .31]) this.box(group, [.09, .03, .57], [x, .12, 0], colors.amber);
      for (let i = 0; i < 3; i++) {
        const x = -.18 + i * .18;
        const cable = this.tank(group, [.055, .47, .055], [x, .16, 0], steel); cable.rotation.set(Math.PI / 2, 0, -.12);
        for (const z of [-.21, .21]) this.box(group, [.09, .09, .075], [x, .16, z], colors.ivory);
        this.glow(group, [.07, .05, .09], [x, .18, .07], entity.state === 'active' ? colors.red : 0x657147);
      }
    } else if (entity.type === 'airlock') {
      this.box(group, [.74, .13, .57], [0, .1, 0], colors.dark);
      this.box(group, [.5, .53, .4], [0, .43, 0], steel);
      this.box(group, [.38, .29, .035], [0, .39, .22], colors.dark);
      for (const x of [-.29, .29]) this.tank(group, [.07, .48, .07], [x, .4, -.06], colors.ivory);
      const console = new THREE.Group(); console.position.set(0, .79, .06); console.rotation.x = -.3;
      this.box(console, [.65, .39, .1], [0, 0, 0], colors.ivory);
      this.box(console, [.55, .29, .025], [0, .015, .06], colors.dark);
      const status = entity.state === 'repaired' ? colors.signal : colors.amber;
      this.glow(console, [.36, .1, .02], [-.04, .04, .08], status);
      for (let i = 0; i < 3; i++) this.glow(console, [.04, .025, .02], [.21, .08 - i * .055, .08], status);
      this.box(console, [.3, .018, .02], [-.04, -.06, .08], colors.steel);
      group.add(console);
      const keyboard = this.box(group, [.6, .055, .2], [0, .61, .23], colors.dark); keyboard.rotation.x = -.15;
      for (const x of [-.18, -.06, .06, .18]) this.box(group, [.065, .02, .07], [x, .65, .25], colors.ivory);
      this.box(group, [.52, .04, .03], [0, .29, .245], colors.amber);
    } else {
      this.box(group, [.61, .08, .46], [0, .075, 0], colors.dark);
      this.box(group, [.55, .57, .38], [0, .37, 0], steel);
      this.box(group, [.43, .41, .04], [0, .38, .215], colors.ivory);
      this.box(group, [.28, .23, .025], [0, .41, .25], colors.dark);
      this.tank(group, [.16, .035, .16], [0, .42, .28], colors.steel).rotation.x = Math.PI / 2;
      const handle = this.box(group, [.055, .21, .065], [0, .43, .32], colors.dark);
      handle.rotation.z = entity.state === 'on' ? -.6 : .6;
      this.ball(group, [.1, .1, .1], [entity.state === 'on' ? .06 : -.06, .515, .32], colors.amber);
      this.glow(group, [.15, .035, .025], [0, .23, .25], entity.state === 'on' ? colors.signal : colors.amber);
      this.box(group, [.6, .065, .43], [0, .69, 0], colors.dark);
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
        const color = new THREE.Color(wall ? 0x29352d : near ? 0x667064 : radar ? 0x3e4b40 : 0x2c382f);
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
    // Match the display while bounding GPU cost on high-density screens.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(Math.max(1, Math.round(rect.width)), Math.max(1, Math.round(rect.height)), false);
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
    this.cube.dispose(); this.deck.dispose(); this.cylinder.dispose(); this.sphere.dispose();
    this.materials.forEach(material => material.dispose()); this.surfaces.forEach(material => material.dispose());
    this.textures.forEach(texture => texture.dispose());
    this.renderer.dispose();
  }
}
