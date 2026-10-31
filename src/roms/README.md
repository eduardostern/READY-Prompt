# ROMs

| File | Chip | CRC32 | SHA-1 | Source |
| --- | --- | --- | --- | --- |
| `basic.901226-01.bin` | BASIC V2 (8K, at A000h) | f833d117 | 79015323128650c742a3694c9429aa91f355905e | the first half of the user's `64c.251913-01.bin` (the C64C's combined BASIC + KERNAL ROM) |
| `kernal.901227-03.bin` | KERNAL, revision 3 (8K, at E000h) | dbe3e7c7 | 1d503e56df85a62fee696e7618dc5b4e781df1bb | the user's dump; byte for byte the second half of `64c.251913-01.bin` |
| `characters.901225-01.bin` | Character generator (4K) | ec4272ee | adc7c31e18c7c7413d54802ef2f4193da14711aa | the user's dump |
| `kernal.901227-01.bin` | KERNAL, revision 1 (1982) | dce782fa | 87cc04d61fc748b82df09856847bb5c2754a2033 | the user's dump |
| `kernal.901227-02.bin` | KERNAL, revision 2 (1982-83) | a5c687b3 | 0e2e4ee3f2d41f00bed72f9ab588b83e306fdb13 | the user's dump |
| `1541-II.251968-03.bin` | 1541-II DOS 2.6 (16K, at C000h) | 899fa3c5 | d3b78c3dbac55f5199f33f3fe0036439811f7fb3 | the user's dump |
| `1541-c000.325302-01.bin` | 1541 DOS 2.6, low half (8K, at C000h) | 29ae9752 | 8e0547430135ba462525c224e76356bd3d430f11 | the user's dump |
| `1541-e000.901229-05.bin` | 1541 DOS 2.6, high half (8K, at E000h) | 361c9f37 | f5d60777440829e46dc91285e662ba072acd2d8b | the user's dump |

The 1541-II ROM has no code for the 1541C's track 0 sensor (Wolfgang
Moser's note on zimmers.net): it finds track 0 by knocking the head
against the stop, which the emulated stepper allows.

BASIC, KERNAL 3 and the characters are the three ROMs of every C64 from 1983 on (the C64C merged BASIC
and KERNAL into one chip, 251913-01, with the same contents). The CRCs
match MAME's and VICE's entries.

The ROMs are © Commodore Business Machines; the rights now sit with
Cloanto. They are included as VICE includes them.
