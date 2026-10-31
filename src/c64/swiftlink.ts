/**
 * The SwiftLink: a 6551 ACIA at DE00h-DE03h on the cartridge port, its
 * interrupt on NMI, wired here to the Hayes modem. CCGMS, Novaterm and
 * the other terminals of the 1990s all speak to it, and so does TERM.
 *
 *   DE00h  data: read the byte received, write a byte to send
 *   DE01h  status (read): 0-2 errors, 3 a byte received, 4 ready to send,
 *          5 DCD (0 = carrier), 6 DSR (0 = ready), 7 interrupt; a write resets
 *   DE02h  command: 0 DTR, 1 no receive interrupt, 2-3 transmit control
 *   DE03h  control: 0-3 baud rate, 5-6 word length, 7 stop bits
 *
 * Its crystal is twice the 6551's usual (3.6864 MHz), so every rate in the
 * table is doubled: 15 is 38400 baud. Bytes from the line arrive at the
 * chosen rate, and wait for the C64 to read them rather than overrun.
 */
import { MODEM_CARRIER, type Modem } from './modem';

/** Baud rates for control bits 0-3 with the SwiftLink's crystal (0: 16× external clock). */
const BAUD = [230400, 100, 150, 220, 269, 300, 600, 1200, 2400, 3600, 4800, 7200, 9600, 14400, 19200, 38400];

export class SwiftLink {
  private command = 0;
  private control = 0;
  private rxByte = 0;
  private rxFull = false;
  private irqFlag = false;
  /** Cycles until the line can deliver the next byte, and until the transmitter is free. */
  private rxWait = 0;
  private txWait = 0;

  constructor(readonly modem: Modem, private clockHz: number) {}

  setClock(hz: number): void { this.clockHz = hz; }

  reset(): void {
    if (this.command & 1) this.modem.control(0); // DTR dropped: hang up
    this.command = 0;
    this.control = 0;
    this.rxFull = false;
    this.irqFlag = false;
    this.rxWait = this.txWait = 0;
  }

  /** The NMI line: a byte waiting with receive interrupts on. */
  get nmi(): boolean { return this.irqFlag; }

  get baud(): number { return BAUD[this.control & 15]; }

  /** Cycles one byte takes on the line (start, 8 data, stop). */
  private get byteCycles(): number { return Math.max(1, Math.round((this.clockHz * 10) / this.baud)); }

  read(a: number): number {
    switch (a & 3) {
      case 0:
        this.rxFull = false;
        this.irqFlag = false;
        return this.rxByte;
      case 1: {
        const carrier = (this.modem.status() & MODEM_CARRIER) !== 0;
        const v = (this.rxFull ? 0x08 : 0) | (this.txWait <= 0 ? 0x10 : 0) | (carrier ? 0 : 0x20) | (this.irqFlag ? 0x80 : 0);
        this.irqFlag = false;
        return v;
      }
      case 2: return this.command;
      default: return this.control;
    }
  }

  write(a: number, v: number): void {
    switch (a & 3) {
      case 0:
        this.modem.write(v);
        this.txWait = this.byteCycles;
        return;
      case 1: // programmed reset
        this.setCommand(this.command & 0xe0);
        this.irqFlag = false;
        return;
      case 2: this.setCommand(v); return;
      default: this.control = v; return;
    }
  }

  private setCommand(v: number): void {
    const dtrWas = this.command & 1;
    this.command = v;
    if (dtrWas && !(v & 1)) this.modem.control(0);
    else if (!dtrWas && (v & 1)) this.modem.control(1);
  }

  /** One machine cycle. */
  tick(): void {
    if (this.txWait > 0) this.txWait--;
    if (this.rxWait > 0) { this.rxWait--; return; }
    if (this.rxFull || !(this.command & 1) || !this.modem.available) return;
    this.rxByte = this.modem.read();
    this.rxFull = true;
    this.rxWait = this.byteCycles;
    if (!(this.command & 2)) this.irqFlag = true;
  }
}
