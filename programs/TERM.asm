; TERM: a terminal for the SwiftLink modem, READY-Prompt's own.
;
; Two modes, F1 switches:
;   ANSI     its own 40 x 25 screen in the lower-case set: ASCII, ANSI
;            escape codes (cursor, colours, reverse, clear, ESC[6n), CP437
;            box drawing as the C64's graphics; keys go out as ASCII
;   PETSCII  bytes go to the KERNAL's CHROUT as they come, the way
;            Commodore boards expect; keys go out as typed
; F7 goes back to BASIC with the call still up (SYS 2061 returns).
;
; Built by scripts/build-term.ts, which puts the tables in at ;@TABLES.

ACIA_DATA = $DE00
ACIA_STAT = $DE01
ACIA_CMD  = $DE02
ACIA_CTRL = $DE03
CHROUT    = $FFD2
GETIN     = $FFE4
QTSW      = $D4         ; the KERNAL's quote mode
INSRT     = $D8         ; and its insert count
PTR       = $FB         ; the cursor's line in screen memory
CPTR      = $FD         ; and in colour memory

        * = $0801
        .word basend, 10
        .byte $9E, "2061", 0
basend: .word 0

start:  LDA #$1F            ; 38400 baud, 8 bits, 1 stop
        STA ACIA_CTRL
        LDA #$0B            ; DTR on, receive interrupt off, RTS low
        STA ACIA_CMD
        LDA #0
        STA $D020
        STA $D021
        STA quit
        LDA #$80            ; SHIFT + C= may not switch the character set
        STA $0291
        JSR enter

main:   JSR GETIN
        BEQ poll
        JSR key
        LDA quit
        BNE leave
poll:   LDA ACIA_STAT
        AND #$08
        BEQ main
        LDA ACIA_DATA
        LDX mode
        BEQ pet
        JSR ansi
        JMP main
pet:    JSR petout
        JMP main

leave:  LDA mode
        BEQ lv1
        JSR curoff
lv1:    LDA #0
        STA $0291
        LDA #$8E            ; capitals and graphics again
        JSR CHROUT
        LDA #$9A            ; light blue, as BASIC prints
        JSR CHROUT
        LDA #$93
        JSR CHROUT
        LDA #6
        STA $D021
        LDA #14
        STA $D020
        LDX #<byemsg
        LDY #>byemsg
        JMP pstr

; ---- keys ---------------------------------------------------------------

key:    CMP #$85            ; F1: the other mode
        BNE k1
        LDA mode
        EOR #1
        STA mode
        JMP enter
k1:     CMP #$88            ; F7: back to BASIC
        BNE k2
        INC quit
        RTS
k2:     LDX mode
        BNE kansi
        JMP send            ; PETSCII: as typed
kansi:  CMP #$91
        BEQ kup
        CMP #$11
        BEQ kdown
        CMP #$1D
        BEQ kright
        CMP #$9D
        BEQ kleft
        TAX
        LDA keytab,X
        BEQ kno
        JMP send
kno:    RTS
kup:    LDA #'A'
        JMP csi1
kdown:  LDA #'B'
        JMP csi1
kright: LDA #'C'
        JMP csi1
kleft:  LDA #'D'
csi1:   PHA
        LDA #27
        JSR send
        LDA #'['
        JSR send
        PLA
        JMP send

; A byte to the line, when the ACIA can take it (keeps X and Y).
send:   PHA
sw:     LDA ACIA_STAT
        AND #$10
        BEQ sw
        PLA
        STA ACIA_DATA
        RTS

; ---- modes --------------------------------------------------------------

enter:  LDA mode
        BEQ epet
        LDA #$17            ; lower-case set, screen at 0400h
        STA $D018
        LDA #7
        STA fg
        LDA #0
        STA bold
        STA rvs
        STA state
        JSR setcol
        JSR cls
        LDX #<banner
        LDY #>banner
        JSR astr
        JMP curon
epet:   LDA #0
        STA cur
        LDA #$8E            ; capitals and graphics
        JSR CHROUT
        LDA #$05            ; white
        JSR CHROUT
        LDA #$93
        JSR CHROUT
        LDX #<petban
        LDY #>petban
        JMP pstr

; PETSCII through the KERNAL, quote and insert mode undone after each byte.
petout: JSR CHROUT
        LDA #0
        STA QTSW
        STA INSRT
        RTS

; A zero-terminated string at X/Y: astr through the ANSI screen, pstr through CHROUT.
astr:   STX as1+1
        STY as1+2
        LDA #0
        STA sidx
as0:    LDY sidx
as1:    LDA $FFFF,Y
        BEQ asd
        JSR ansido
        INC sidx
        BNE as0
asd:    RTS

pstr:   STX ps1+1
        STY ps1+2
        LDA #0
        STA sidx
ps0:    LDY sidx
ps1:    LDA $FFFF,Y
        BEQ psd
        JSR petout
        INC sidx
        BNE ps0
psd:    RTS

; ---- the ANSI screen ----------------------------------------------------

ansi:   PHA
        JSR curoff
        PLA
        JSR ansido
        JMP curon

ansido: LDX state
        BEQ normal
        CPX #1
        BEQ gotesc
        JMP csi

normal: CMP #$20
        BCS print
        CMP #13
        BNE n1
        LDA #0
        STA col
        RTS
n1:     CMP #10
        BNE n2
        JMP lf
n2:     CMP #8
        BNE n3
        LDA col
        BEQ nr
        DEC col
nr:     RTS
n3:     CMP #9
        BNE n4
        LDA col
        ORA #7
        CMP #39
        BCS ntab
        ADC #1
        STA col
        RTS
ntab:   LDA #39
        STA col
        RTS
n4:     CMP #27
        BNE n5
        LDA #1
        STA state
        RTS
n5:     CMP #12
        BNE nr
        JMP cls

print:  CMP #$7F
        BEQ nr
        BCS high
        TAX
        LDA asctab-32,X
        JMP putsc
high:   TAX
        LDA cp437-128,X
        JMP putsc

gotesc: CMP #'['
        BNE ge1
        LDA #2
        STA state
        LDA #0
        STA nparm
        LDX #7
ge0:    STA parm,X
        DEX
        BPL ge0
        RTS
ge1:    LDA #0
        STA state
        RTS

csi:    CMP #'0'
        BCC c1
        CMP #':'
        BCS c1
        SEC
        SBC #'0'
        STA tmp
        LDX nparm
        LDA parm,X
        CMP #26
        BCS cap
        ASL
        STA tmp2
        ASL
        ASL
        CLC
        ADC tmp2
        ADC tmp
        BCS cap
        STA parm,X
        RTS
cap:    LDA #255
        STA parm,X
        RTS
c1:     CMP #';'
        BNE c2
        LDA nparm
        CMP #7
        BCS c1r
        INC nparm
c1r:    RTS
c2:     CMP #$40
        BCS final
        RTS                 ; '?' and the like: carry on

final:  LDX #0
        STX state
        CMP #'m'
        BNE f1
        JMP sgr
f1:     CMP #'H'
        BEQ goto
        CMP #'f'
        BEQ goto
        CMP #'A'
        BNE fb
        JMP cup
fb:     CMP #'B'
        BNE fc
        JMP cdown
fc:     CMP #'C'
        BNE fd
        JMP cright
fd:     CMP #'D'
        BNE fj
        JMP cleft
fj:     CMP #'J'
        BNE f2
        JMP erasej
f2:     CMP #'K'
        BNE f3
        JMP erasek
f3:     CMP #'s'
        BNE f4
        LDA row
        STA srow
        LDA col
        STA scol
        RTS
f4:     CMP #'u'
        BNE f5
        LDA srow
        STA row
        LDA scol
        STA col
        RTS
f5:     CMP #'n'
        BNE f6
        LDA parm
        CMP #6
        BNE f6
        JMP report
f6:     RTS

goto:   LDA parm
        BEQ g1
        SEC
        SBC #1
g1:     CMP #25
        BCC g2
        LDA #24
g2:     STA row
        LDA parm+1
        BEQ g3
        SEC
        SBC #1
g3:     CMP #40
        BCC g4
        LDA #39
g4:     STA col
        RTS

; The count of a cursor move: its parameter, 1 if none.
count:  LDA parm
        BNE cn1
        LDA #1
cn1:    STA tmp
        RTS

cup:    JSR count
        LDA row
        SEC
        SBC tmp
        BCS cu1
        LDA #0
cu1:    STA row
        RTS
cdown:  JSR count
        LDA row
        CLC
        ADC tmp
        BCS cd0
        CMP #25
        BCC cd1
cd0:    LDA #24
cd1:    STA row
        RTS
cright: JSR count
        LDA col
        CLC
        ADC tmp
        BCS cr0
        CMP #40
        BCC cr1
cr0:    LDA #39
cr1:    STA col
        RTS
cleft:  JSR count
        LDA col
        SEC
        SBC tmp
        BCS cl1
        LDA #0
cl1:    STA col
        RTS

; ESC[n J: 2 (or 3) clears the screen, 0 from the cursor to the end.
erasej: LDA parm
        CMP #2
        BCC ej0
        JMP cls
ej0:    BNE ejd
        LDA row
        PHA
        LDA col
        STA tmp
        LDA #39
        STA tmp2
        JSR blank
ej1:    INC row
        LDA row
        CMP #25
        BCS ej2
        LDA #0
        STA tmp
        JSR blank
        JMP ej1
ej2:    PLA
        STA row
ejd:    RTS

; ESC[n K: 0 to the end of the line, 1 from its start, 2 all of it.
erasek: LDA parm
        BNE ek1
        LDA col
        STA tmp
        LDA #39
        STA tmp2
        JMP blank
ek1:    CMP #1
        BNE ek2
        LDA #0
        STA tmp
        LDA col
        STA tmp2
        JMP blank
ek2:    LDA #0
        STA tmp
        LDA #39
        STA tmp2
        ; fall into blank

; Spaces on line `row` from column tmp to tmp2.
blank:  JSR setptr
        LDY tmp
bl1:    LDA #32
        STA (PTR),Y
        LDA color
        STA (CPTR),Y
        CPY tmp2
        BCS bl2
        INY
        BNE bl1
bl2:    RTS

; ESC[6n: where the cursor is, as ESC[row;colR.
report: LDA #27
        JSR send
        LDA #'['
        JSR send
        LDA row
        CLC
        ADC #1
        JSR senddec
        LDA #';'
        JSR send
        LDA col
        CLC
        ADC #1
        JSR senddec
        LDA #'R'
        JMP send

senddec: LDX #0
sd1:    CMP #10
        BCC sd2
        SBC #10
        INX
        BNE sd1
sd2:    PHA
        TXA
        BEQ sd3
        ORA #$30
        JSR send
sd3:    PLA
        ORA #$30
        JMP send

; ESC[...m: colours, bold, reverse.
sgr:    LDX #0
sg0:    LDA parm,X
        JSR attr
        INX
        CPX nparm
        BCC sg0
        BEQ sg0
        ; fall into setcol
setcol: LDA bold
        ASL
        ASL
        ASL
        ORA fg
        TAX
        LDA ansicol,X
        STA color
        RTS

attr:   CMP #0
        BNE at1
        STA bold
        STA rvs
        LDA #7
        STA fg
        RTS
at1:    CMP #1
        BNE at2
        STA bold
        RTS
at2:    CMP #7
        BNE at3
        LDA #1
        STA rvs
        RTS
at3:    CMP #22
        BNE at4
        LDA #0
        STA bold
        RTS
at4:    CMP #27
        BNE at5
        LDA #0
        STA rvs
        RTS
at5:    CMP #39
        BNE at6
        LDA #7
        STA fg
        RTS
at6:    CMP #30
        BCC atx
        CMP #38
        BCS atx
        SEC
        SBC #30
        STA fg
atx:    RTS

; A screen code at the cursor, then the cursor on (wrapping and scrolling).
putsc:  LDX rvs
        BEQ pu1
        ORA #$80
pu1:    PHA
        JSR setptr
        LDY col
        PLA
        STA (PTR),Y
        LDA color
        STA (CPTR),Y
        INY
        CPY #40
        BCC pu2
        LDY #0
        STY col
        JMP lf
pu2:    STY col
        RTS

lf:     LDA row
        CMP #24
        BCS scroll
        INC row
        RTS

; Lines 1-24 up one, page by page (each page's copy reads only the next one).
scroll: LDX #0
s1:     LDA $0428,X
        STA $0400,X
        LDA $D828,X
        STA $D800,X
        INX
        BNE s1
s2:     LDA $0528,X
        STA $0500,X
        LDA $D928,X
        STA $D900,X
        INX
        BNE s2
s3:     LDA $0628,X
        STA $0600,X
        LDA $DA28,X
        STA $DA00,X
        INX
        BNE s3
s4:     LDA $0728,X
        STA $0700,X
        LDA $DB28,X
        STA $DB00,X
        INX
        CPX #$C0
        BNE s4
        LDX #39
s5:     LDA #32
        STA $07C0,X
        LDA color
        STA $DBC0,X
        DEX
        BPL s5
        RTS

cls:    LDX #0
cs1:    LDA #32
        STA $0400,X
        STA $0500,X
        STA $0600,X
        STA $06E8,X
        LDA color
        STA $D800,X
        STA $D900,X
        STA $DA00,X
        STA $DAE8,X
        INX
        BNE cs1
        LDA #0
        STA row
        STA col
        STA cur
        RTS

setptr: LDX row
        LDA rowlo,X
        STA PTR
        STA CPTR
        LDA rowhi,X
        STA PTR+1
        CLC
        ADC #$D4
        STA CPTR+1
        RTS

; The cursor: the character under it reversed.
curon:  LDA cur
        BNE cux
        INC cur
        JMP cuflip
curoff: LDA cur
        BEQ cux
        LDA #0
        STA cur
cuflip: JSR setptr
        LDY col
        LDA (PTR),Y
        EOR #$80
        STA (PTR),Y
cux:    RTS

; ---- text and data ------------------------------------------------------
; (.byte strings are ASCII, which is PETSCII for capitals and figures.)

banner: .byte "TERM for the SwiftLink - READY-Prompt", 13, 10
        .byte "F1 PETSCII/ANSI   F7 BASIC", 13, 10
        .byte "ATI lists the boards, ATDT 1 dials one.", 13, 10, 10, 0
petban: .byte "TERM (PETSCII) - F1 ANSI, F7 BASIC"
        .byte 13, 13, 0
byemsg: .byte "BACK IN BASIC, THE CALL STILL UP."
        .byte 13
        .byte "SYS 2061 RETURNS TO TERM."
        .byte 13, 0

; ANSI colours (normal, then bold) as C64 colours.
ansicol: .byte 0, 2, 5, 8, 6, 4, 3, 15
        .byte 11, 10, 13, 7, 14, 4, 3, 1

mode:   .byte 1
quit:   .byte 0
state:  .byte 0
row:    .byte 0
col:    .byte 0
srow:   .byte 0
scol:   .byte 0
color:  .byte 15
fg:     .byte 7
bold:   .byte 0
rvs:    .byte 0
cur:    .byte 0
nparm:  .byte 0
parm:   .fill 8, 0
tmp:    .byte 0
tmp2:   .byte 0
sidx:   .byte 0

;@TABLES
