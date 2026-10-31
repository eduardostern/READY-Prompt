/**
 * READY-Prompt's page: the C64 in the monitor, and the panels for the
 * machine, display and controls around it.
 */
import './style.css';
import basicUrl from './roms/basic.901226-01.bin?url';
import kernalUrl from './roms/kernal.901227-03.bin?url';
import chargenUrl from './roms/characters.901225-01.bin?url';
import { C64, type Model } from './c64/machine';
import { KeyInput } from './c64/keyboard';
import { WIDTH } from './c64/vic';
import { audioContext } from './ui/audio';
import { waitForPower, warmUp } from './ui/power';
import { SoundOut } from './ui/sound-out';
import type { SidModel } from './c64/sid';

const SAMPLE_RATE = 44100;
const SETTINGS_KEY = 'ready-prompt.settings';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ---- settings ---------------------------------------------------------------

interface Settings {
  model: Model;
  speed: number;
  smooth: boolean;
  scanlines: boolean;
  curve: boolean;
  flicker: boolean;
  humbar: boolean;
  autoPower: boolean;
  volume: number;
  sid: SidModel;
}

const DEFAULTS: Settings = {
  model: 'pal', speed: 1, smooth: false, scanlines: true, curve: true, flicker: false, humbar: false, autoPower: false,
  volume: 70, sid: '6581',
};

function loadSettings(): Settings {
  try {
    const s = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') };
    if (s.model !== 'pal' && s.model !== 'ntsc') s.model = 'pal';
    if (s.sid !== '6581' && s.sid !== '8580') s.sid = '6581';
    return s;
  } catch {
    return { ...DEFAULTS };
  }
}

const settings = loadSettings();
const save = () => {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* storage blocked: settings last for this visit */
  }
};

async function bytes(url: string): Promise<Uint8Array> {
  return new Uint8Array(await (await fetch(url)).arrayBuffer());
}

// ---- start ------------------------------------------------------------------

async function start(): Promise<void> {
  const [basic, kernal, chargen] = await Promise.all([bytes(basicUrl), bytes(kernalUrl), bytes(chargenUrl)]);
  const c64 = new C64({ basic, kernal, chargen });
  if (settings.model !== 'pal') c64.setModel(settings.model);
  c64.setSidModel(settings.sid);
  const sound = new SoundOut(SAMPLE_RATE);
  const keys = new KeyInput(held => c64.setKeys(held));
  keys.onRestore = down => { c64.restore = down; };

  const wrap = $('screen-wrap');
  const canvas = $<HTMLCanvasElement>('screen');
  const g = canvas.getContext('2d')!;
  let image = g.createImageData(WIDTH, c64.timing.height);
  let pixels = new Uint32Array(image.data.buffer);
  const fitCanvas = () => {
    const h = c64.timing.height;
    if (canvas.height === h) return;
    canvas.height = h;
    image = g.createImageData(WIDTH, h);
    pixels = new Uint32Array(image.data.buffer);
  };
  let running = false;

  const draw = () => {
    pixels.set(c64.vic.frame);
    g.putImageData(image, 0, 0);
  };
  const blank = () => {
    g.fillStyle = '#000';
    g.fillRect(0, 0, canvas.width, canvas.height);
  };
  blank();

  // ---- machine panel -------------------------------------------------------

  const applyModel = () => {
    document.body.classList.toggle('pal', settings.model === 'pal');
    document.body.classList.toggle('ntsc', settings.model === 'ntsc');
    fitCanvas();
  };
  applyModel();
  const model = $<HTMLSelectElement>('model');
  model.value = settings.model;
  model.addEventListener('change', () => {
    settings.model = model.value as Model;
    save();
    c64.setModel(settings.model);
    applyModel();
    if (!running) blank();
  });

  const flags: (keyof Settings)[] = ['smooth', 'scanlines', 'curve', 'flicker', 'humbar'];
  const applyLook = () => {
    for (const f of flags) document.body.classList.toggle(f, Boolean(settings[f]));
    sound.volume = settings.volume / 100;
  };
  const bindCheck = (id: string, key: keyof Settings) => {
    const box = $<HTMLInputElement>(id);
    box.checked = Boolean(settings[key]);
    box.addEventListener('change', () => {
      (settings[key] as boolean) = box.checked;
      save();
      applyLook();
    });
  };
  for (const f of flags) bindCheck(f, f);
  bindCheck('auto-power', 'autoPower');
  const volume = $<HTMLInputElement>('volume');
  volume.value = String(settings.volume);
  volume.addEventListener('input', () => { settings.volume = Number(volume.value); save(); applyLook(); });
  const sid = $<HTMLSelectElement>('sid');
  sid.value = settings.sid;
  sid.addEventListener('change', () => { settings.sid = sid.value as SidModel; save(); c64.setSidModel(settings.sid); });
  const speed = $<HTMLSelectElement>('speed');
  speed.value = String(settings.speed);
  speed.addEventListener('change', () => { settings.speed = Number(speed.value); save(); });
  applyLook();

  $('fullscreen').addEventListener('click', () => {
    const m = document.querySelector('.monitor') as HTMLElement;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void m.requestFullscreen?.();
  });

  // ---- power ---------------------------------------------------------------

  const powerBtn = $('power');
  const lamp = $('power-lamp');
  const showPower = () => {
    powerBtn.setAttribute('aria-pressed', String(running));
    lamp.classList.toggle('on', running);
  };
  const powerOn = async () => {
    audioContext();
    c64.reset(true);
    sessionStorage.setItem('ready-prompt.warm', '1');
    await warmUp(wrap, settings.model === 'pal');
    running = true;
    showPower();
  };
  powerBtn.addEventListener('click', async () => {
    if (running) {
      running = false;
      blank();
      showPower();
    } else await powerOn();
  });
  $('reset').addEventListener('click', () => {
    c64.reset();
    if (!running) void powerOn();
  });

  // ---- keyboard ------------------------------------------------------------

  const typing = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    return Boolean(t?.closest('input, select, textarea, dialog'));
  };
  window.addEventListener('keydown', e => {
    if (typing(e) || e.metaKey || !running) return;
    if (keys.keyDown(e.code, e.key)) e.preventDefault();
  });
  window.addEventListener('keyup', e => keys.keyUp(e.code));
  window.addEventListener('blur', () => { keys.releaseAll(); c64.restore = false; });

  // ---- the frame loop ------------------------------------------------------

  let last = performance.now();
  let owed = 0;
  let statFrames = 0;
  let statTime = last;
  const fps = $('fps');
  const mhz = $('mhz');
  const loop = (now: number) => {
    requestAnimationFrame(loop);
    const t = c64.timing;
    const FRAME_MS = (1000 * t.cyclesPerLine * t.lines) / c64.clockHz;
    owed += Math.min(now - last, 250);
    last = now;
    if (!running) { owed = 0; return; }
    let ran = 0;
    const most = 4 * settings.speed;
    while (owed >= FRAME_MS / settings.speed && ran < most) {
      owed -= FRAME_MS / settings.speed;
      c64.runFrame();
      const samples = c64.takeAudio();
      if (settings.speed === 1) sound.play(samples);
      ran++;
    }
    if (ran === most) owed = 0; // the host fell behind: do not try to catch up
    if (ran) draw();
    statFrames += ran;
    if (now - statTime >= 1000) {
      const f = (statFrames * 1000) / (now - statTime);
      fps.textContent = `${f.toFixed(0)} / s`;
      mhz.textContent = `${((f * t.cyclesPerLine * t.lines) / 1e6).toFixed(2)} MHz`;
      statFrames = 0;
      statTime = now;
    }
  };
  requestAnimationFrame(loop);

  // ---- first power-on ------------------------------------------------------

  showPower();
  if (settings.autoPower || sessionStorage.getItem('ready-prompt.warm') === '1') {
    await powerOn();
  } else {
    await waitForPower(wrap);
    await powerOn();
  }
}

void start();
