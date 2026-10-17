import * as THREE from 'three';
import { ArtResources } from './resources.ts';
import { wallHeightAt } from './dimensions.ts';
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
  const isWall = (x: number, y: number) => level.tiles[y]?.[x] === '#';
  const isBoundary = (x: number, y: number) => x === 0 || y === 0 || x === width - 1 || y === height - 1;
  const isHorizontal = (x: number, y: number) => isWall(x - 1, y) || isWall(x + 1, y);
  const cappedCells = new Set<number>();
  wallCells.forEach((cell, i) => {
    const boundary = cell.x === 0 || cell.y === 0 || cell.x === width - 1 || cell.y === height - 1;
    const wallHeight = wallHeightAt(level, cell);
    transform.position.copy(world(cell)); transform.position.y = wallHeight / 2;
    transform.scale.set(.998, wallHeight, .998); transform.updateMatrix();
    walls.setMatrixAt(i, transform.matrix);
    walls.setColorAt(i, new THREE.Color(boundary ? theme.wallOuter : theme.wallInner));
    // Wall cladding follows public floor-plan edges, never hidden gameplay objects.
    const cap = new THREE.Group(); cap.position.copy(world(cell));
    // Keep finishes together in short wall runs, independently of room names or areas.
    const horizontal = isHorizontal(cell.x, cell.y);
    const section = Math.floor((horizontal ? cell.x : cell.y) / 3);
    const variation = (section + (horizontal ? cell.y : cell.x) * 2) % 5;
    const finish = variation === 3 ? 'wall-ribbed' : 'wall-panel';
    const capColor = new THREE.Color(boundary ? theme.capOuter : theme.capInner)
      .lerp(new THREE.Color(boundary ? theme.wallOuter : theme.wallInner), .25).getHex();
    // Bridge cell joints with a single coping, stopping at a change of direction or height.
    if (!cappedCells.has(cell.y * width + cell.x)) {
      let length = 1;
      cappedCells.add(cell.y * width + cell.x);
      while (length < 3) {
        const x = cell.x + (horizontal ? length : 0), y = cell.y + (horizontal ? 0 : length);
        if (!isWall(x, y) || isBoundary(x, y) !== boundary || isHorizontal(x, y) !== horizontal || cappedCells.has(y * width + x)) break;
        cappedCells.add(y * width + x); length++;
      }
      const middle = (length - 1) / 2;
      art.box(cap, horizontal ? [length - .018, .052, .99] : [.99, .052, length - .018],
        [horizontal ? middle : 0, wallHeight + .012, horizontal ? 0 : middle], capColor);
      const detail = new THREE.Group();
      detail.position.set(horizontal ? middle : 0, wallHeight + .038, horizontal ? 0 : middle);
      detail.rotation.y = horizontal ? 0 : Math.PI / 2; cap.add(detail);
      if (length > 1) {
        for (const x of [-length / 2 + .14, length / 2 - .14]) {
          art.box(detail, [.065, .012, .62], [x, .006, 0], capColor, 'metal');
        }
        if ((section + cell.x + cell.y) % 3 === 0) {
          art.box(detail, [.62, .012, .45], [0, .007, 0], colors.dark, 'rubber');
          const hatch = art.box(detail, [.56, .018, .39], [0, .023, 0], capColor);
          if ((cell.x + cell.y) % 2 === 0) { hatch.rotation.z = .08; hatch.position.y += .018; }
          for (const x of [-.24, .24]) art.box(detail, [.04, .025, .12], [x, .035, 0], colors.steel, 'metal');
        }
      }
      if ((cell.x * 7 + cell.y * 11) % 9 < 2) {
        const soot = art.decal(detail, 'soot', [Math.min(length, 1.6), .95], [0, .008, 0]);
        soot.rotation.x = -Math.PI / 2;
        const scar = art.decal(detail, 'scar', [.65, .5], [.12, .01, .02]);
        scar.rotation.set(-Math.PI / 2, 0, .4);
      }
    }
    const sideColor = new THREE.Color(boundary ? theme.wallOuter : theme.wallInner)
      .lerp(new THREE.Color(boundary ? theme.capOuter : theme.capInner), .52).getHex();
    for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      if (isWall(cell.x + dx, cell.y + dz)) continue;
      const face = new THREE.Group();
      face.position.set(dx * .5, 0, dz * .5);
      face.rotation.y = Math.atan2(dx, dz); cap.add(face);
      const interior = !!level.tiles[cell.y + dz]?.[cell.x + dx];
      // Stable, cosmetic accident damage uses only public wall coordinates.
      const damage = (cell.x * 31 + cell.y * 17 + (dx + 1) * 7 + (dz + 1) * 13) % 19;
      const torn = interior && damage === 3;
      // A face is built front-on so the grain and fittings stay upright on all four sides.
      const panel = art.box(face, [torn ? .55 : .94, wallHeight * .64, .045], [torn ? -.17 : 0, wallHeight * .56, torn ? .1 : .015], sideColor);
      panel.material = art.surface(finish, sideColor);
      if (torn) {
        panel.rotation.set(0, -.16, .12);
        art.box(face, [.86, wallHeight * .6, .02], [0, wallHeight * .56, .012], colors.dark, 'rubber');
        for (const y of [.36, .7]) art.box(face, [.8, .035, .035], [0, wallHeight * y, .035], colors.steel, 'metal');
        for (const x of [.16, .25, .34]) {
          const conduit = art.tank(face, [.025, wallHeight * .43, .025], [x, wallHeight * .55, .045], 0x958368, 'metal');
          conduit.rotation.z = -.12;
        }
      }
      art.box(face, [1, .045, .075], [0, wallHeight * .94, .025], capColor, 'metal');
      art.box(face, [1, .025, .035], [0, wallHeight * .23, .018], colors.dark, 'rubber');
      art.box(face, [.98, wallHeight * .14, .065], [0, wallHeight * .12, .025], boundary ? theme.wallOuter : theme.wallInner, 'metal');
      if (interior) {
        const contact = art.decal(face, 'contact', [1.12, .32], [0, .008, .08]);
        contact.rotation.x = -Math.PI / 2;
      }
      if (damage < 5) {
        const soot = art.decal(face, 'soot', [.94, wallHeight * .95], [.08, wallHeight * .55, .042]);
        soot.rotation.z = damage * .4;
        if (!torn) {
          const scar = art.decal(face, 'scar', [.63, wallHeight * .55], [-.06, wallHeight * .59, .044]);
          scar.rotation.z = damage * .3;
        }
        if (interior) {
          const stain = art.decal(face, 'soot', [.9, .65], [.05, .01, .23]);
          stain.rotation.x = -Math.PI / 2;
        }
      }
      if (torn) {
        for (let n = 0; n < 3; n++) {
          const chip = art.box(face, [.08 + n * .03, .012, .045], [-.22 + n * .21, .025, .16 + n % 2 * .11], n % 2 ? sideColor : colors.steel, 'metal');
          chip.rotation.set(.12, n * 1.7, -.08);
        }
      }
      if (!torn && variation === 0 && (horizontal ? cell.x : cell.y) % 3 === 1) {
        art.box(face, [.58, .32, .055], [0, wallHeight * .61, .05], colors.dark, 'rubber');
        const vent = art.box(face, [.53, .27, .018], [0, wallHeight * .61, .084], sideColor);
        vent.material = art.surface('vent', sideColor);
      }
    }
    // L-shaped guards wrap exposed corners, including both sides of a free wall end.
    const neighbours = [[-1, 0], [1, 0], [0, -1], [0, 1]].filter(([dx, dz]) => isWall(cell.x + dx, cell.y + dz)).length;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      if (isWall(cell.x + sx, cell.y) || isWall(cell.x, cell.y + sz)) continue;
      art.box(cap, [.1, wallHeight - .12, .055], [sx * .47, wallHeight / 2, sz * .53], capColor, 'metal');
      art.box(cap, [.055, wallHeight - .12, .1], [sx * .53, wallHeight / 2, sz * .47], capColor, 'metal');
      if (neighbours === 1) {
        art.box(cap, [.105, .2, .06], [sx * .47, wallHeight * .3, sz * .535], colors.amber);
        art.box(cap, [.06, .2, .105], [sx * .535, wallHeight * .3, sz * .47], colors.amber);
        for (const y of [-.055, .025]) {
          art.box(cap, [.11, .025, .065], [sx * .47, wallHeight * .3 + y, sz * .54], colors.dark);
          art.box(cap, [.065, .025, .11], [sx * .54, wallHeight * .3 + y, sz * .47], colors.dark);
        }
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
