/**
 * MOS 6510 (the C64's 6502 with an I/O port at 00h/01h; the port lives in
 * the machine, not here). NMOS 6502 with every undocumented opcode.
 *
 * Every bus access is one cycle, in the order the real chip makes them,
 * dummy reads and writes included: `read`/`write` are where the machine
 * runs the rest of the computer for that cycle (and holds the CPU while
 * the VIC-II has the bus). Tom Harte's single-step tests check each one.
 *
 * Interrupts: the lines are sampled after every cycle; an instruction ends
 * by looking at the sample of its next-to-last cycle (so CLI, SEI and PLP
 * act one instruction late, RTI at once), and a taken branch that stays in
 * its page looks one cycle further back.
 */

const FLAG_C = 0x01, FLAG_Z = 0x02, FLAG_I = 0x04, FLAG_D = 0x08;
const FLAG_B = 0x10, FLAG_U = 0x20, FLAG_V = 0x40, FLAG_N = 0x80;

// Addressing modes.
const IMP = 0, ACC = 1, IMM = 2, ZP = 3, ZPX = 4, ZPY = 5, ABS = 6, ABX = 7, ABY = 8;
const IZX = 9, IZY = 10, IND = 11, REL = 12;

const MODES: Record<string, number> = {
  imp: IMP, acc: ACC, imm: IMM, zp: ZP, zpx: ZPX, zpy: ZPY, abs: ABS, abx: ABX, aby: ABY,
  izx: IZX, izy: IZY, ind: IND, rel: REL,
};

/** The opcode matrix, row by row (high nibble 0..F). */
const MATRIX = `
BRK imp,ORA izx,JAM imp,SLO izx,NOP zp,ORA zp,ASL zp,SLO zp,PHP imp,ORA imm,ASL acc,ANC imm,NOP abs,ORA abs,ASL abs,SLO abs
BPL rel,ORA izy,JAM imp,SLO izy,NOP zpx,ORA zpx,ASL zpx,SLO zpx,CLC imp,ORA aby,NOP imp,SLO aby,NOP abx,ORA abx,ASL abx,SLO abx
JSR abs,AND izx,JAM imp,RLA izx,BIT zp,AND zp,ROL zp,RLA zp,PLP imp,AND imm,ROL acc,ANC imm,BIT abs,AND abs,ROL abs,RLA abs
BMI rel,AND izy,JAM imp,RLA izy,NOP zpx,AND zpx,ROL zpx,RLA zpx,SEC imp,AND aby,NOP imp,RLA aby,NOP abx,AND abx,ROL abx,RLA abx
RTI imp,EOR izx,JAM imp,SRE izx,NOP zp,EOR zp,LSR zp,SRE zp,PHA imp,EOR imm,LSR acc,ALR imm,JMP abs,EOR abs,LSR abs,SRE abs
BVC rel,EOR izy,JAM imp,SRE izy,NOP zpx,EOR zpx,LSR zpx,SRE zpx,CLI imp,EOR aby,NOP imp,SRE aby,NOP abx,EOR abx,LSR abx,SRE abx
RTS imp,ADC izx,JAM imp,RRA izx,NOP zp,ADC zp,ROR zp,RRA zp,PLA imp,ADC imm,ROR acc,ARR imm,JMP ind,ADC abs,ROR abs,RRA abs
BVS rel,ADC izy,JAM imp,RRA izy,NOP zpx,ADC zpx,ROR zpx,RRA zpx,SEI imp,ADC aby,NOP imp,RRA aby,NOP abx,ADC abx,ROR abx,RRA abx
NOP imm,STA izx,NOP imm,SAX izx,STY zp,STA zp,STX zp,SAX zp,DEY imp,NOP imm,TXA imp,ANE imm,STY abs,STA abs,STX abs,SAX abs
BCC rel,STA izy,JAM imp,SHA izy,STY zpx,STA zpx,STX zpy,SAX zpy,TYA imp,STA aby,TXS imp,TAS aby,SHY abx,STA abx,SHX aby,SHA aby
LDY imm,LDA izx,LDX imm,LAX izx,LDY zp,LDA zp,LDX zp,LAX zp,TAY imp,LDA imm,TAX imp,LXA imm,LDY abs,LDA abs,LDX abs,LAX abs
BCS rel,LDA izy,JAM imp,LAX izy,LDY zpx,LDA zpx,LDX zpy,LAX zpy,CLV imp,LDA aby,TSX imp,LAS aby,LDY abx,LDA abx,LDX aby,LAX aby
CPY imm,CMP izx,NOP imm,DCP izx,CPY zp,CMP zp,DEC zp,DCP zp,INY imp,CMP imm,DEX imp,SBX imm,CPY abs,CMP abs,DEC abs,DCP abs
BNE rel,CMP izy,JAM imp,DCP izy,NOP zpx,CMP zpx,DEC zpx,DCP zpx,CLD imp,CMP aby,NOP imp,DCP aby,NOP abx,CMP abx,DEC abx,DCP abx
CPX imm,SBC izx,NOP imm,ISC izx,CPX zp,SBC zp,INC zp,ISC zp,INX imp,SBC imm,NOP imp,SBC imm,CPX abs,SBC abs,INC abs,ISC abs
BEQ rel,SBC izy,JAM imp,ISC izy,NOP zpx,SBC zpx,INC zpx,ISC zpx,SED imp,SBC aby,NOP imp,ISC aby,NOP abx,SBC abx,INC abx,ISC abx
`;

/** Instructions that only read their operand. */
const READS = new Set(['LDA', 'LDX', 'LDY', 'EOR', 'AND', 'ORA', 'ADC', 'SBC', 'CMP', 'CPX', 'CPY',
  'BIT', 'LAX', 'NOP', 'LAS', 'ANC', 'ALR', 'ARR', 'ANE', 'LXA', 'SBX']);
/** Instructions that only write. */
const WRITES = new Set(['STA', 'STX', 'STY', 'SAX', 'SHA', 'SHX', 'SHY', 'TAS']);
/** Read-modify-write. */
const RMWS = new Set(['ASL', 'LSR', 'ROL', 'ROR', 'INC', 'DEC', 'SLO', 'RLA', 'SRE', 'RRA', 'DCP', 'ISC']);

export const MNEMONIC: string[] = [];
export const MODE: number[] = [];
export const MODE_NAME: string[] = [];
{
  const rows = MATRIX.trim().split('\n');
  for (let r = 0; r < 16; r++) {
    const cells = rows[r].split(',');
    for (let c = 0; c < 16; c++) {
      const [m, mode] = cells[c].split(' ');
      MNEMONIC[r * 16 + c] = m;
      MODE[r * 16 + c] = MODES[mode];
      MODE_NAME[r * 16 + c] = mode;
    }
  }
}

// Instruction ids, for a switch on numbers.
const NAMES = [...new Set(MNEMONIC)];
const ID = new Uint8Array(256);
const KIND = new Uint8Array(256); // 0 other, 1 read, 2 write, 3 rmw
for (let o = 0; o < 256; o++) {
  ID[o] = NAMES.indexOf(MNEMONIC[o]);
  const m = MNEMONIC[o];
  KIND[o] = MODE[o] === IMP ? 0 : READS.has(m) ? 1 : WRITES.has(m) ? 2 : RMWS.has(m) ? 3 : 0;
}
const I: Record<string, number> = Object.fromEntries(NAMES.map((n, i) => [n, i]));

export type BusRead = (addr: number) => number;
export type BusWrite = (addr: number, value: number) => void;

export class Cpu6510 {
  a = 0; x = 0; y = 0; s = 0xfd; pc = 0;
  /** Flags, each 0 or 1 (z: 1 = the result was zero). */
  c = 0; z = 0; i = 1; d = 0; v = 0; n = 0;

  /** Bus cycles run (the machine may also count its own). */
  cycles = 0;
  /** A JAM opcode stopped the CPU; only a reset starts it again. */
  jammed = false;

  /** IRQ sources holding the line low, one bit each (VIC, CIA1, cartridge). */
  irqLine = 0;
  private nmiLevel = false;
  /** An NMI edge seen and not yet served. */
  nmiPending = false;

  // The interrupt samples of the last three cycles (bit 0 IRQ, bit 1 NMI).
  private poll0 = 0; private poll1 = 0; private poll2 = 0;
  /** What the last instruction decided to serve next: 0, 1 IRQ, 2 NMI. */
  private next = 0;

  constructor(public read: BusRead, public write: BusWrite) {}

  get p(): number {
    return (this.n << 7) | (this.v << 6) | FLAG_U | FLAG_B | (this.d << 3) | (this.i << 2) | (this.z << 1) | this.c;
  }
  set p(v: number) {
    this.n = (v >> 7) & 1; this.v = (v >> 6) & 1; this.d = (v >> 3) & 1;
    this.i = (v >> 2) & 1; this.z = (v >> 1) & 1; this.c = v & 1;
  }

  /** The NMI line (true = held low). The CPU acts on the falling edge. */
  setNmi(low: boolean): void {
    if (low && !this.nmiLevel) this.nmiPending = true;
    this.nmiLevel = low;
  }

  /** RESET: the real chip's 7 cycles, three of them fake pushes (reads). */
  reset(): void {
    this.jammed = false;
    this.next = 0; this.nmiPending = false; this.poll0 = this.poll1 = this.poll2 = 0;
    this.rd(this.pc); this.rd(this.pc);
    this.rd(0x100 | this.s); this.s = (this.s - 1) & 0xff;
    this.rd(0x100 | this.s); this.s = (this.s - 1) & 0xff;
    this.rd(0x100 | this.s); this.s = (this.s - 1) & 0xff;
    this.i = 1;
    const lo = this.rd(0xfffc);
    this.pc = lo | (this.rd(0xfffd) << 8);
  }

  private rd(addr: number): number {
    const v = this.read(addr);
    this.cycles++;
    this.sample();
    return v;
  }
  private wr(addr: number, v: number): void {
    this.write(addr, v);
    this.cycles++;
    this.sample();
  }
  private sample(): void {
    this.poll2 = this.poll1; this.poll1 = this.poll0;
    this.poll0 = (this.irqLine !== 0 && !this.i ? 1 : 0) | (this.nmiPending ? 2 : 0);
  }
  private decide(poll: number): void {
    this.next = poll & 2 ? 2 : poll & 1 ? 1 : 0;
  }

  private push(v: number): void { this.wr(0x100 | this.s, v); this.s = (this.s - 1) & 0xff; }
  private nz(v: number): void { this.n = (v >> 7) & 1; this.z = v === 0 ? 1 : 0; }

  /** IRQ or NMI: 7 cycles; an NMI arriving before the vector takes it over. */
  private interrupt(): void {
    this.rd(this.pc); this.rd(this.pc);
    this.enter(0);
  }
  /** The pushes and the vector, shared by IRQ, NMI and BRK (b = the B flag). */
  private enter(b: number): void {
    this.push(this.pc >> 8);
    this.push(this.pc & 0xff);
    const nmi = this.nmiPending;
    this.push((this.p & ~FLAG_B) | b);
    this.i = 1;
    let vec = 0xfffe;
    if (nmi) { vec = 0xfffa; this.nmiPending = false; }
    const lo = this.rd(vec);
    this.pc = lo | (this.rd(vec + 1) << 8);
    // The first instruction of a handler always runs.
    this.next = 0;
  }

  /** The next step serves an interrupt rather than the instruction at PC. */
  get interruptPending(): boolean { return this.next !== 0 || this.jammed; }

  /** RTS done by a trap: back to the caller of the routine PC is in. */
  returnFromTrap(read: (a: number) => number): void {
    this.s = (this.s + 1) & 0xff;
    const lo = read(0x100 | this.s);
    this.s = (this.s + 1) & 0xff;
    const hi = read(0x100 | this.s);
    this.pc = ((lo | (hi << 8)) + 1) & 0xffff;
  }

  /** Runs one instruction, or the interrupt the last one decided on. */
  step(): void {
    if (this.jammed) { this.rd(0xffff); return; }
    if (this.next) { this.interrupt(); return; }
    const op = this.rd(this.pc);
    this.pc = (this.pc + 1) & 0xffff;
    this.exec(op);
  }

  private exec(op: number): void {
    const id = ID[op];
    const mode = MODE[op];
    const kind = KIND[op];

    if (kind !== 0 || mode === IMM) {
      // Operand instructions: find the address (or the immediate byte).
      if (mode === IMM) {
        const v = this.rd(this.pc); this.pc = (this.pc + 1) & 0xffff;
        this.decide(this.poll1);
        this.alu(id, v, op);
        return;
      }
      if (mode === ACC) { this.rd(this.pc); this.decide(this.poll1); this.a = this.shift(id, this.a); return; }
      const addr = this.address(mode, kind, id);
      if (kind === 1) {
        const v = this.rd(addr);
        this.decide(this.poll1);
        this.alu(id, v, op);
      } else if (kind === 2) {
        this.store(id, addr);
        this.decide(this.poll1);
      } else {
        const v = this.rd(addr);
        this.wr(addr, v); // the NMOS chip writes the old value back first
        const r = this.rmw(id, v);
        this.wr(addr, r);
        this.decide(this.poll1);
      }
      return;
    }

    switch (id) {
      case I.BRK: {
        this.rd(this.pc); this.pc = (this.pc + 1) & 0xffff;
        this.enter(FLAG_B);
        return;
      }
      case I.JSR: {
        const lo = this.rd(this.pc); this.pc = (this.pc + 1) & 0xffff;
        this.rd(0x100 | this.s);
        this.push(this.pc >> 8); this.push(this.pc & 0xff);
        const hi = this.rd(this.pc);
        this.pc = lo | (hi << 8);
        this.decide(this.poll1);
        return;
      }
      case I.RTS: {
        this.rd(this.pc);
        this.rd(0x100 | this.s); this.s = (this.s + 1) & 0xff;
        const lo = this.rd(0x100 | this.s); this.s = (this.s + 1) & 0xff;
        const hi = this.rd(0x100 | this.s);
        this.pc = lo | (hi << 8);
        this.rd(this.pc); this.pc = (this.pc + 1) & 0xffff;
        this.decide(this.poll1);
        return;
      }
      case I.RTI: {
        this.rd(this.pc);
        this.rd(0x100 | this.s); this.s = (this.s + 1) & 0xff;
        this.p = this.rd(0x100 | this.s); this.s = (this.s + 1) & 0xff;
        const lo = this.rd(0x100 | this.s); this.s = (this.s + 1) & 0xff;
        const hi = this.rd(0x100 | this.s);
        this.pc = lo | (hi << 8);
        this.decide(this.poll1);
        return;
      }
      case I.JMP: {
        const lo = this.rd(this.pc); this.pc = (this.pc + 1) & 0xffff;
        const hi = this.rd(this.pc);
        if (mode === ABS) { this.pc = lo | (hi << 8); this.decide(this.poll1); return; }
        const ptr = lo | (hi << 8);
        const tlo = this.rd(ptr);
        // The pointer's high byte comes from the same page (the 6502's JMP bug).
        const thi = this.rd((ptr & 0xff00) | ((ptr + 1) & 0xff));
        this.pc = tlo | (thi << 8);
        this.decide(this.poll1);
        return;
      }
      case I.PHA: this.rd(this.pc); this.push(this.a); this.decide(this.poll1); return;
      case I.PHP: this.rd(this.pc); this.push(this.p); this.decide(this.poll1); return;
      case I.PLA:
        this.rd(this.pc); this.rd(0x100 | this.s); this.s = (this.s + 1) & 0xff;
        this.a = this.rd(0x100 | this.s); this.nz(this.a); this.decide(this.poll1); return;
      case I.PLP:
        this.rd(this.pc); this.rd(0x100 | this.s); this.s = (this.s + 1) & 0xff;
        { const v = this.rd(0x100 | this.s); this.decide(this.poll1); this.p = v; }
        return;
      case I.JAM:
        // The bus floats to FFFFh and the chip never fetches again.
        this.rd(this.pc); this.rd(0xffff); this.rd(0xfffe); this.rd(0xfffe);
        this.jammed = true;
        return;
    }

    if (mode === REL) { this.branch(id); return; }

    // Two-cycle implied instructions: the second cycle reads the next byte.
    this.rd(this.pc);
    this.decide(this.poll1);
    switch (id) {
      case I.CLC: this.c = 0; break;
      case I.SEC: this.c = 1; break;
      case I.CLI: this.i = 0; break;
      case I.SEI: this.i = 1; break;
      case I.CLD: this.d = 0; break;
      case I.SED: this.d = 1; break;
      case I.CLV: this.v = 0; break;
      case I.TAX: this.x = this.a; this.nz(this.x); break;
      case I.TAY: this.y = this.a; this.nz(this.y); break;
      case I.TXA: this.a = this.x; this.nz(this.a); break;
      case I.TYA: this.a = this.y; this.nz(this.a); break;
      case I.TSX: this.x = this.s; this.nz(this.x); break;
      case I.TXS: this.s = this.x; break;
      case I.INX: this.x = (this.x + 1) & 0xff; this.nz(this.x); break;
      case I.INY: this.y = (this.y + 1) & 0xff; this.nz(this.y); break;
      case I.DEX: this.x = (this.x - 1) & 0xff; this.nz(this.x); break;
      case I.DEY: this.y = (this.y - 1) & 0xff; this.nz(this.y); break;
      case I.NOP: break;
    }
  }

  private branch(id: number): void {
    const off = this.rd(this.pc); this.pc = (this.pc + 1) & 0xffff;
    let take: boolean;
    switch (id) {
      case I.BPL: take = !this.n; break;
      case I.BMI: take = !!this.n; break;
      case I.BVC: take = !this.v; break;
      case I.BVS: take = !!this.v; break;
      case I.BCC: take = !this.c; break;
      case I.BCS: take = !!this.c; break;
      case I.BNE: take = !this.z; break;
      default: take = !!this.z; break;
    }
    if (!take) { this.decide(this.poll1); return; }
    this.rd(this.pc);
    const target = (this.pc + ((off << 24) >> 24)) & 0xffff;
    if ((target & 0xff00) === (this.pc & 0xff00)) {
      this.pc = target;
      // A taken branch within its page does not poll on its last cycle.
      this.decide(this.poll2);
      return;
    }
    this.rd((this.pc & 0xff00) | (target & 0xff));
    this.pc = target;
    this.decide(this.poll1);
  }

  /** The effective address, with each mode's dummy accesses. */
  private address(mode: number, kind: number, id: number): number {
    const pc = this.pc;
    switch (mode) {
      case ZP: this.pc = (pc + 1) & 0xffff; return this.rd(pc);
      case ZPX: case ZPY: {
        const base = this.rd(pc); this.pc = (pc + 1) & 0xffff;
        this.rd(base);
        return (base + (mode === ZPX ? this.x : this.y)) & 0xff;
      }
      case ABS: {
        const lo = this.rd(pc);
        const hi = this.rd((pc + 1) & 0xffff);
        this.pc = (pc + 2) & 0xffff;
        return lo | (hi << 8);
      }
      case ABX: case ABY: {
        const lo = this.rd(pc);
        const hi = this.rd((pc + 1) & 0xffff);
        this.pc = (pc + 2) & 0xffff;
        const idx = mode === ABX ? this.x : this.y;
        return this.indexed(lo, hi, idx, kind, id);
      }
      case IZX: {
        const ptr = this.rd(pc); this.pc = (pc + 1) & 0xffff;
        this.rd(ptr);
        const p = (ptr + this.x) & 0xff;
        const lo = this.rd(p);
        const hi = this.rd((p + 1) & 0xff);
        return lo | (hi << 8);
      }
      case IZY: {
        const ptr = this.rd(pc); this.pc = (pc + 1) & 0xffff;
        const lo = this.rd(ptr);
        const hi = this.rd((ptr + 1) & 0xff);
        return this.indexed(lo, hi, this.y, kind, id);
      }
    }
    throw new Error(`mode ${mode}`);
  }

  /** base + index: the chip first reads with the low byte added and no carry. */
  private hiPlus1 = 0;
  private crossed = false;
  private indexed(lo: number, hi: number, idx: number, kind: number, _id: number): number {
    const sum = lo + idx;
    const partial = (hi << 8) | (sum & 0xff);
    this.crossed = sum > 0xff;
    this.hiPlus1 = (hi + 1) & 0xff;
    if (kind === 1 && !this.crossed) return partial;
    this.rd(partial);
    return ((hi << 8) + sum) & 0xffff;
  }

  private store(id: number, addr: number): void {
    switch (id) {
      case I.STA: this.wr(addr, this.a); return;
      case I.STX: this.wr(addr, this.x); return;
      case I.STY: this.wr(addr, this.y); return;
      case I.SAX: this.wr(addr, this.a & this.x); return;
      // The unstable stores AND with the base's high byte + 1; when the
      // index crosses a page, that value also becomes the high byte.
      case I.SHA: this.unstable(addr, this.a & this.x); return;
      case I.SHX: this.unstable(addr, this.x); return;
      case I.SHY: this.unstable(addr, this.y); return;
      case I.TAS: this.s = this.a & this.x; this.unstable(addr, this.s); return;
    }
  }
  private unstable(addr: number, v: number): void {
    const value = v & this.hiPlus1;
    if (this.crossed) addr = (value << 8) | (addr & 0xff);
    this.wr(addr, value);
  }

  private shift(id: number, v: number): number {
    let r: number;
    switch (id) {
      case I.ASL: this.c = v >> 7; r = (v << 1) & 0xff; break;
      case I.LSR: this.c = v & 1; r = v >> 1; break;
      case I.ROL: r = ((v << 1) | this.c) & 0xff; this.c = v >> 7; break;
      default: r = (v >> 1) | (this.c << 7); this.c = v & 1; break; // ROR
    }
    this.nz(r);
    return r;
  }

  private rmw(id: number, v: number): number {
    switch (id) {
      case I.ASL: case I.LSR: case I.ROL: case I.ROR: return this.shift(id, v);
      case I.INC: { const r = (v + 1) & 0xff; this.nz(r); return r; }
      case I.DEC: { const r = (v - 1) & 0xff; this.nz(r); return r; }
      case I.SLO: { const r = this.shift(I.ASL, v); this.a |= r; this.nz(this.a); return r; }
      case I.RLA: { const r = this.shift(I.ROL, v); this.a &= r; this.nz(this.a); return r; }
      case I.SRE: { const r = this.shift(I.LSR, v); this.a ^= r; this.nz(this.a); return r; }
      case I.RRA: { const r = this.shift(I.ROR, v); this.adc(r); return r; }
      case I.DCP: { const r = (v - 1) & 0xff; this.compare(this.a, r); return r; }
      default: { const r = (v + 1) & 0xff; this.sbc(r); return r; } // ISC
    }
  }

  private compare(reg: number, v: number): void {
    const r = reg - v;
    this.c = r >= 0 ? 1 : 0;
    this.nz(r & 0xff);
  }

  private adc(v: number): void {
    const a = this.a, c = this.c;
    if (!this.d) {
      const r = a + v + c;
      this.v = (~(a ^ v) & (a ^ r) & 0x80) ? 1 : 0;
      this.c = r > 0xff ? 1 : 0;
      this.a = r & 0xff;
      this.nz(this.a);
      return;
    }
    // NMOS decimal mode: Z from the binary sum, N and V from the half-adjusted one.
    let t = (a & 0xf) + (v & 0xf) + c;
    if (t > 9) t += 6;
    t = t <= 0x0f ? (t & 0xf) + (a & 0xf0) + (v & 0xf0) : (t & 0xf) + (a & 0xf0) + (v & 0xf0) + 0x10;
    this.z = ((a + v + c) & 0xff) === 0 ? 1 : 0;
    this.n = (t >> 7) & 1;
    this.v = ((a ^ t) & 0x80) && !((a ^ v) & 0x80) ? 1 : 0;
    if ((t & 0x1f0) > 0x90) t += 0x60;
    this.c = (t & 0xff0) > 0xf0 ? 1 : 0;
    this.a = t & 0xff;
  }

  private sbc(v: number): void {
    const a = this.a, borrow = this.c ? 0 : 1;
    const t = (a - v - borrow) & 0xffff;
    // Flags always come from the binary difference on the NMOS chip.
    this.c = t < 0x100 ? 1 : 0;
    this.v = ((a ^ t) & 0x80) && ((a ^ v) & 0x80) ? 1 : 0;
    this.nz(t & 0xff);
    if (!this.d) { this.a = t & 0xff; return; }
    let lo = (a & 0xf) - (v & 0xf) - borrow;
    let r: number;
    if (lo & 0x10) r = ((lo - 6) & 0xf) | ((a & 0xf0) - (v & 0xf0) - 0x10);
    else r = (lo & 0xf) | ((a & 0xf0) - (v & 0xf0));
    if (r & 0x100) r -= 0x60;
    this.a = r & 0xff;
  }

  private alu(id: number, v: number, op: number): void {
    switch (id) {
      case I.LDA: this.a = v; this.nz(v); return;
      case I.LDX: this.x = v; this.nz(v); return;
      case I.LDY: this.y = v; this.nz(v); return;
      case I.LAX: this.a = this.x = v; this.nz(v); return;
      case I.AND: this.a &= v; this.nz(this.a); return;
      case I.ORA: this.a |= v; this.nz(this.a); return;
      case I.EOR: this.a ^= v; this.nz(this.a); return;
      case I.ADC: this.adc(v); return;
      case I.SBC: this.sbc(v); return;
      case I.CMP: this.compare(this.a, v); return;
      case I.CPX: this.compare(this.x, v); return;
      case I.CPY: this.compare(this.y, v); return;
      case I.BIT:
        this.n = (v >> 7) & 1; this.v = (v >> 6) & 1; this.z = (this.a & v) === 0 ? 1 : 0;
        return;
      case I.NOP: return;
      case I.LAS: this.a = this.x = this.s = v & this.s; this.nz(this.a); return;
      case I.ANC: this.a &= v; this.nz(this.a); this.c = this.n; return;
      case I.ALR: this.a &= v; this.a = this.shift(I.LSR, this.a); return;
      case I.ARR: this.arr(v); return;
      // ANE and LXA mix in the chip's unstable "magic" constant; EEh is the usual value.
      case I.ANE: this.a = (this.a | 0xee) & this.x & v; this.nz(this.a); return;
      case I.LXA: this.a = this.x = (this.a | 0xee) & v; this.nz(this.a); return;
      case I.SBX: {
        const r = (this.a & this.x) - v;
        this.c = r >= 0 ? 1 : 0;
        this.x = r & 0xff; this.nz(this.x);
        return;
      }
    }
    throw new Error(`alu ${MNEMONIC[op]}`);
  }

  private arr(v: number): void {
    const t = this.a & v;
    if (!this.d) {
      const r = (t >> 1) | (this.c << 7);
      this.nz(r);
      this.c = (r >> 6) & 1;
      this.v = ((r >> 6) ^ (r >> 5)) & 1;
      this.a = r;
      return;
    }
    let r = (t >> 1) | (this.c << 7);
    this.n = this.c;
    this.z = r === 0 ? 1 : 0;
    this.v = ((r ^ t) & 0x40) ? 1 : 0;
    if ((t & 0xf) + (t & 0x1) > 5) r = (r & 0xf0) | ((r + 6) & 0xf);
    if ((t & 0xf0) + (t & 0x10) > 0x50) { r = (r & 0x0f) | ((r + 0x60) & 0xf0); this.c = 1; } else this.c = 0;
    this.a = r & 0xff;
  }
}
