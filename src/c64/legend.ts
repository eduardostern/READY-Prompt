/**
 * The C64 keyboard as printed, for the on-screen keyboard: each key's name
 * in the matrix (keyboard.ts), its label, and what SHIFT gives on it.
 */

export interface KeyCap { key: string; label: string; shifted?: string; wide?: number }

const k = (key: string, label = key, shifted?: string, wide?: number): KeyCap => ({ key, label, shifted, wide });

export const LAYOUT: KeyCap[][] = [
  [k('←'), k('1', '1', '!'), k('2', '2', '"'), k('3', '3', '#'), k('4', '4', '$'), k('5', '5', '%'), k('6', '6', '&'),
    k('7', '7', "'"), k('8', '8', '('), k('9', '9', ')'), k('0'), k('+'), k('-'), k('£'), k('HOME', 'CLR HOME'),
    k('DEL', 'INST DEL'), k('F1', 'F1', 'F2')],
  [k('CTRL', 'CTRL', undefined, 1.5), k('Q'), k('W'), k('E'), k('R'), k('T'), k('Y'), k('U'), k('I'), k('O'), k('P'),
    k('@'), k('*'), k('↑', '↑', 'π'), k('RESTORE', 'RESTORE', undefined, 1.5), k('F3', 'F3', 'F4')],
  [k('STOP', 'RUN STOP', undefined, 1.25), k('A'), k('S'), k('D'), k('F'), k('G'), k('H'), k('J'), k('K'), k('L'),
    k(':', ':', '['), k(';', ';', ']'), k('='), k('RETURN', 'RETURN', undefined, 1.75), k('F5', 'F5', 'F6')],
  [k('C=', 'C='), k('LSHIFT', 'SHIFT', undefined, 1.5), k('Z'), k('X'), k('C'), k('V'), k('B'), k('N'), k('M'),
    k(',', ',', '<'), k('.', '.', '>'), k('/', '/', '?'), k('RSHIFT', 'SHIFT', undefined, 1.5), k('DOWN', 'CRSR ⇅'),
    k('RIGHT', 'CRSR ⇄'), k('F7', 'F7', 'F8')],
  [k('SPACE', '', undefined, 9)],
];

/** Keys that latch on the on-screen keyboard until the next key. */
export const MODIFIERS = new Set(['LSHIFT', 'RSHIFT', 'CTRL', 'C=']);
