import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { ArtResources } from '../apps/web/src/art/resources.ts';
import { createProp } from '../apps/web/src/art/props.ts';
import { colors } from '../apps/web/src/art/themes.ts';

test('门框按配置沿地图横向或纵向展开，开门及合批后保持朝向', () => {
  const art = new ArtResources();
  for (const state of ['closed', 'opened']) {
    for (const orientation of ['horizontal', 'vertical', undefined] as const) {
      const door = createProp(art, { id: 'door', type: 'door', name: '门', position: { x: 3, y: 7 }, orientation, state, scanned: false, observedAt: 0, source: 'sensor' }, true);
      const size = new THREE.Box3().setFromObject(door).getSize(new THREE.Vector3());
      assert.equal(size.x > size.z, orientation === 'horizontal');
      art.batchMeshes(door);
      const batchedSize = new THREE.Box3().setFromObject(door).getSize(new THREE.Vector3());
      assert.ok(size.distanceTo(batchedSize) < 1e-6);
      art.clear(door);
    }
  }
  art.dispose();
});

test('清理模型实例不销毁共用资源，材质可以按表面类型复用', () => {
  const art = new ArtResources();
  const paint = art.material(colors.dark), rubber = art.material(colors.dark, 'rubber');
  assert.equal(art.material(colors.dark), paint);
  assert.notEqual(paint, rubber);
  assert.equal(rubber.metalness, 0);
  let geometryDisposed = 0, paintDisposed = 0;
  art.cube.addEventListener('dispose', () => geometryDisposed++);
  paint.addEventListener('dispose', () => paintDisposed++);
  const first = new THREE.Group(), second = new THREE.Group();
  art.box(first, [1, 1, 1], [0, 0, 0], colors.dark);
  const retained = art.box(second, [1, 1, 1], [0, 0, 0], colors.dark);
  art.batchMeshes(first);
  let instanceDisposed = 0;
  (first.children[0] as THREE.InstancedMesh).addEventListener('dispose', () => instanceDisposed++);
  art.clear(first);
  assert.equal(instanceDisposed, 1);
  assert.equal(geometryDisposed, 0); assert.equal(paintDisposed, 0);
  assert.equal(retained.geometry, art.cube); assert.equal(retained.material, paint);
  art.clear(second); art.dispose();
  assert.equal(geometryDisposed, 1); assert.equal(paintDisposed, 1);
});

test('合批保留嵌套零件的世界变换，父模型仍可独立移动', () => {
  const art = new ArtResources();
  const parent = new THREE.Group(), joint = new THREE.Group();
  parent.position.set(3, 2, -1); parent.rotation.y = .7;
  joint.position.set(.2, .7, .1); joint.rotation.x = -.3; parent.add(joint);
  const part = art.box(joint, [.6, .4, .2], [.1, .2, .3], colors.steel);
  parent.updateMatrixWorld(true);
  const expected = part.matrixWorld.clone();
  art.batchMeshes(parent); parent.updateMatrixWorld(true);
  const batch = parent.children.find(child => child instanceof THREE.InstancedMesh) as THREE.InstancedMesh;
  const local = new THREE.Matrix4(); batch.getMatrixAt(0, local);
  const actual = batch.matrixWorld.clone().multiply(local);
  expected.elements.forEach((value, i) => assert.ok(Math.abs(value - actual.elements[i]) < 1e-6));
  parent.position.x += 2; parent.updateMatrixWorld(true);
  assert.ok(Math.abs(batch.matrixWorld.clone().multiply(local).elements[12] - expected.elements[12] - 2) < 1e-6);
  art.clear(parent); art.dispose();
});

test('不同地图上的同类物资复用几何体和标识材质，各实例互不影响', () => {
  const art = new ArtResources();
  for (const itemType of ['oxygen', 'battery', 'repair'] as const) {
    const definition = { id: itemType, type: 'supply' as const, name: itemType, position: { x: 2, y: 3 }, itemType, state: 'available', observedAt: 0, source: 'sensor' as const, scanned: true };
    const first = createProp(art, definition, true);
    const second = createProp(art, { ...definition, id: `other-${itemType}`, position: { x: 7, y: 8 } }, true);
    const firstParts = first.children as THREE.Mesh[], secondParts = second.children as THREE.Mesh[];
    firstParts.forEach((part, i) => { assert.equal(part.geometry, secondParts[i].geometry); assert.equal(part.material, secondParts[i].material); });
    assert.ok(firstParts.some(part => (part.material as THREE.MeshStandardMaterial).color.getHex() === colors[itemType]));
    first.position.x = 5; assert.equal(second.position.x, 0);
    art.clear(first); art.clear(second);
  }
  art.dispose();
});
