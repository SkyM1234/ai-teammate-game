import { StationRenderer } from '../../web/src/station-renderer.ts';
import { stationThemes } from '../../web/src/art/themes.ts';
import { galleryView } from './fixtures.ts';

let canvas = document.getElementById('map') as HTMLCanvasElement;
const theme = document.getElementById('theme') as HTMLSelectElement;
const layout = document.getElementById('layout') as HTMLSelectElement;
const state = document.getElementById('state') as HTMLInputElement;
let station = new StationRenderer(canvas, stationThemes.industrial);

function update() {
  station.update(galleryView(layout.value as 'square' | 'long', state.checked), null);
}
theme.addEventListener('change', () => {
  station.dispose();
  const replacement = canvas.cloneNode() as HTMLCanvasElement;
  canvas.replaceWith(replacement); canvas = replacement;
  station = new StationRenderer(canvas, stationThemes[theme.value as keyof typeof stationThemes]);
  update();
});
layout.addEventListener('change', update);
state.addEventListener('change', update);
document.getElementById('reset')!.addEventListener('click', () => station.reset());
document.getElementById('rotate')!.addEventListener('click', () => station.rotate());
document.getElementById('zoom-in')!.addEventListener('click', () => station.zoomBy(.25));
document.getElementById('zoom-out')!.addEventListener('click', () => station.zoomBy(-.25));
window.addEventListener('pagehide', () => station.dispose(), { once: true });
update();
