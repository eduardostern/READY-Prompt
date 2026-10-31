/**
 * READY-Prompt's page: the C64 in the monitor, the drives and the keyboard
 * under it, and the panels for the machine, display, sound and controls.
 */
import './style.css';
import { unzipSync } from 'fflate';
import basicUrl from './roms/basic.901226-01.bin?url';
import kernalUrl from './roms/kernal.901227-03.bin?url';
import chargenUrl from './roms/characters.901225-01.bin?url';
import { C64, JOY_DOWN, JOY_FIRE, JOY_LEFT, JOY_RIGHT, JOY_UP, type Model } from './c64/machine';
import { KeyInput, KEYS, type Key } from './c64/keyboard';
import { LAYOUT, MODIFIERS } from './c64/legend';
import { ListingError, tokenize } from './c64/basic';
import { fromP00, injectPrg, prgName } from './c64/prg';
import type { SidModel } from './c64/sid';
import { WIDTH } from './c64/vic';
import { audioContext } from './ui/audio';
import { askConfirm } from './ui/confirm';
import { waitForPower, warmUp } from './ui/power';
import { SoundOut } from './ui/sound-out';
import { loadDisk, saveDisk, loadShelf, loadTape, saveTape, shelve, type StoredFile, unshelve } from './ui/store';
import { Tape } from './c64/tape';
import { D64, nameString } from './c64/disk';

const SAMPLE_RATE = 44100;
const MAX_FILE = 4 * 1024 * 1024;
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
  /** The port the arrow keys and gamepad drive: 2, 1, or 0 for none. */
  joystick: number;
  keyboard: boolean;
  fastTape: boolean;
  turboTape: boolean;
}

const DEFAULTS: Settings = {
  model: 'pal', speed: 1, smooth: false, scanlines: true, curve: true, flicker: false, humbar: false, autoPower: false,
  volume: 70, sid: '6581', joystick: 2, keyboard: false, fastTape: true, turboTape: true,
};

function loadSettings(): Settings {
  try {
    const s = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') };
    if (s.model !== 'pal' && s.model !== 'ntsc') s.model = 'pal';
    if (s.sid !== '6581' && s.sid !== '8580') s.sid = '6581';
    if (![0, 1, 2].includes(s.joystick)) s.joystick = 2;
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
    c64.fastTape = settings.fastTape;
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
  bindCheck('fast-tape', 'fastTape');
  bindCheck('turbo-tape', 'turboTape');
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
  /** Makes sure the machine is on (without resetting it if it is). */
  const ensureOn = async () => { if (!running) await powerOn(); };
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

  // ---- keyboard and joystick -----------------------------------------------

  const stick = { up: false, down: false, left: false, right: false, fire: false };
  const STICK_KEYS: Record<string, keyof typeof stick> = {
    ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', ControlRight: 'fire',
  };
  let padBits = 0;
  const applyStick = () => {
    const bits = (stick.up ? JOY_UP : 0) | (stick.down ? JOY_DOWN : 0) | (stick.left ? JOY_LEFT : 0) |
      (stick.right ? JOY_RIGHT : 0) | (stick.fire ? JOY_FIRE : 0) | padBits;
    c64.joy1 = settings.joystick === 1 ? bits : 0;
    c64.joy2 = settings.joystick === 2 ? bits : 0;
  };
  const typing = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    return Boolean(t?.closest('input, select, textarea, dialog'));
  };
  window.addEventListener('keydown', e => {
    if (typing(e) || e.metaKey || !running) return;
    if (settings.joystick && STICK_KEYS[e.code]) {
      stick[STICK_KEYS[e.code]] = true;
      applyStick();
      e.preventDefault();
      return;
    }
    if (keys.keyDown(e.code, e.key)) e.preventDefault();
  });
  window.addEventListener('keyup', e => {
    if (settings.joystick && STICK_KEYS[e.code]) {
      stick[STICK_KEYS[e.code]] = false;
      applyStick();
      return;
    }
    keys.keyUp(e.code);
  });
  window.addEventListener('blur', () => {
    keys.releaseAll();
    c64.restore = false;
    for (const k of Object.keys(stick) as (keyof typeof stick)[]) stick[k] = false;
    applyStick();
  });
  const joystick = $<HTMLSelectElement>('joystick');
  joystick.value = String(settings.joystick);
  joystick.addEventListener('change', () => { settings.joystick = Number(joystick.value); save(); applyStick(); });

  const padNote = $('gamepad');
  const pollPad = () => {
    const pad = navigator.getGamepads?.().find(p => p);
    if (!pad) {
      if (padBits) { padBits = 0; applyStick(); }
      return;
    }
    padNote.textContent = `Gamepad: ${pad.id.replace(/\(.*\)/, '').trim() || 'connected'}`;
    const b = (i: number) => Boolean(pad.buttons[i]?.pressed);
    const [x = 0, y = 0] = pad.axes;
    const bits = (y < -0.5 || b(12) ? JOY_UP : 0) | (y > 0.5 || b(13) ? JOY_DOWN : 0) |
      (x < -0.5 || b(14) ? JOY_LEFT : 0) | (x > 0.5 || b(15) ? JOY_RIGHT : 0) |
      (b(0) || b(1) || b(2) || b(3) ? JOY_FIRE : 0);
    if (bits !== padBits) { padBits = bits; applyStick(); }
  };

  // The on-screen keyboard: a tap presses the key for a moment; SHIFT, C=
  // and CTRL stay down until the next key, so one finger can type them.
  const latched = new Set<string>();
  const kbd = $('kbd');
  kbd.replaceChildren(...LAYOUT.map(row => {
    const r = document.createElement('div');
    r.className = 'kbd-row';
    for (const cap of row) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `kbd-key${/^F\d/.test(cap.key) ? ' fn' : ''}${cap.label.length > 2 ? ' small' : ''}`;
      b.dataset.key = cap.key;
      if (cap.wide) b.style.flexGrow = String(cap.wide);
      b.innerHTML = `<span class="shifted">${escape(cap.shifted ?? '')}</span><span class="label">${escape(cap.label)}</span>`;
      b.setAttribute('aria-label', cap.key === 'SPACE' ? 'Space' : cap.label);
      r.append(b);
    }
    return r;
  }));
  const showLatched = () => {
    for (const b of kbd.querySelectorAll<HTMLElement>('.kbd-key')) b.classList.toggle('latched', latched.has(b.dataset.key!));
  };
  kbd.addEventListener('pointerdown', e => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('.kbd-key');
    if (!b || !running) return;
    e.preventDefault();
    const name = b.dataset.key!;
    if (name === 'RESTORE') {
      c64.restore = true;
      setTimeout(() => { c64.restore = false; }, 100);
      return;
    }
    if (MODIFIERS.has(name)) {
      if (latched.has(name)) latched.delete(name); else latched.add(name);
      showLatched();
      return;
    }
    const held: Key[] = [...latched].map(n => KEYS[n]);
    held.push(KEYS[name]);
    keys.extra = held;
    keys.update();
    setTimeout(() => { keys.extra = []; keys.update(); }, 90);
    latched.clear();
    showLatched();
  });
  const kbdToggle = $('kbd-toggle');
  const showKbd = () => {
    kbd.hidden = !settings.keyboard;
    kbdToggle.setAttribute('aria-expanded', String(settings.keyboard));
  };
  kbdToggle.addEventListener('click', () => { settings.keyboard = !settings.keyboard; save(); showKbd(); });
  showKbd();

  // ---- programs and the shelf ----------------------------------------------

  const deckNote = $('deck-note');
  const progBox = $('prog');
  const progLabel = $('prog-label');
  /** The program in the slot, to RUN again or download. */
  let program: StoredFile | null = null;
  const notice = (text: string) => { deckNote.textContent = text; };
  const showProgram = () => {
    progBox.classList.toggle('full', Boolean(program));
    progLabel.textContent = program ? program.name : 'No program: click or drop a .prg, .t64, .d64, .tap, .crt';
  };
  showProgram();

  /** Resets (or powers on) and drops the program in when BASIC is ready, then RUN. */
  const runProgram = async (prg: Uint8Array) => {
    if (running) c64.reset(); else await powerOn();
    c64.whenReady(() => {
      try {
        injectPrg(c64, prg);
        c64.type('RUN\n');
      } catch (e) {
        notice(`Could not load it: ${(e as Error).message}`);
      }
    });
  };

  // ---- the Datasette ---------------------------------------------------------

  const tapeBox = $('tape');
  const tapeLabel = $('tape-label');
  const tapePos = $('tape-pos');
  const showTape = () => {
    const t = c64.tape;
    tapeBox.classList.toggle('full', Boolean(t));
    tapeBox.classList.toggle('playing', c64.tapePlay);
    tapeLabel.textContent = t
      ? `${t.name}${t.files.length ? ` · ${t.files.map(f => f.name || '""').slice(0, 4).join(', ')}${t.files.length > 4 ? '…' : ''}` : ''}`
      : 'No tape: click or drop a .tap or .t64';
    tapePos.textContent = t ? `${Math.round(t.progress * 100)}%` : '';
  };
  const storeTape = () => {
    const t = c64.tape;
    void saveTape(t ? { name: t.name, data: t.toTap() } : null);
  };
  const insertTape = (t: Tape, store = true) => {
    c64.tape = t;
    c64.tapePlay = false;
    if (store) storeTape();
    showTape();
  };
  /** Reset, then LOAD and RUN with PLAY down (the KERNAL wants it for real-time loads). */
  const tapeLoad = async () => {
    if (!c64.tape) return;
    if (running) c64.reset(); else await powerOn();
    c64.tapePlay = true;
    c64.whenReady(() => c64.type('LOAD\rRUN\r'));
    showTape();
  };
  const tapeFile = $<HTMLInputElement>('tape-file');
  $('tape-load').addEventListener('click', () => tapeFile.click());
  tapeFile.addEventListener('change', () => {
    const f = tapeFile.files?.[0];
    if (f) void readFile(f);
    tapeFile.value = '';
  });
  $('tape-run').addEventListener('click', () => void tapeLoad());
  $('tape-play').addEventListener('click', () => { c64.tapePlay = !c64.tapePlay; showTape(); });
  $('tape-rewind').addEventListener('click', () => { c64.tape?.rewind(); showTape(); });
  $('tape-save').addEventListener('click', () => {
    const t = c64.tape;
    if (t) download(t.name.replace(/\.(t64|tap)$/i, '') + '.tap', t.toTap());
  });
  $('tape-blank').addEventListener('click', () => { insertTape(Tape.blank()); c64.tapePlay = true; showTape(); });
  $('tape-eject').addEventListener('click', () => { c64.tape = null; c64.tapePlay = false; storeTape(); showTape(); void showShelf(); });
  const kept = await loadTape();
  if (kept) {
    try { insertTape(Tape.fromTap(kept.data, kept.name), false); } catch { void saveTape(null); }
  }
  showTape();

  // ---- the disk drives -------------------------------------------------------

  /** Which drive the disk file picker is for. */
  let diskTarget = 8;
  const drive = (n: number) => c64.drives[n - 8];
  const showDisks = () => {
    for (const n of [8, 9]) {
      const d = drive(n).disk;
      $(`disk${n}`).classList.toggle('full', Boolean(d));
      $(`disk${n}-label`).textContent = d
        ? `${d.name} · "${nameString(d.diskName)}" · ${d.entries().length} files`
        : n === 8 ? 'No disk: click or drop a .d64' : 'No disk: click to insert one (drive 9 answers only with a disk in it)';
      $(`disk${n}-pos`).textContent = d ? `${d.blocksFree} free` : '';
    }
  };
  const storeDisk = (n: number) => {
    const d = drive(n).disk;
    void saveDisk(n, d ? { name: d.name, data: d.data } : null);
  };
  const insertDisk = (n: number, d: D64 | null, store = true) => {
    drive(n).insert(d);
    if (store) storeDisk(n);
    showDisks();
  };
  /** Reset, then LOAD"*",8,1 and RUN (the way the first program on a disk was started). */
  const diskLoad = async () => {
    if (!drive(8).disk) return;
    if (running) c64.reset(); else await powerOn();
    c64.whenReady(() => c64.type('LOAD"*",8,1\rRUN\r'));
  };
  const diskFile = $<HTMLInputElement>('disk-file');
  diskFile.addEventListener('change', async () => {
    const f = diskFile.files?.[0];
    diskFile.value = '';
    if (!f) return;
    await open({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) }, true, diskTarget);
  });
  for (const n of [8, 9]) {
    $(`disk${n}-load`).addEventListener('click', () => { diskTarget = n; diskFile.click(); });
    $(`disk${n}-dir`).addEventListener('click', async () => {
      await ensureOn();
      c64.type(`LOAD"$",${n}\rLIST\r`);
    });
    $(`disk${n}-save`).addEventListener('click', () => {
      const d = drive(n).disk;
      if (d) download(d.name.replace(/\.d64$/i, '') + '.d64', d.data);
    });
    $(`disk${n}-blank`).addEventListener('click', () => insertDisk(n, D64.blank()));
    $(`disk${n}-eject`).addEventListener('click', () => { insertDisk(n, null); void showShelf(); });
  }
  $('disk8-run').addEventListener('click', () => void diskLoad());
  for (const n of [8, 9]) {
    const kept = await loadDisk(n);
    if (kept) {
      try { insertDisk(n, new D64(kept.data, kept.name), false); } catch { void saveDisk(n, null); }
    }
  }
  showDisks();

  const shelfList = $('shelf-list');
  const showShelf = async () => {
    const all = await loadShelf();
    shelfList.replaceChildren(...all.map(f => {
      const li = document.createElement('li');
      if (program?.name === f.name || c64.tape?.name === f.name || c64.drives.some(d => d.disk?.name === f.name)) li.className = 'inserted';
      const pick = document.createElement('button');
      pick.className = 'shelf-cart';
      pick.type = 'button';
      pick.textContent = f.name;
      pick.title = 'Load it';
      pick.addEventListener('click', () => void open(f, false));
      const del = document.createElement('button');
      del.className = 'shelf-del';
      del.type = 'button';
      del.textContent = '✕';
      del.title = 'Take it off the shelf';
      del.addEventListener('click', async () => {
        if (await askConfirm({ title: `Remove ${f.name}?`, message: 'It is taken off the shelf in this browser.', ok: 'Remove' })) {
          await unshelve(f.name);
          void showShelf();
        }
      });
      li.append(pick, del);
      return li;
    }));
  };

  /** Any file: a program, tape, disk or cartridge (also inside a .zip). */
  const open = async (file: StoredFile, fromOutside = true, toDrive = 8) => {
    try {
      if (/\.zip$/i.test(file.name)) {
        const files = unzipSync(file.data);
        const inner = Object.keys(files).find(n => /\.(prg|p00|t64|tap|d64|crt)$/i.test(n));
        if (!inner) throw new Error('no .prg, .t64, .tap, .d64 or .crt inside this .zip');
        file = { name: inner.split('/').pop()!, data: files[inner] };
      }
      if (file.data.length > MAX_FILE) throw new Error('that file is too big for a C64');
      const ext = /\.([^.]+)$/.exec(file.name)?.[1].toLowerCase() ?? '';
      if (ext === 'prg' || ext === 'p00') {
        const prg = ext === 'p00' ? fromP00(file.data) : file.data;
        program = { name: `${prgName(file.name)}.prg`, data: prg };
        showProgram();
        notice('');
        await runProgram(prg);
      } else if (ext === 'd64') {
        insertDisk(toDrive, new D64(file.data, file.name));
        notice('');
        if (toDrive === 8) await diskLoad();
      } else if (ext === 'tap' || ext === 't64') {
        insertTape(ext === 'tap' ? Tape.fromTap(file.data, file.name) : Tape.fromT64(file.data, file.name));
        notice('');
        await tapeLoad();
      } else {
        throw new Error(`.${ext} files are not supported yet`);
      }
      if (fromOutside) await shelve(file);
      void showShelf();
    } catch (err) {
      notice(`Could not load ${file.name}: ${(err as Error).message}`);
    }
  };

  const fileInput = $<HTMLInputElement>('file');
  const readFile = async (f: File) => open({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) });
  $('prog-load').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    if (f) void readFile(f);
    fileInput.value = '';
  });
  $('prog-run').addEventListener('click', () => { if (program) void runProgram(program.data); });
  $('prog-save').addEventListener('click', () => { if (program) download(program.name, program.data); });
  $('prog-eject').addEventListener('click', () => { program = null; showProgram(); void showShelf(); });

  // Drag and drop anywhere on the page.
  let dragDepth = 0;
  window.addEventListener('dragenter', e => { e.preventDefault(); if (dragDepth++ === 0) document.body.classList.add('dragging'); });
  window.addEventListener('dragleave', () => { if (--dragDepth === 0) document.body.classList.remove('dragging'); });
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => {
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('dragging');
    const f = e.dataTransfer?.files?.[0];
    if (f) void readFile(f);
  });

  // Paste a listing: tokenized as the C64's editor would, then RUN.
  const pasteDialog = $<HTMLDialogElement>('paste-dialog');
  const pasteText = $<HTMLTextAreaElement>('paste-text');
  const pasteError = $('paste-error');
  $('paste-open').addEventListener('click', () => {
    pasteError.textContent = '';
    pasteDialog.showModal();
    pasteText.focus();
  });
  $('paste-run').addEventListener('click', e => {
    try {
      const prg = tokenize(pasteText.value);
      program = { name: 'LISTING.prg', data: prg };
      showProgram();
      void runProgram(prg);
    } catch (err) {
      e.preventDefault();
      pasteError.textContent = err instanceof ListingError ? err.message : String(err);
    }
  });

  void showShelf();

  // Files from the page's link: ?prg=, ?tap=, ?d64=, ?crt= (or ?file=), any URL that allows it (CORS).
  const params = new URLSearchParams(location.search);
  const linkKey = ['file', 'prg', 'tap', 't64', 'd64', 'crt'].find(k => params.get(k));
  const fromLink = async () => {
    if (!linkKey) return;
    const url = params.get(linkKey)!;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`the server answered ${res.status}`);
      let name = decodeURIComponent(new URL(url, location.href).pathname.split('/').pop() || '') || `link.${linkKey}`;
      if (linkKey !== 'file' && !new RegExp(`\\.(${linkKey}|zip)$`, 'i').test(name)) name += `.${linkKey}`;
      await open({ name, data: new Uint8Array(await res.arrayBuffer()) });
    } catch (e) {
      const why = e instanceof TypeError
        ? 'the site does not let other pages fetch its files (CORS); download it and drop it here instead'
        : (e as Error).name === 'TimeoutError' ? 'no answer in 20 seconds' : (e as Error).message;
      notice(`Could not load ${url}: ${why}`);
    }
  };

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
    pollPad();
    let ran = 0;
    if (settings.turboTape && c64.tapeRunning) {
      // While the tape turns, run as fast as the host allows (no sound).
      const until = now + 12;
      while (performance.now() < until && c64.tapeRunning) { c64.runFrame(); ran++; }
      c64.takeAudio();
      owed = 0;
    } else {
      const most = 4 * settings.speed;
      while (owed >= FRAME_MS / settings.speed && ran < most) {
        owed -= FRAME_MS / settings.speed;
        c64.runFrame();
        const samples = c64.takeAudio();
        if (settings.speed === 1) sound.play(samples);
        ran++;
      }
      if (ran === most) owed = 0; // the host fell behind: do not try to catch up
    }
    if (ran) draw();
    for (const n of [8, 9]) {
      const dr = drive(n);
      if (dr.busy > 0) dr.busy = Math.max(0, dr.busy - ran);
      $(`lamp${n}`).classList.toggle('on', dr.busy > 0);
    }
    statFrames += ran;
    if (now - statTime >= 1000) {
      const f = (statFrames * 1000) / (now - statTime);
      fps.textContent = `${f.toFixed(0)} / s`;
      mhz.textContent = `${((f * t.cyclesPerLine * t.lines) / 1e6).toFixed(2)} MHz`;
      statFrames = 0;
      statTime = now;
      if (c64.tape?.dirty) { c64.tape.dirty = false; storeTape(); }
      showTape();
      for (const n of [8, 9]) {
        const d = drive(n).disk;
        if (d?.dirty) { d.dirty = false; storeDisk(n); showDisks(); }
      }
    }
  };
  requestAnimationFrame(loop);

  // ---- first power-on ------------------------------------------------------

  showPower();
  if (settings.autoPower || linkKey || sessionStorage.getItem('ready-prompt.warm') === '1') {
    await ensureOn();
  } else {
    await waitForPower(wrap);
    await ensureOn();
  }
  applyStick();
  void fromLink();
}

function escape(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function download(name: string, data: Uint8Array): void {
  const url = URL.createObjectURL(new Blob([data as BlobPart]));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

void start();
