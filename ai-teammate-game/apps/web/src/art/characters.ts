import * as THREE from 'three';
import { ArtResources } from './resources.ts';
import { colors } from './themes.ts';

export function createRobot(art: ArtResources) {
  const robot = new THREE.Group();
  for (const x of [-.27, .27]) {
    art.box(robot, [.23, .25, .65], [x, .17, 0], colors.dark, 'rubber');
    for (const z of [-.2, 0, .2]) {
      const wheel = art.tank(robot, [.17, .025, .17], [x * 1.43, .17, z], colors.steel, 'metal');
      wheel.rotation.z = Math.PI / 2;
    }
    for (const z of [-.24, -.12, 0, .12, .24]) art.box(robot, [.235, .025, .045], [x, .3, z], colors.steel);
    art.box(robot, [.2, .08, .51], [x, .34, 0], colors.rescue);
    art.ball(robot, [.17, .17, .17], [x * 1.3, .66, 0], colors.steel);
    const arm = art.box(robot, [.12, .25, .16], [x * 1.42, .5, .035], colors.ivory);
    arm.rotation.z = -Math.sign(x) * .16;
    art.box(robot, [.13, .08, .17], [x * 1.48, .37, .065], colors.dark);
    for (const dz of [-.055, .055]) art.box(robot, [.08, .1, .04], [x * 1.48, .3, .075 + dz], colors.steel);
  }
  art.box(robot, [.55, .16, .43], [0, .34, 0], colors.steel);
  art.box(robot, [.5, .32, .36], [0, .57, 0], colors.ivory);
  const breastplate = art.box(robot, [.42, .23, .065], [0, .58, .19], colors.steel);
  breastplate.rotation.x = -.18;
  art.glow(robot, [.2, .035, .025], [0, .61, .235], colors.visor);
  art.box(robot, [.31, .29, .16], [0, .55, -.25], colors.dark);
  for (const x of [-.1, .1]) art.tank(robot, [.1, .26, .1], [x, .55, -.34], colors.steel);
  art.tank(robot, [.18, .09, .18], [0, .77, 0], colors.dark);
  art.box(robot, [.5, .25, .39], [0, .92, .025], colors.ivory);
  art.box(robot, [.43, .13, .04], [0, .93, .225], colors.dark, 'glass');
  art.glow(robot, [.3, .06, .02], [0, .94, .252], colors.visor);
  art.box(robot, [.41, .035, .32], [0, 1.06, .025], colors.rescue);
  art.box(robot, [.09, .012, .25], [0, 1.084, .025], colors.ivory);
  art.tank(robot, [.03, .18, .03], [.18, 1.15, -.065], colors.steel);
  art.ball(robot, [.065, .065, .065], [.18, 1.26, -.065], colors.signal);
  art.label(robot, 'R-07', '#e5ed78', 1.52, .62);
  art.batchMeshes(robot);
  return robot;
}

export function createHuman(art: ArtResources) {
  const human = new THREE.Group();
  art.box(human, [.61, .07, .97], [0, .08, .01], colors.dark);
  art.box(human, [.45, .07, .79], [0, .15, .01], colors.medical, 'rubber');
  for (const x of [-.27, .27]) {
    art.tank(human, [.045, .94, .045], [x, .15, .01], colors.ivory, 'metal').rotation.x = Math.PI / 2;
    for (const z of [-.39, .39]) art.box(human, [.06, .08, .13], [x, .1, z], colors.dark);
  }
  art.box(human, [.34, .18, .4], [0, .27, .06], colors.ivory);
  for (const z of [-.03, .23]) art.box(human, [.37, .035, .065], [0, .37, z], colors.medical, 'rubber');
  art.box(human, [.17, .015, .05], [0, .37, .1], colors.medical);
  art.box(human, [.05, .016, .14], [0, .37, .1], colors.medical);
  art.ball(human, [.28, .25, .28], [0, .3, -.3], colors.ivory);
  art.box(human, [.21, .1, .035], [0, .33, -.433], colors.dark, 'glass');
  art.glow(human, [.07, .025, .025], [.07, .4, -.41], colors.amber);
  for (const x of [-.14, .14]) {
    art.box(human, [.13, .12, .25], [x, .23, .4], colors.dark);
    art.box(human, [.1, .12, .34], [x * 1.9, .23, .05], colors.steel);
  }
  art.label(human, 'YOU', '#e5c294', .85, .55);
  art.batchMeshes(human);
  return human;
}

