# ROMs

| File | Chip | CRC32 | SHA-1 | Source |
| --- | --- | --- | --- | --- |
| `basic.901226-01.bin` | BASIC V2 (8K, at A000h) | f833d117 | 79015323128650c742a3694c9429aa91f355905e | the first half of the user's `64c.251913-01.bin` (the C64C's combined BASIC + KERNAL ROM) |
| `kernal.901227-03.bin` | KERNAL, revision 3 (8K, at E000h) | dbe3e7c7 | 1d503e56df85a62fee696e7618dc5b4e781df1bb | the user's dump; byte for byte the second half of `64c.251913-01.bin` |
| `characters.901225-01.bin` | Character generator (4K) | ec4272ee | adc7c31e18c7c7413d54802ef2f4193da14711aa | the user's dump |

These are the three ROMs of every C64 from 1983 on (the C64C merged BASIC
and KERNAL into one chip, 251913-01, with the same contents). The CRCs
match MAME's and VICE's entries.

The ROMs are © Commodore Business Machines; the rights now sit with
Cloanto. They are included as VICE includes them.
