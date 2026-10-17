import * as THREE from 'three';
import { ArtResources } from './resources.ts';
import { colors } from './themes.ts';
import { wallHeights } from './dimensions.ts';
import type { ObservedEntity } from '../../../../packages/game-core/src/types.ts';

export function createProp(art: ArtResources, entity: ObservedEntity, sensed: boolean, wallHeight = wallHeights.inner) {
  const group = new THREE.Group();
  group.name = `observed:${entity.id}`;
  const steel = sensed ? 0xa3b0a2 : 0x617567;
  if (entity.type === 'supply') {
    if (entity.itemType === 'oxygen') {
      art.box(group, [.55, .07, .4], [0, .075, 0], colors.dark);
      for (const x of [-.14, .14]) {
        art.tank(group, [.22, .38, .22], [x, .34, 0], colors.ivory);
        art.ball(group, [.22, .15, .22], [x, .53, 0], colors.oxygen);
        art.ball(group, [.22, .13, .22], [x, .15, 0], colors.ivory);
        art.tank(group, [.23, .12, .23], [x, .43, 0], colors.oxygen);
        art.tank(group, [.07, .09, .07], [x, .63, 0], colors.dark, 'metal');
        art.box(group, [.14, .025, .04], [x, .68, 0], colors.oxygen);
        art.box(group, [.08, .11, .02], [x, .26, .115], colors.oxygen);
      }
      art.box(group, [.44, .04, .035], [0, .39, .14], colors.dark);
      art.box(group, [.44, .04, .035], [0, .39, -.14], colors.dark);
    } else {
      if (entity.itemType === 'repair') {
        art.box(group, [.64, .31, .46], [0, .24, 0], colors.repair);
        art.box(group, [.66, .085, .48], [0, .44, 0], colors.repair);
        art.box(group, [.5, .025, .035], [0, .39, .244], colors.dark);
        for (const x of [-.23, .23]) art.box(group, [.065, .15, .035], [x, .39, .26], colors.dark);
        art.box(group, [.26, .045, .06], [0, .58, 0], colors.dark, 'rubber');
        for (const x of [-.1, .1]) art.box(group, [.04, .11, .06], [x, .52, 0], colors.dark);
        art.box(group, [.2, .045, .025], [0, .25, .245], colors.dark);
        art.box(group, [.045, .15, .025], [0, .25, .249], colors.dark);
        art.box(group, [.26, .015, .07], [0, .49, .13], colors.dark);
        art.box(group, [.07, .016, .2], [0, .49, .13], colors.dark);
      } else {
        art.box(group, [.45, .5, .35], [0, .33, 0], colors.dark, 'rubber');
        for (const x of [-.21, .21]) art.box(group, [.075, .47, .39], [x, .33, 0], steel);
        art.box(group, [.36, .24, .025], [0, .33, .19], colors.battery);
        art.box(group, [.38, .07, .38], [0, .6, 0], colors.battery);
        for (const x of [-.11, .11]) art.tank(group, [.07, .065, .07], [x, .67, 0], colors.ivory, 'metal');
        art.box(group, [.16, .015, .04], [0, .65, .1], colors.dark);
        art.box(group, [.04, .016, .14], [0, .65, .1], colors.dark);
        for (const x of [-.09, 0, .09]) art.glow(group, [.04, .07, .025], [x, .32, .215], colors.ivory);
      }
    }
  } else if (entity.type === 'door') {
    group.rotation.y = entity.orientation === 'horizontal' ? 0 : Math.PI / 2;
    // Parts are authored at 1.2 units; only their vertical scale follows the wall height.
    group.scale.y = wallHeight / 1.2;
    art.box(group, [1.02, .045, .98], [0, .035, 0], colors.dark, 'rubber');
    art.box(group, [.71, .018, .9], [0, .065, 0], steel, 'metal');
    for (const z of [-.32, -.16, 0, .16, .32]) art.box(group, [.65, .008, .018], [0, .078, z], colors.dark);
    for (const x of [-.43, .43]) {
      art.box(group, [.14, 1.08, .98], [x, .59, 0], steel);
      for (const side of [-1, 1]) {
        art.box(group, [.12, 1.02, .035], [x, .59, side * .51], colors.ivory);
        art.box(group, [.055, .65, .025], [x, .58, side * .537], colors.dark, 'rubber');
        art.box(group, [.12, .17, .045], [x, .23, side * .536], colors.amber);
        for (const y of [.19, .25]) art.box(group, [.125, .025, .05], [x, y, side * .54], colors.dark);
        art.box(group, [.1, .18, .05], [x, .78, side * .54], colors.dark);
        art.glow(group, [.035, .065, .018], [x, .8, side * .575], entity.state === 'opened' ? colors.signal : colors.amber);
        // Gouges in the frame retain the same position when the door opens.
        const scratch = art.box(group, [.1, .013, .008], [x, .95, side * .534], colors.steel, 'metal');
        scratch.rotation.z = x > 0 ? -.28 : .4;
      }
    }
    art.box(group, [1.18, .12, 1.0], [0, 1.17, 0], steel);
    art.box(group, [1.2, .038, 1.015], [0, 1.219, 0], colors.ivory);
    art.box(group, [.62, .012, .32], [0, 1.244, 0], steel);
    for (const x of [-.26, .26]) art.box(group, [.035, .014, .1], [x, 1.255, 0], colors.dark, 'metal');
    for (const side of [-1, 1]) {
      art.box(group, [.73, .075, .035], [0, 1.16, side * .52], colors.dark, 'rubber');
      art.glow(group, [.34, .028, .018], [0, 1.17, side * .545], entity.state === 'opened' ? colors.signal : colors.amber);
    }
    for (const sign of [-1, 1]) {
      const opened = entity.state === 'opened', x = sign * (opened ? .35 : .18);
      art.box(group, [opened ? .055 : .35, .99, .16], [x, .585, 0], steel);
      for (const side of [-1, 1]) {
        art.box(group, [.025, .89, .025], [sign * (opened ? .325 : .018), .58, side * .09], colors.dark, 'rubber');
        if (!opened) {
          art.box(group, [.25, .055, .025], [x, .62, side * .095], colors.dark);
          for (const offset of [-.1, .02]) {
            const scratch = art.box(group, [.16, .01, .008], [x, .4 + offset, side * .088], colors.ivory, 'metal');
            scratch.rotation.z = -.6;
          }
        }
      }
    }
  } else if (entity.type === 'cabinet') {
    art.box(group, [.68, .91, .5], [0, .51, 0], steel);
    art.box(group, [.53, .77, .045], [0, .52, .265], colors.dark);
    for (const x of [-.3, .3]) art.box(group, [.05, .82, .04], [x, .5, .29], colors.ivory);
    if (entity.state === 'opened') {
      for (const y of [.3, .55]) art.box(group, [.48, .025, .16], [0, y, .29], colors.ivory);
      const door = art.box(group, [.49, .77, .045], [.39, .52, .45], steel); door.rotation.y = -.95;
    } else {
      const face = art.box(group, [.52, .77, .04], [0, .52, .3], steel);
      face.material = art.surface('vent', steel);
      art.box(group, [.04, .2, .05], [.17, .48, .345], colors.dark);
    }
    art.glow(group, [.12, .035, .03], [-.13, .85, .33], colors.signal);
    art.box(group, [.71, .07, .53], [0, 1.01, 0], colors.dark);
    art.box(group, [.71, .07, .53], [0, .06, 0], colors.dark);
  } else if (entity.type === 'obstacle') {
    const bar = art.box(group, [.87, .16, .24], [0, .19, 0], steel); bar.rotation.y = .6;
    const beam = art.box(group, [.19, .31, .7], [.08, .23, .08], 0x7e8267); beam.rotation.z = .35;
    art.box(group, [.3, .2, .3], [-.23, .17, -.2], colors.dark);
    const stripe = art.box(group, [.26, .018, .2], [0, .286, 0], colors.amber); stripe.rotation.y = .6;
    const panel = art.box(group, [.47, .035, .36], [-.18, .33, -.05], steel); panel.rotation.set(.3, -.5, .25);
    for (const z of [-.24, .24]) {
      const brace = art.box(group, [.72, .06, .06], [0, .13, z], colors.dark); brace.rotation.y = .6;
    }
  } else if (entity.type === 'hazard') {
    art.box(group, [.77, .065, .62], [0, .07, 0], colors.dark);
    for (const x of [-.31, .31]) art.box(group, [.09, .03, .57], [x, .12, 0], colors.amber);
    for (let i = 0; i < 3; i++) {
      const x = -.18 + i * .18;
      const cable = art.tank(group, [.055, .47, .055], [x, .16, 0], steel); cable.rotation.set(Math.PI / 2, 0, -.12);
      for (const z of [-.21, .21]) art.box(group, [.09, .09, .075], [x, .16, z], colors.ivory);
      art.glow(group, [.07, .05, .09], [x, .18, .07], entity.state === 'active' ? colors.red : 0x657147);
    }
  } else if (entity.type === 'airlock') {
    art.box(group, [.74, .13, .57], [0, .1, 0], colors.dark);
    art.box(group, [.5, .53, .4], [0, .43, 0], steel);
    art.box(group, [.38, .29, .035], [0, .39, .22], colors.dark);
    for (const x of [-.29, .29]) art.tank(group, [.07, .48, .07], [x, .4, -.06], colors.ivory);
    const console = new THREE.Group(); console.position.set(0, .79, .06); console.rotation.x = -.3;
    art.box(console, [.65, .39, .1], [0, 0, 0], colors.ivory);
    art.box(console, [.55, .29, .025], [0, .015, .06], colors.dark);
    const status = entity.state === 'repaired' ? colors.signal : colors.amber;
    art.glow(console, [.36, .1, .02], [-.04, .04, .08], status);
    for (let i = 0; i < 3; i++) art.glow(console, [.04, .025, .02], [.21, .08 - i * .055, .08], status);
    art.box(console, [.3, .018, .02], [-.04, -.06, .08], colors.steel);
    group.add(console);
    const keyboard = art.box(group, [.6, .055, .2], [0, .61, .23], colors.dark); keyboard.rotation.x = -.15;
    for (const x of [-.18, -.06, .06, .18]) art.box(group, [.065, .02, .07], [x, .65, .25], colors.ivory);
    art.box(group, [.52, .04, .03], [0, .29, .245], colors.amber);
  } else {
    art.box(group, [.61, .08, .46], [0, .075, 0], colors.dark);
    art.box(group, [.55, .57, .38], [0, .37, 0], steel);
    art.box(group, [.43, .41, .04], [0, .38, .215], colors.ivory);
    art.box(group, [.28, .23, .025], [0, .41, .25], colors.dark);
    art.tank(group, [.16, .035, .16], [0, .42, .28], colors.steel).rotation.x = Math.PI / 2;
    const handle = art.box(group, [.055, .21, .065], [0, .43, .32], colors.dark);
    handle.rotation.z = entity.state === 'on' ? -.6 : .6;
    art.ball(group, [.1, .1, .1], [entity.state === 'on' ? .06 : -.06, .515, .32], colors.amber);
    art.glow(group, [.15, .035, .025], [0, .23, .25], entity.state === 'on' ? colors.signal : colors.amber);
    art.box(group, [.6, .065, .43], [0, .69, 0], colors.dark);
  }
  return group;
}
