import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

const finishes = {
  paint: { roughness: .68, metalness: .25 },
  metal: { roughness: .4, metalness: .7 },
  rubber: { roughness: .95, metalness: 0 },
  glass: { roughness: .16, metalness: .35 },
};
type Finish = keyof typeof finishes;

/** One pool per renderer. Builders borrow these assets; only the pool disposes them. */
export class ArtResources {
  readonly cube = new RoundedBoxGeometry(1, 1, 1, 1, .08);
  readonly deck = new THREE.BoxGeometry(1, 1, 1);
  private readonly cylinder = new THREE.CylinderGeometry(.5, .5, 1, 20);
  private readonly sphere = new THREE.SphereGeometry(.5, 16, 10);
  private readonly materials = new Map<string, THREE.MeshStandardMaterial>();
  private readonly surfaces = new Map<string, THREE.MeshStandardMaterial>();
  private readonly textures = new Map<string, THREE.CanvasTexture>();
  private readonly anisotropy: number;

  constructor(anisotropy = 1) { this.anisotropy = anisotropy; }

  material(color: number, finish: Finish = 'paint') {
    const key = `${finish}:${color}`;
    let material = this.materials.get(key);
    if (!material) {
      material = new THREE.MeshStandardMaterial({ color, ...finishes[finish] });
      this.materials.set(key, material);
    }
    return material;
  }

  box(group: THREE.Group, size: [number, number, number], position: [number, number, number], color: number, finish: Finish = 'paint') {
    const mesh = new THREE.Mesh(this.cube, this.material(color, finish));
    mesh.scale.set(...size);
    mesh.position.set(...position);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  }

  tank(group: THREE.Group, size: [number, number, number], position: [number, number, number], color: number, finish: Finish = 'paint') {
    const mesh = new THREE.Mesh(this.cylinder, this.material(color, finish));
    mesh.scale.set(...size); mesh.position.set(...position);
    mesh.castShadow = true; mesh.receiveShadow = true;
    group.add(mesh); return mesh;
  }

  ball(group: THREE.Group, size: [number, number, number], position: [number, number, number], color: number, finish: Finish = 'paint') {
    const mesh = new THREE.Mesh(this.sphere, this.material(color, finish));
    mesh.scale.set(...size); mesh.position.set(...position);
    mesh.castShadow = true; mesh.receiveShadow = true;
    group.add(mesh); return mesh;
  }

  /** Batch static parts in local space, preserving parent movement and rotation. */
  batchMeshes(group: THREE.Group) {
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

  surface(kind: 'deck' | 'vent', color: number) {
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
      texture.anisotropy = Math.min(8, this.anisotropy);
      this.textures.set(kind, texture);
    }
    material = new THREE.MeshStandardMaterial({ color, map: texture, roughness: .8, metalness: .2 });
    this.surfaces.set(key, material); return material;
  }

  glow(group: THREE.Group, size: [number, number, number], position: [number, number, number], color: number) {
    const mesh = this.box(group, size, position, color);
    // Keep luminous inserts restrained so nearby surfaces retain their contrast.
    const key = `glow:${color}`;
    let material = this.materials.get(key);
    if (!material) {
      material = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: .55, roughness: 1 });
      this.materials.set(key, material);
    }
    mesh.material = material;
    mesh.castShadow = false;
    return mesh;
  }

  label(group: THREE.Group, text: string, color: string, y: number, scale = .7) {
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
    return sprite;
  }

  gasTexture() {
    const existing = this.textures.get('exit-gas');
    if (existing) return existing;
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
    const context = canvas.getContext('2d')!;
    const gradient = context.createRadialGradient(32, 32, 0, 32, 32, 32);
    gradient.addColorStop(0, '#f1fdff'); gradient.addColorStop(.4, '#c6e7f0cc'); gradient.addColorStop(1, '#c1e5eb00');
    context.fillStyle = gradient; context.fillRect(0, 0, 64, 64);
    const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
    this.textures.set('exit-gas', texture);
    return texture;
  }

  clear(group: THREE.Group) {
    group.traverse(object => {
      if (object instanceof THREE.Sprite) object.material.dispose();
      if (object instanceof THREE.InstancedMesh) object.dispose();
    });
    group.clear();
  }

  /** Instance buffers and sprite materials belong to their groups; shared assets live here. */
  dispose() {
    this.cube.dispose(); this.deck.dispose(); this.cylinder.dispose(); this.sphere.dispose();
    this.materials.forEach(material => material.dispose()); this.surfaces.forEach(material => material.dispose());
    this.textures.forEach(texture => texture.dispose());
    this.materials.clear(); this.surfaces.clear(); this.textures.clear();
  }
}
