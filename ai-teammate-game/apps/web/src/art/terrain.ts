import * as THREE from 'three';
import { ArtResources } from './resources.ts';
import { colors, roomColors } from './themes.ts';
import type { StationTheme } from './themes.ts';
import type { PlayerView, Position } from '../../../../packages/game-core/src/types.ts';

export function createTerrain(art: ArtResources, level: PlayerView['level'], theme: StationTheme) {
  const terrain = new THREE.Group();
  const roomLabels: THREE.Sprite[] = [];
  const { width, height } = level;
  const world = (p: Position) => new THREE.Vector3(p.x - (width - 1) / 2, 0, p.y - (height - 1) / 2);
  const count = width * height;
  const floor = new THREE.InstancedMesh(art.deck, art.surface('deck', 0xffffff), count);
  floor.receiveShadow = true;
  terrain.add(floor);
  const wallCells: Position[] = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (level.tiles[y][x] === '#') wallCells.push({ x, y });
  }
  const walls = new THREE.InstancedMesh(art.cube, art.material(0xffffff), wallCells.length);
  walls.castShadow = true; walls.receiveShadow = true;
  terrain.add(walls);
  const transform = new THREE.Object3D();
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    transform.position.copy(world({ x, y })); transform.position.y = -.075;
    transform.scale.set(.998, .15, .998); transform.updateMatrix();
    floor.setMatrixAt(y * width + x, transform.matrix);
    if (level.tiles[y][x] === '#') continue;
    const plate = new THREE.Group(); plate.position.copy(world({ x, y }));
    // Two-by-two inspection plates span movement cells; cell colors still show sensor knowledge.
    if (x % 2 === 0 && level.tiles[y][x + 1] !== '#' && x + 1 < width) {
      art.box(plate, [.012, .006, 1], [.5, .003, 0], 0x35483e);
      art.box(plate, [.008, .004, 1], [.518, .002, 0], 0x77877a);
    }
    if (y % 2 === 0 && level.tiles[y + 1]?.[x] !== '#' && y + 1 < height) {
      art.box(plate, [1, .006, .012], [0, .003, .5], 0x35483e);
      art.box(plate, [1, .004, .008], [0, .002, .518], 0x77877a);
    }
    if (x % 2 === 1 && y % 2 === 1) {
      art.box(plate, [.15, .009, .055], [-.33, .006, -.35], colors.steel);
      art.box(plate, [.09, .012, .018], [-.33, .012, -.35], colors.dark);
    }
    for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      if (level.tiles[y + dz]?.[x + dx] !== '#') continue;
      art.box(plate, dx ? [.1, .035, 1] : [1, .035, .1], [dx * .45, .02, dz * .45], 0x718174);
    }
    terrain.add(plate);
  }
  wallCells.forEach((cell, i) => {
    const boundary = cell.x === 0 || cell.y === 0 || cell.x === width - 1 || cell.y === height - 1;
    const wallHeight = boundary ? .34 : .55;
    transform.position.copy(world(cell)); transform.position.y = wallHeight / 2;
    transform.scale.set(.998, wallHeight, .998); transform.updateMatrix();
    walls.setMatrixAt(i, transform.matrix);
    walls.setColorAt(i, new THREE.Color(boundary ? theme.wallOuter : theme.wallInner));
    // Wall cladding follows public floor-plan edges, never hidden gameplay objects.
    const cap = new THREE.Group(); cap.position.copy(world(cell));
    art.box(cap, [.99, .065, .99], [0, wallHeight + .018, 0], boundary ? theme.capOuter : theme.capInner);
    if ((cell.x + cell.y) % 3 === 0) {
      const vent = art.box(cap, [.61, .018, .55], [0, wallHeight + .058, 0], colors.steel);
      vent.material = art.surface('vent', theme.capOuter);
    }
    for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      if (!level.tiles[cell.y + dz]?.[cell.x + dx] || level.tiles[cell.y + dz][cell.x + dx] === '#') continue;
      art.box(cap, dx ? [.06, wallHeight * .7, .82] : [.82, wallHeight * .7, .06], [dx * .51, wallHeight * .48, dz * .51], colors.steel);
      art.box(cap, dx ? [.075, .035, .92] : [.92, .035, .075], [dx * .52, wallHeight * .82, dz * .52], colors.ivory);
      if ((cell.x + cell.y) % 2 === 0) {
        art.box(cap, dx ? [.09, wallHeight * .85, .085] : [.085, wallHeight * .85, .09], [dx * .535, wallHeight / 2, dz * .535], colors.dark);
      }
    }
    if ((cell.x * 3 + cell.y) % 7 === 0) {
      art.box(cap, [.32, .014, .09], [0, wallHeight + .061, .32], colors.amber);
      for (const x of [-.09, .03]) {
        const stripe = art.box(cap, [.04, .016, .1], [x, wallHeight + .064, .32], colors.dark); stripe.rotation.y = -.5;
      }
    }
    terrain.add(cap);
  });
  art.box(terrain, [width + .38, .37, height + .38], [0, -.35, 0], colors.dark);
  art.box(terrain, [width + .52, .075, height + .52], [0, -.58, 0], 0x60684a);
  for (const sign of [-1, 1]) {
    art.box(terrain, [width + .3, .08, .065], [0, -.22, sign * (height / 2 + .17)], 0x7e8764);
    art.box(terrain, [.065, .08, height + .3], [sign * (width / 2 + .17), -.22, 0], 0x7e8764);
    const halfWidth = Math.max(0, Math.floor(width / 2) - 2);
    const halfHeight = Math.max(0, Math.floor(height / 2) - 2);
    for (let n = -halfWidth; n <= halfWidth; n += 2) {
      art.glow(terrain, [.21, .055, .035], [n, -.36, sign * (height / 2 + .21)], 0x8b9540);
    }
    for (let n = -halfHeight; n <= halfHeight; n += 2) {
      art.glow(terrain, [.035, .055, .21], [sign * (width / 2 + .21), -.36, n], 0x8b9540);
    }
  }
  const exit = new THREE.Group(); exit.position.copy(world(level.exit));
  art.box(exit, [.87, .04, .87], [0, .035, 0], colors.dark);
  for (const x of [-.29, .29]) art.glow(exit, [.055, .02, .64], [x, .07, 0], colors.signal);
  for (const z of [-.27, .27]) art.glow(exit, [.28, .02, .045], [0, .07, z], colors.signal);
  art.label(exit, 'EXIT', '#e5ed91', .52, .48);
  terrain.add(exit);
  level.rooms.forEach((room, index) => {
    const { minX, minY, maxX, maxY } = room.bounds;
    const width = maxX - minX + 1, height = maxY - minY + 1;
    const color = roomColors[index % roomColors.length];
    const group = new THREE.Group(); group.name = `room:${room.name}`;
    group.position.copy(world({ x: (minX + maxX) / 2, y: (minY + maxY) / 2 }));
    for (const side of [-1, 1]) {
      art.glow(group, [width - .4, .012, .035], [0, .065, side * (height / 2 - .2)], color);
      art.glow(group, [.035, .012, height - .4], [side * (width / 2 - .2), .065, 0], color);
    }
    const label = art.label(group, room.name, `#${color.toString(16).padStart(6, '0')}`, .15);
    if (width <= 2 && height <= 2) label.position.z = height / 2 + .5;
    roomLabels.push(label);
    terrain.add(group);
  });
  for (const [text, position] of [['N', { x: width / 2 - .5, y: -.9 }], ['E', { x: width + .3, y: height / 2 - .5 }]] as const) {
    const label = new THREE.Group(); label.position.copy(world(position));
    art.label(label, text, '#8d9976', 0, .38); terrain.add(label);
  }
  art.batchMeshes(terrain);

  return { group: terrain, floor, walls, wallCells, roomLabels };
}
