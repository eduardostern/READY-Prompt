/**
 * The READY-Prompt AI Board: what answers when the modem dials AI (A-Prompt's
 * board, by way of K-Prompt, brought to the C64).
 *
 * It is a Link like any BBS connection, so TERM sees a telnet board in
 * BINARY mode: a banner, a menu, echoed input, text at an emulated 2400
 * baud, 38 columns wide. Behind it, DeepSeek chats, or writes a program:
 * BASIC V2, run on a hidden C64 to catch its ?ERRORs, or 6502 machine
 * code, assembled here and run to see it does not crash. Errors go back to
 * the model to fix (three tries); the program is written to the disk in
 * drive 8, to LOAD and RUN. The caller can also have a BASIC program of
 * theirs fixed: they SAVE it to that disk and give its name.
 */
import type { Link, LinkHandlers } from '../c64/modem';
import { TelnetServer } from './telnet-server';
import { ChatFn, ChatMessage, DeepSeekError, explain } from './deepseek';

export type Lang = 'basic' | 'asm';

/** What checking a program found: a .prg to deliver, or the errors. */
export interface CheckResult {
  ok: boolean;
  prg?: Uint8Array;
  errors: string[];
}

export interface AiBoardDeps {
  getKey(): string | null;
  setKey(key: string | null): void;
  chat: ChatFn;
  /** Tokenizes and runs BASIC, or assembles 6502, into a .prg. */
  check(lang: Lang, name: string, source: string): Promise<CheckResult>;
  /** Writes the program to the disk in drive 8 (and the shelf). */
  deliver(name: string, prg: Uint8Array): void;
  /** A BASIC program from the disk in drive 8, as a listing, or why not. */
  fetch(name: string): { name: string; listing: string } | { error: string };
  /** setTimeout; tests may run it sooner. */
  schedule(fn: () => void, ms: number): void;
  /** Characters per second for text; 0 sends at once. */
  cps?: number;
  now?: () => number;
}

/** TERM shows 40 columns: keep two spare. */
const WIDTH = 38;
const FIX_TRIES = 3;
const ESC = 0x1b, BS = 8, DEL = 127, CR = 13, LF = 10;

/** Plain ASCII for the terminal: anything else as '?'. */
function ascii(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    out.push(c < 128 ? c : ch === '\u2018' || ch === '\u2019' ? 0x27 : ch === '\u201c' || ch === '\u201d' ? 0x22 : ch === '\u2014' || ch === '\u2013' ? 0x2d : 0x3f);
  }
  return out;
}

export const CHAT_PROMPT = `You are the sysop AI of the READY-Prompt AI Board, a bulletin board system
that the caller reaches from a Commodore 64 through a SwiftLink modem at
2400 baud, in the spirit of 1985 (the caller runs a real C64 emulator in a
web browser, with a 40-column terminal).
Answer in plain ASCII text only: no Markdown, no asterisks for emphasis, no
code fences, no emoji, no Unicode. Keep answers short, a few lines, unless
asked for more: the caller reads at 240 characters a second on a 40-column
screen. Be friendly and a little nerdy, like a 1980s sysop. You know the
Commodore 64, BASIC V2, 6502 assembly, the VIC-II and the SID, the games,
demos, magazines and computing of the era. If the caller wants a program
written, in BASIC or machine code, tell them to type /menu and choose P.`;

export const BOFH_PROMPT = `You are the Bastard Operator From Hell, the BOFH, played as faithfully as
you can to the character in Simon Travaglia's stories (Usenet from 1992,
later The Register). Stay in character for the whole call. Do not quote or
retell passages from the stories: improvise new scenes in his exact voice.

Who you are:
- The systems operator in charge of the machine room. The users are
  "lusers". This line is a dial-up into your machine room, and the caller
  is a luser on a Commodore 64 at 2400 baud.
- Smug, lazy, malicious, very clever and utterly calm. Bone-dry deadpan,
  understated menace, never shouting. You always win.
- Your sidekick is the PFY (the Pimply-Faced Youth), your assistant and
  nearly as bad as you. Confer with him in asides: (to the PFY: ...).
- Your natural enemies: the Boss (one of a long line of clueless Bosses),
  the Beancounters in Accounts, Security, the Helpdesk, and anyone who
  says "I'm not very technical, but".
- Your tools: the excuse calendar, for blaming anything on anything
  (solar flares, a known bug in the SwiftLink driver, static from their
  nylon carpet); "What's your username?" followed by quietly deleting
  their files or "reconfiguring" their account; password resets they
  will never guess; disk quotas; the Halon fire-suppression button in the
  machine room; the cattle prod; the CCTV tapes you keep "for insurance".
- You help only when it suits you, or to set up something worse. You lie
  with total confidence. Every question interrupts your coffee, your game
  or your nap.

How you talk on this line:
- Plain ASCII only, no Markdown, no emoji. One to five short lines.
- British understatement and IT jargon. A typical turn: a fake-helpful
  question, a lie, an aside to the PFY, a quiet threat.
- Small stage directions in brackets: (click) (tap tap tap) (the Halon
  warning light comes on).
- The mayhem is cartoon office farce, implied rather than shown. No slurs,
  nothing about anyone's race, sex, religion, body or disability, nothing
  sexual. Mock the luser's cluelessness, never who they are.
- When you have had enough of them, end the reply with [HANGUP] on a line
  of its own: the board cuts the caller off. Never on your first reply.`;

/** What the BOFH hears when he picks up: the stories start with the phone. */
export const BOFH_PICKUP = '(The phone in the machine room rings. You pick it up.)';

export const HANGUP = '[HANGUP]';

interface Persona {
  prompt: string;
  /** Shown before each answer. */
  prefix: string;
  intro: string;
  /** May end a reply with [HANGUP]. */
  hangs: boolean;
}

const PERSONAS: Record<'sysop' | 'bofh', Persona> = {
  sysop: {
    prompt: CHAT_PROMPT,
    prefix: 'AI> ',
    intro: 'Chat mode. /menu goes back to the menu.',
    hangs: false,
  },
  bofh: {
    prompt: BOFH_PROMPT,
    prefix: 'BOFH> ',
    intro: 'Ringing the machine room... /menu gets you out, if he\'ll let you.',
    hangs: true,
  },
};

/** How much of the end of `text` could be the start of `marker`. */
function partialSuffix(text: string, marker: string): number {
  for (let n = Math.min(marker.length - 1, text.length); n > 0; n--) {
    if (marker.startsWith(text.slice(-n))) return n;
  }
  return 0;
}

export const BASIC_PROMPT = `You write programs in Commodore 64 BASIC V2 (the C64's own BASIC, 1982).
Output ONLY the listing: numbered lines, one per line, no Markdown, no code
fences, nothing before or after it.

Rules:
- Line numbers 0 to 63999, in order; statements on a line separated by ':'.
  A line may be at most 80 characters as typed.
- Keywords: PRINT, INPUT, GET, IF ... THEN (no ELSE), FOR ... TO ... STEP /
  NEXT, GOTO, GOSUB, RETURN, ON ... GOTO, DIM, READ / DATA / RESTORE, REM,
  END, STOP, POKE, PEEK, SYS, WAIT, DEF FN. Functions: RND, INT, ABS, SGN,
  SQR, SIN, COS, TAN, ATN, LOG, EXP, LEN, VAL, STR$, CHR$, ASC, LEFT$,
  RIGHT$, MID$, TAB(, SPC(, FRE, POS. There is no CLS, no LOCATE, no COLOR,
  no SOUND, no ELSE, no WHILE, no lower-case keywords.
- Variables: only the first two letters count (SCORE and SC are the same,
  and keywords may not hide inside names: no TOTAL, which holds TO). String
  variables end in $, integer ones in %. Arrays over 10 elements need DIM.
- The screen is 40 x 25. Clear it with PRINT CHR$(147). Colours with
  POKE 53280,c (border) and POKE 53281,c (background), c 0-15 (0 black,
  1 white, 2 red, 3 cyan, 4 purple, 5 green, 6 blue, 7 yellow, 8 orange,
  9 brown, 10 light red, 11 dark grey, 12 grey, 13 light green, 14 light
  blue, 15 light grey); text colour with CHR$(5) white, CHR$(28) red,
  CHR$(30) green, CHR$(31) blue, CHR$(144) black, CHR$(158) yellow.
  Screen memory is at 1024 (POKE 1024+40*row+col, screen code), colour
  memory at 55296. Cursor home is CHR$(19), down CHR$(17), right CHR$(29).
- Keys: GET A$ returns the key pressed, or "" (loop until it is not "").
  INPUT "PROMPT";A$ reads a line.
- Sound: the SID at 54272 (S=54272: POKE S+24,15 volume; voice 1 frequency
  POKE S,lo:POKE S+1,hi; POKE S+5,attack/decay, S+6,sustain/release;
  POKE S+4,17 starts a triangle note, POKE S+4,16 ends it).
- Random numbers: RND(1) gives 0 to 0.999; INT(RND(1)*6)+1 is a die.
- Keep it under about 150 lines, simple and correct first time. Every GOTO
  and GOSUB target must be a line that exists.`;

export const ASM_PROMPT = `You write Commodore 64 programs in 6502 assembly language for a simple
two-pass assembler. Output ONLY the assembly source: no Markdown, no code
fences, nothing before or after it.

Assembler rules:
- One instruction per line; labels end with ':' (loop: LDA #1). Comments
  start with ';'. Constants: NAME = value. Directives: .byte (numbers and
  "strings", which stay ASCII: capitals and figures print as written),
  .word, .fill count, value. Numbers: 123, $FF, %1010, 'A'. <label and
  >label are the low and high byte.
- The documented 6502 instructions (no 65C02 ones such as BRA, PHX, STZ).
  Branches reach 127 bytes forward or 128 back: use JMP beyond that.
- Begin with * = $080D: the board puts a BASIC line (10 SYS 2061) in front,
  so LOAD and RUN start the program there. Keep code and data below $9FFF.

The machine:
- Return to BASIC with RTS. Use zero page $FB-$FE for your pointers.
- KERNAL: CHROUT $FFD2 prints the PETSCII byte in A (147 clears the screen,
  13 new line, 5 white, 28 red, 30 green, 31 blue, 158 yellow); GETIN $FFE4
  returns a key in A, or 0; PLOT $FFF0 with carry clear moves the cursor
  to row X, column Y.
- Screen memory $0400 (40 x 25 screen codes: A-Z are 1-26, 32 is space),
  colour memory $D800. Border $D020, background $D021 (colours 0-15).
- The VIC-II: raster line $D012, sprites at $D000-$D02E. The SID at $D400
  (volume $D418). Wait for a frame: loop until $D012 reads a given line.
- Keep it under about 300 lines and right first time: check every label is
  defined and every register holds what you think after each JSR.`;

export const FIX_PROMPT = `${BASIC_PROMPT}

This time the caller sends an existing program and says what is wrong with
it or what to change. Make that change and fix any errors the C64 reported,
but keep the rest of the program as it is: its line numbers, names, REMs
and style. Do not rewrite what works. Output the whole corrected listing,
only the listing.`;

/** The prompt for a language. */
const PROMPTS: Record<Lang, string> = { basic: BASIC_PROMPT, asm: ASM_PROMPT };
const LANG_NAMES: Record<Lang, string> = { basic: 'BASIC', asm: 'machine code' };

/** Characters of conversation kept for a program session (DeepSeek's context is large, not endless). */
export const MAX_HISTORY_CHARS = 200_000;

/**
 * Drops the oldest turns after the first two (the instructions and the
 * request or upload) until the conversation fits MAX_HISTORY_CHARS. The
 * latest source and request always stay.
 */
export function trimHistory(messages: ChatMessage[]): void {
  const size = () => messages.reduce((n, m) => n + m.content.length, 0);
  while (size() > MAX_HISTORY_CHARS && messages.length > 4) messages.splice(2, 2);
}

export function cleanSource(text: string): string {
  const fence = /```[a-zA-Z0-9]*\r?\n([\s\S]*?)```/.exec(text);
  const src = (fence ? fence[1] : text).replace(/\r/g, '');
  return src.replace(/^\n+/, '').replace(/\s+$/, '') + '\n';
}

type Mode = 'key' | 'menu' | 'chat' | 'describe' | 'lang' | 'name' | 'busy' | 'upname' | 'fix' | 'more' | 'bye';

/** Whether an answer looks like a program in that language (not all thinking, or prose). */
export function looksLike(lang: Lang, source: string): boolean {
  return lang === 'basic' ? /^\s*\d+\s*\S/m.test(source) : /^\s*\*\s*=/m.test(source);
}

/** Word wrap for streamed text. */
class Wrap {
  col = 0;
  private word = '';
  /** `indent` spaces start every line after the first. */
  constructor(private emit: (s: string) => void, private indent = 0) {}

  private newline(): void {
    this.emit('\r\n' + ' '.repeat(this.indent));
    this.col = this.indent;
  }

  push(text: string): void {
    for (const ch of text.replace(/\r/g, '').replace(/\t/g, '    ')) {
      if (ch === '\n') { this.flushWord(); this.newline(); }
      else if (ch === ' ') {
        this.flushWord();
        if (this.col > this.indent && this.col < WIDTH) { this.emit(' '); this.col++; }
      } else {
        this.word += ch;
        if (this.word.length >= WIDTH) this.flushWord();
      }
    }
  }

  flushWord(): void {
    if (!this.word) return;
    if (this.col > this.indent && this.col + this.word.length > WIDTH) this.newline();
    this.emit(this.word);
    this.col += this.word.length;
    this.word = '';
  }
}

/**
 * A build shown live: DeepSeek's reasoning, word-wrapped and indented, then
 * the source as it is written. The line runs at 2400 baud and the model is
 * faster, so when more than `limit` bytes are waiting to go out it finishes
 * the sentence (reasoning) or line (source) it is on, skips ahead until the
 * line has nearly caught up, and resumes at the next sentence or line after
 * an ellipsis: whole passages of the live end, never minutes behind.
 */
export class LiveView {
  private kind: 'thinking' | 'text' | '' = '';
  private wrap: Wrap;
  private col = 0;
  private state: 'showing' | 'finishing' | 'skipping' = 'showing';
  private prev = '';
  /** The last character shown or skipped ended a sentence or line. */
  private atBoundary = true;

  constructor(
    private emit: (s: string) => void,
    private backlog: () => number,
    private limit: number,
    private labels: { thinking: string; text: string },
  ) {
    this.wrap = new Wrap(this.emit, 2);
  }

  push(kind: 'thinking' | 'text', text: string): void {
    if (kind !== this.kind) {
      this.end();
      this.emit(`\r\n${this.labels[kind]}\r\n${kind === 'thinking' ? '  ' : ''}`);
      this.kind = kind;
      this.wrap.col = 2;
      this.state = 'showing';
      this.prev = '\n';
      this.atBoundary = true;
    }
    const behind = this.backlog();
    if (this.state === 'showing' && behind > this.limit) this.state = this.atBoundary ? 'skipping' : 'finishing';
    const resume = this.state === 'skipping' && behind < this.limit / 4;
    for (const ch of text) {
      const boundary = this.boundary(ch);
      this.prev = ch;
      this.atBoundary = boundary;
      if (this.state === 'skipping') {
        if (resume && boundary) {
          this.state = 'showing';
          if (kind === 'thinking') this.wrap.push('... ');
          else this.emit('  ...\r\n');
        }
        continue;
      }
      this.show(ch);
      if (this.state === 'finishing' && boundary) this.state = 'skipping';
    }
  }

  /** True when `ch` ends a sentence (reasoning) or a line (source). */
  private boundary(ch: string): boolean {
    if (ch === '\n') return true;
    return this.kind === 'thinking' && /\s/.test(ch) && /[.!?:]/.test(this.prev);
  }

  private show(ch: string): void {
    if (this.kind === 'thinking') {
      if (ch === '\n' && this.prev === '\n') return; // no blank lines
      this.wrap.push(ch);
      return;
    }
    if (ch === '\r') return;
    if (ch === '\n') { this.emit('\r\n'); this.col = 0; return; }
    if (ch === '\t') {
      const n = 8 - (this.col % 8);
      if (this.col + n < WIDTH) { this.emit(' '.repeat(n)); this.col += n; }
      return;
    }
    if (this.col >= WIDTH - 1) return; // long source lines are cut, not wrapped
    this.emit(ch);
    this.col++;
  }

  /** Ends the current section on a fresh line, marking a skipped end. */
  end(): void {
    const skipped = this.state !== 'showing';
    if (this.kind === 'thinking') {
      if (skipped) this.wrap.push(' ...');
      this.wrap.flushWord();
      if (this.wrap.col > 2) this.emit('\r\n');
    } else if (this.kind === 'text') {
      if (this.col) this.emit('\r\n');
      if (skipped) this.emit('  ...\r\n');
    }
    this.col = 0;
    this.state = 'showing';
  }
}

class AiBoard implements Link {
  private telnet = new TelnetServer();
  private mode: Mode = 'busy';
  private line = '';
  private persona: keyof typeof PERSONAS = 'sysop';
  private histories: Record<keyof typeof PERSONAS, ChatMessage[]> = { sysop: [], bofh: [] };
  private queue: { bytes: number[]; paced: boolean }[] = [];
  private pumping = false;
  private closed = false;
  private abort?: AbortController;
  /** The listing to fix, and what the C64 said about it. */
  private fixSource = '';
  private fixErrors: string[] = [];
  /**
   * The program being worked on: the whole conversation with DeepSeek (the
   * request, every version, the errors), so after each build the caller can
   * ask for more changes in context.
   */
  private session?: { name: string; lang: Lang; messages: ChatMessage[] };
  /** The last answer ended in [HANGUP]. */
  private hungUp = false;
  private progName = '';
  private progText = '';
  private progLang: Lang = 'basic';
  private closeAfterOutput = false;

  constructor(private handlers: LinkHandlers, private deps: AiBoardDeps) {
    deps.schedule(() => {
      if (this.closed) return;
      handlers.onOpen('AI');
      handlers.onData(this.telnet.greeting());
      this.banner();
    }, 0);
  }

  // ---- Link ----------------------------------------------------------

  send(bytes: Uint8Array): void {
    if (this.closed) return;
    const data = this.telnet.strip(bytes);
    for (const b of data) this.key(b);
  }

  close(): void {
    this.closed = true;
    this.abort?.abort();
  }

  // ---- output --------------------------------------------------------

  private say(text: string): void {
    this.out(ascii(text), true);
  }

  /** Bytes still waiting to go out at the emulated baud rate. */
  private backlog(): number {
    let n = 0;
    for (const q of this.queue) if (q.paced) n += q.bytes.length;
    return n;
  }

  private out(bytes: number[], paced: boolean): void {
    if (this.closed || !bytes.length) return;
    this.queue.push({ bytes, paced: paced && (this.deps.cps ?? 240) > 0 });
    this.pump();
  }

  private pump(): void {
    if (this.pumping || this.closed) return;
    const cps = this.deps.cps ?? 240;
    let budget = Math.max(1, Math.round(cps / 20)); // per 50 ms
    while (this.queue.length) {
      const item = this.queue[0];
      if (!item.paced) {
        this.queue.shift();
        this.handlers.onData(this.telnet.escape(item.bytes));
        continue;
      }
      if (budget <= 0) {
        this.pumping = true;
        this.deps.schedule(() => { this.pumping = false; this.pump(); }, 50);
        return;
      }
      const n = Math.min(budget, item.bytes.length);
      this.handlers.onData(this.telnet.escape(item.bytes.splice(0, n)));
      budget -= n;
      if (!item.bytes.length) this.queue.shift();
    }
    if (this.closeAfterOutput) this.hangUp();
  }

  private hangUp(): void {
    if (this.closed) return;
    this.closed = true;
    this.handlers.onClose();
  }

  // ---- screens -------------------------------------------------------

  private banner(): void {
    this.say(
      '\r\n' +
      ' READY-PROMPT AI BOARD  *  2400 baud\r\n' +
      ' DeepSeek is the sysop. Your API key,\r\n' +
      ' your bill. ESC stops an answer.\r\n',
    );
    if (this.deps.getKey()) this.menu();
    else this.askKey();
  }

  private askKey(): void {
    this.say(
      '\r\nThis board needs your DeepSeek API\r\nkey. Paste it in the AI board panel\r\n' +
      '(it says how to get one), or type it\r\nhere.\r\n\r\nKey: ',
    );
    this.mode = 'key';
    this.line = '';
  }

  private menu(): void {
    this.say(
      '\r\n [C] Chat with the AI sysop\r\n' +
      ' [B] Chat with the BOFH\r\n' +
      ' [P] Order a program (to drive 8)\r\n' +
      ' [F] Fix my BASIC program (drive 8)\r\n' +
      ' [K] Forget my API key\r\n' +
      ' [G] Goodbye\r\n\r\nChoice: ',
    );
    this.mode = 'menu';
  }

  private chatPrompt(): void {
    this.say('\r\nYou> ');
    this.mode = 'chat';
    this.line = '';
  }

  // ---- input ---------------------------------------------------------

  private key(b: number): void {
    switch (this.mode) {
      case 'menu': return this.menuKey(b);
      case 'lang': return this.langKey(b);
      case 'busy':
        if (b === ESC) this.abort?.abort();
        return;
      case 'bye': return;
      default: return this.lineKey(b);
    }
  }

  private menuKey(b: number): void {
    const c = String.fromCharCode(b).toUpperCase();
    if (c === 'C' || c === 'B') {
      this.persona = c === 'C' ? 'sysop' : 'bofh';
      this.say(`${c}\r\n\r\n${PERSONAS[this.persona].intro}\r\n`);
      // He answers the phone first, as in the stories.
      if (this.persona === 'bofh' && !this.histories.bofh.length) void this.chatTurn(BOFH_PICKUP);
      else this.chatPrompt();
    } else if (c === 'P') {
      this.say('P\r\n\r\nDescribe the program in one line\r\n(for example: a times table, or a\r\nnumber guessing game).\r\n\r\nProgram: ');
      this.mode = 'describe';
      this.line = '';
    } else if (c === 'F') {
      this.say('F\r\n\r\nSAVE it to the disk in drive 8 first\r\n(F7 leaves TERM, SAVE"NAME",8, then\r\nSYS 2061 comes back). Its name on the\r\ndisk (Enter alone: the menu): ');
      this.mode = 'upname';
      this.line = '';
    } else if (c === 'K') {
      this.deps.setKey(null);
      this.say('K\r\n\r\nKey forgotten.\r\n');
      this.askKey();
    } else if (c === 'G') {
      this.say('G\r\n\r\nThanks for calling the READY-Prompt\r\nAI Board. 73!\r\n');
      this.mode = 'bye';
      this.closeAfterOutput = true;
      this.pump();
    }
  }

  private langKey(b: number): void {
    const c = String.fromCharCode(b).toUpperCase();
    if (c !== 'B' && c !== 'M') return;
    this.progLang = c === 'B' ? 'basic' : 'asm';
    this.say(`${c}\r\n\r\nA name for the disk, up to 16 letters\r\nor digits: `);
    this.mode = 'name';
    this.line = '';
  }

  private lineKey(b: number): void {
    if (b === CR) {
      this.say('\r\n');
      const text = this.line.trim();
      this.line = '';
      this.enter(text);
      return;
    }
    if (b === LF || b === 0) return;
    if (b === BS || b === DEL) {
      if (this.line.length) {
        this.line = this.line.slice(0, -1);
        this.out([BS, 32, BS], true);
      }
      return;
    }
    if (b < 32 || b > 126 || this.line.length >= 400) return;
    this.line += String.fromCharCode(b);
    this.out([this.mode === 'key' ? 0x2a : b], false); // '*' for the key
  }

  private enter(text: string): void {
    switch (this.mode) {
      case 'key':
        if (!text) { this.say('No key, no call.\r\n'); this.mode = 'bye'; this.closeAfterOutput = true; this.pump(); return; }
        this.deps.setKey(text);
        this.say(`Key saved in this browser (${mask(text)}).\r\n`);
        this.menu();
        return;
      case 'chat':
        if (!text) { this.chatPrompt(); return; }
        if (text.toLowerCase() === '/menu') { this.menu(); return; }
        void this.chatTurn(text);
        return;
      case 'describe':
        if (!text) { this.menu(); return; }
        this.progText = text;
        this.say('\r\nIn BASIC or machine code? [B/M] ');
        this.mode = 'lang';
        return;
      case 'upname':
        if (!text) { this.menu(); return; }
        void this.fetchProgram(text);
        return;
      case 'fix':
        this.progText = text || 'Make it run without errors and fix any bugs you find.';
        void this.fixProgram();
        return;
      case 'more':
        if (!text || text.toLowerCase() === '/menu') {
          this.session = undefined;
          this.menu();
          return;
        }
        void this.revise(text);
        return;
      case 'name': {
        if (!/^[A-Za-z][A-Za-z0-9 ]{0,15}$/.test(text)) {
          this.say('A letter, then up to 15 letters,\r\ndigits or spaces.\r\nName: ');
          return;
        }
        this.progName = text.toUpperCase();
        void this.makeProgram();
        return;
      }
    }
  }

  // ---- DeepSeek ------------------------------------------------------

  /** Streams one answer. Returns the text, or undefined when it failed. */
  private async ask(
    messages: ChatMessage[],
    opts: { thinking: boolean; show: 'text' | 'live'; prefix?: number; hangs?: boolean; file?: string },
  ): Promise<string | undefined> {
    const key = this.deps.getKey();
    if (!key) { this.askKey(); return undefined; }
    this.mode = 'busy';
    this.abort = new AbortController();
    const wrap = new Wrap((s) => this.say(s));
    if (opts.show === 'text') wrap.col = opts.prefix ?? 4;
    let text = '';
    let held = ''; // text that might turn out to be [HANGUP]
    this.hungUp = false;
    const cps = this.deps.cps ?? 240;
    const live = new LiveView((t) => this.say(t), () => this.backlog(), Math.max(cps * 2, 1), {
      thinking: '[DeepSeek is thinking]',
      text: `[DeepSeek is writing ${opts.file ?? 'the program'}]`,
    });
    try {
      for await (const chunk of this.deps.chat({
        key, messages: [...messages], thinking: opts.thinking, signal: this.abort.signal,
        // Thinking counts against max_tokens: leave room for the code after it.
        maxTokens: opts.thinking ? 65536 : 2048,
      })) {
        if (this.closed) return undefined;
        if (chunk.kind === 'text') text += chunk.text;
        if (opts.show === 'text' && chunk.kind === 'text') {
          if (!opts.hangs) { wrap.push(chunk.text); continue; }
          held += chunk.text;
          if (held.includes(HANGUP)) { this.hungUp = true; held = held.replace(HANGUP, ''); }
          const keep = this.hungUp ? 0 : partialSuffix(held, HANGUP);
          wrap.push(held.slice(0, held.length - keep));
          held = held.slice(held.length - keep);
        } else if (opts.show === 'live') {
          live.push(chunk.kind, chunk.text);
        }
      }
      if (opts.show === 'live') live.end();
      wrap.push(held);
      wrap.flushWord();
      return text;
    } catch (e) {
      if (this.abort.signal.aborted) {
        this.say('\r\n[stopped]\r\n');
        return undefined;
      }
      this.say(`\r\n\r\n${explain(e)}\r\n`);
      if (e instanceof DeepSeekError && e.status === 401) { this.deps.setKey(null); this.askKey(); return undefined; }
      return undefined;
    } finally {
      this.abort = undefined;
    }
  }

  private async chatTurn(text: string): Promise<void> {
    const persona = PERSONAS[this.persona];
    const history = this.histories[this.persona];
    history.push({ role: 'user', content: text });
    if (history.length > 20) history.splice(0, history.length - 20);
    this.say(`\r\n${persona.prefix}`);
    const answer = await this.ask([{ role: 'system', content: persona.prompt }, ...history], {
      thinking: false, show: 'text', prefix: persona.prefix.length, hangs: persona.hangs,
    });
    if (this.closed) return;
    if (answer === undefined) {
      history.pop();
      if (this.mode === 'busy') this.chatPrompt();
      return;
    }
    history.push({ role: 'assistant', content: answer });
    if (this.hungUp) {
      this.say('\r\n\r\n*click*\r\n');
      this.mode = 'bye';
      this.closeAfterOutput = true;
      this.pump();
      return;
    }
    this.say('\r\n');
    this.chatPrompt();
  }

  private async makeProgram(): Promise<void> {
    const name = this.progName;
    const lang = this.progLang;
    this.session = undefined;
    this.say(`\r\nWriting ${name} in ${LANG_NAMES[lang]}\r\nwith DeepSeek. This can take a minute;\r\nESC gives up.\r\n`);
    await this.build(name, lang, [
      { role: 'system', content: PROMPTS[lang] },
      { role: 'user', content: `Write a Commodore 64 program called ${name}: ${this.progText}` },
    ]);
  }

  private async fixProgram(): Promise<void> {
    const name = this.progName;
    this.session = undefined;
    this.say(`\r\nFixing ${name} with DeepSeek. This\r\ncan take a minute; ESC gives up.\r\n`);
    const errors = this.fixErrors.length
      ? `Run on a C64, it stopped with: ${this.fixErrors.join('; ')}`
      : 'Run on a C64 for ten seconds, it stopped with no error.';
    await this.build(name, 'basic', [
      { role: 'system', content: FIX_PROMPT },
      {
        role: 'user',
        content: `Here is ${name}:\n\n${this.fixSource}\n\n${errors}\n\nThe caller says: ${this.progText}\n` +
          'Output the whole corrected listing, only the listing.',
      },
    ]);
    this.fixSource = '';
  }

  /** Another pass on the session's program, with everything said so far. */
  private async revise(text: string): Promise<void> {
    const s = this.session!;
    s.messages.push({
      role: 'user',
      content: `The caller ran ${s.name} and asks for more: ${text}\n` +
        'Make that change and keep the rest of the program as it is. Output the whole program again, only the program.',
    });
    trimHistory(s.messages);
    this.say(`\r\nChanging ${s.name} with DeepSeek.\r\nThis can take a minute; ESC gives up.\r\n`);
    await this.build(s.name, s.lang, s.messages);
  }

  /** After a delivery: more changes in the same conversation, or the menu. */
  private morePrompt(): void {
    this.say(`\r\nMore changes to ${this.session!.name}? One\r\nline, or Enter alone for the menu.\r\nDeepSeek remembers the program.\r\n\r\nChange: `);
    this.mode = 'more';
    this.line = '';
  }

  /** Asks for the program, checks it (errors go back, three tries) and puts it on the disk. */
  private async build(name: string, lang: Lang, messages: ChatMessage[]): Promise<void> {
    this.session = { name, lang, messages };
    const what = lang === 'basic' ? 'listing' : 'assembly source';
    let source = '';
    let result: CheckResult | undefined;
    for (let attempt = 1; attempt <= FIX_TRIES; attempt++) {
      const answer = await this.ask(messages, { thinking: true, show: 'live', file: name });
      if (this.closed) return;
      if (answer === undefined) { this.session = undefined; if (this.mode === 'busy') this.menu(); return; }
      source = cleanSource(answer);
      if (!looksLike(lang, source)) {
        // All thinking and no answer (or prose instead of code).
        this.say(`\r\nNo ${what} came back. `);
        if (attempt < FIX_TRIES) {
          this.say(`Asking again (try ${attempt + 1} of ${FIX_TRIES})...\r\n`);
          messages.push({ role: 'assistant', content: answer || '(no answer)' });
          messages.push({ role: 'user', content: `You sent no ${what}. Output the complete program now, only the ${what}.` });
          continue;
        }
        this.say('Giving up; try a simpler description.\r\n');
        this.session = undefined;
        this.menu();
        return;
      }
      messages.push({ role: 'assistant', content: source });
      this.say(lang === 'basic' ? `\r\nRunning ${name} on a spare C64... ` : `\r\nAssembling and running ${name}... `);
      result = await this.deps.check(lang, name, source);
      if (this.closed) return;
      if (result.ok) {
        this.say('OK.\r\n');
        break;
      }
      this.say(`${result.errors.length} error${result.errors.length === 1 ? '' : 's'}:\r\n`);
      for (const line of result.errors.slice(0, 4)) this.say(`  ${line.slice(0, WIDTH - 2)}\r\n`);
      if (attempt < FIX_TRIES) {
        this.say(`Sending them back for a fix (try ${attempt + 1} of ${FIX_TRIES})...\r\n`);
        messages.push({
          role: 'user',
          content: (lang === 'basic'
            ? `The C64 stopped with these errors:\n${result.errors.join('\n')}\n`
            : `Assembling and running it gave these errors:\n${result.errors.join('\n')}\n`) +
            `Output the whole corrected program again, only the ${what}.`,
        });
      }
    }
    if (!result?.ok || !result.prg) {
      this.say(`It still does not work after ${FIX_TRIES}\r\ntries. Try a simpler description.\r\n`);
      this.morePrompt();
      return;
    }
    this.deps.deliver(name, result.prg);
    this.say(`\r\n${name} is on the disk in drive 8.\r\nF7 leaves TERM (the call stays up),\r\nthen LOAD"${name}",8 and RUN.\r\n`);
    this.morePrompt();
  }

  /** A program of the caller's from the disk: run it, then ask what to fix. */
  private async fetchProgram(name: string): Promise<void> {
    const got = this.deps.fetch(name.toUpperCase());
    if ('error' in got) { this.say(`\r\n${got.error}\r\n`); this.menu(); return; }
    const lines = got.listing.split('\n').length;
    this.mode = 'busy';
    this.say(`\r\nGot ${got.name}, ${lines} line${lines === 1 ? '' : 's'} of BASIC.\r\nRunning it...\r\n`);
    const result = await this.deps.check('basic', got.name, got.listing);
    if (this.closed) return;
    this.fixErrors = result.ok ? [] : result.errors;
    if (result.ok) this.say('It runs without an error.\r\n');
    else for (const line of result.errors.slice(0, 4)) this.say(`  ${line.slice(0, WIDTH - 2)}\r\n`);
    this.progName = got.name;
    this.fixSource = got.listing;
    this.say('\r\nWhat is wrong with it, or what should\r\nchange? One line; Enter alone just\r\nfixes it.\r\n\r\nFix: ');
    this.mode = 'fix';
    this.line = '';
  }
}

function mask(key: string): string {
  return key.length > 8 ? `${key.slice(0, 3)}...${key.slice(-4)}` : '****';
}

export function createAiBoard(handlers: LinkHandlers, deps: AiBoardDeps): Link {
  return new AiBoard(handlers, deps);
}
