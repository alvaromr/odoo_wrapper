#!/usr/bin/env python3
"""Minimal QR encoder: byte mode, EC level L, mask 0, versions 1-5 (up to 106 bytes).

Hand-written so the project stays dependency-free: no qrencode, no venv, no network on first run. One EC
block per version, so no interleaving. Do not "fix" it to match a reference library byte for byte: it pads
with 0xEC/0x11 right after the terminator where segno emits an extra 0x00, and both are valid, since a
decoder reads the byte-mode length and ignores the rest. Verify it by decoding instead, e.g. Apple's Vision
(VNDetectBarcodesRequest) from a throwaway swift script, which is how versions 1-5 were checked. The tests
pin the modules of two texts Vision read back: a change that moves any is decoded again before the fixture
is updated. Text longer than 106 bytes raises ValueError, which the dashboard turns into "no QR, URL as
text" rather than a broken /api/data.
"""

SPEC = ((1, 19, 7), (2, 34, 10), (3, 55, 15), (4, 80, 20), (5, 108, 26))
FORMAT = "111011111000100"
PAD = (0xEC, 0x11)
FINDER_EDGE = 3
FINDER_GAP = 2
TIMING = 6

EXP = [0] * 512
LOG = [0] * 256
_x = 1
for _i in range(255):
    EXP[_i] = _x
    LOG[_x] = _i
    _x = (_x << 1) ^ 0x11D if _x & 0x80 else _x << 1
for _i in range(255, 512):
    EXP[_i] = EXP[_i - 255]


def mul(a, b):
    """Multiply in GF(256), through the log tables."""
    return 0 if a == 0 or b == 0 else EXP[LOG[a] + LOG[b]]


def generator(count):
    """Return the Reed-Solomon generator polynomial for count error-correction codewords."""
    poly = [1]
    for i in range(count):
        poly = [high ^ mul(low, EXP[i]) for high, low in zip(poly + [0], [0] + poly)]
    return poly


def ec_codewords(data, count):
    """Return the error-correction codewords of the data codewords."""
    gen = generator(count)
    rem = list(data) + [0] * count
    for i in range(len(data)):
        coef = rem[i]
        if coef:
            for j, g in enumerate(gen):
                rem[i + j] ^= mul(g, coef)
    return rem[len(data) :]


def codewords(payload):
    """Return the smallest version that fits the bytes and all its codewords, padded and corrected."""
    fitting = next((spec for spec in SPEC if len(payload) <= spec[1] - 2), None)
    if fitting is None:
        raise ValueError("texto demasiado largo para un QR versión 5")
    version, total, ec = fitting
    bits = "0100" + f"{len(payload):08b}" + "".join(f"{b:08b}" for b in payload) + "0000"
    data = [int(bits[i : i + 8], 2) for i in range(0, len(bits), 8)]
    data += [PAD[i % 2] for i in range(total - len(data))]
    return version, data + ec_codewords(data, ec)


def skeleton(version):
    """Return the matrix with its fixed patterns drawn (finders, timing, alignment, dark module) and its size."""
    size = version * 4 + 17
    mod: list = [[None] * size for _ in range(size)]
    for r0, c0 in ((0, 0), (0, size - 7), (size - 7, 0)):
        for r in range(-1, 8):  # pragma: no mutate - row 8 holds format and timing cells, written later
            for c in range(-1, 8):  # pragma: no mutate - as above, for column 8
                if 0 <= r0 + r < size and 0 <= c0 + c < size:
                    ring = max(abs(r - FINDER_EDGE), abs(c - FINDER_EDGE))
                    mod[r0 + r][c0 + c] = ring != FINDER_GAP and ring <= FINDER_EDGE
    for i in range(8, size - 8):
        mod[TIMING][i] = mod[i][TIMING] = i % 2 == 0
    if version > 1:
        centre = size - 7
        for r in range(centre - 2, centre + 3):
            for c in range(centre - 2, centre + 3):
                mod[r][c] = max(abs(r - centre), abs(c - centre)) != 1
    mod[size - 8][8] = True
    return mod, size


def format_cells(size):
    """Return the cells of the format bits and of their mirror, in bit order."""
    cells = [(8, i) for i in range(6)] + [(8, 7), (8, 8), (7, 8)]
    cells += [(i, 8) for i in reversed(range(6))]
    mirror = [(size - 1 - i, 8) for i in range(7)]
    mirror += [(8, size - 8 + i) for i in range(8)]  # pragma: no mutate - zip with the 15 bits drops any extra cell
    return cells, mirror


def place(mod, size, stream):
    """Lay the bits in the free cells, two columns at a time in a zigzag, with mask 0."""
    bits = iter(stream)
    col = size - 1
    upward = True
    while col > 0:  # pragma: no mutate - col skips 0: it turns odd past the timing column and ends at -1
        if col == TIMING:
            col -= 1
        rows = reversed(range(size)) if upward else range(size)
        for row in rows:
            for c in (col, col - 1):
                if mod[row][c] is None:
                    bit = next(bits, "0") == "1"  # pragma: no mutate - any default but "1" pads with light bits
                    masked = (row + c) % 2 == 0  # pragma: no mutate - row - c has the parity of row + c
                    mod[row][c] = bit != masked
        upward = not upward
        col -= 2


def matrix(text):
    """Return the QR of a text as rows of dark (True) and light modules."""
    version, words = codewords(text.encode())
    mod, size = skeleton(version)
    cells, mirror = format_cells(size)
    for bit, (row, col) in [*zip(FORMAT, cells), *zip(FORMAT, mirror)]:
        mod[row][col] = bit == "1"
    place(mod, size, "".join(f"{w:08b}" for w in words))
    return [[bool(cell) for cell in row] for row in mod]


def svg(text, scale=4, quiet=4):
    """Return the QR of a text as an SVG image, with its quiet zone."""
    grid = matrix(text)
    size = len(grid) + quiet * 2
    dark = " ".join(
        f"M{(x + quiet) * scale} {(y + quiet) * scale}h{scale}v{scale}h-{scale}z"
        for y, row in enumerate(grid)
        for x, cell in enumerate(row)
        if cell
    )
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size * scale} {size * scale}" '
        f'shape-rendering="crispEdges" role="img" aria-label="Código QR con la dirección del dashboard">'
        f'<rect width="100%" height="100%" fill="#fff"/><path fill="#000" d="{dark}"/></svg>'
    )
