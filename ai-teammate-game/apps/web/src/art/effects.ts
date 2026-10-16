import * as THREE from 'three';
import { ArtResources } from './resources.ts';
import { colors } from './themes.ts';

export function buildReticle(art: ArtResources, group: THREE.Group, color: number, size: number) {
  for (const x of [-1, 1]) for (const z of [-1, 1]) {
    art.glow(group, [.25, .025, .045], [x * (size / 2 - .1), .075, z * size / 2], color);
    art.glow(group, [.045, .025, .25], [x * size / 2, .075, z * (size / 2 - .1)], color);
  }
}

export function createExitLeak(art: ArtResources) {
  const group = new THREE.Group();
  const sprites: THREE.Sprite[] = [];
  group.name = 'exit-leak'; group.visible = false;
  buildReticle(art, group, colors.red, .95);
  const texture = art.gasTexture();
  for (let i = 0; i < 18; i++) {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    sprites.push(sprite); group.add(sprite);
  }
  art.label(group, '漏气 · 禁入', '#ffb298', 1.9, .55);
  return { group, sprites };
}
