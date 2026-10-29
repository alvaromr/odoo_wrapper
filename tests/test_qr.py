"""Unit tests for the hand-written QR encoder: structure, versions and limits."""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src"))

from odoo_wrapper import qr

FINDER = [
    [1, 1, 1, 1, 1, 1, 1],
    [1, 0, 0, 0, 0, 0, 1],
    [1, 0, 1, 1, 1, 0, 1],
    [1, 0, 1, 1, 1, 0, 1],
    [1, 0, 1, 1, 1, 0, 1],
    [1, 0, 0, 0, 0, 0, 1],
    [1, 1, 1, 1, 1, 1, 1],
]
DECODED_BY_VISION = {
    "hola": [
        "#######...#.#.#######",
        "#.....#.....#.#.....#",
        "#.###.#.#.#...#.###.#",
        "#.###.#.....#.#.###.#",
        "#.###.#..#.##.#.###.#",
        "#.....#..###..#.....#",
        "#######.#.#.#.#######",
        "........#.#..........",
        "###.#####.#.###...#..",
        "##.#...#...#.#.#..###",
        "###..##....#.###.#.##",
        "###.....##.###.##..#.",
        "##..#.###..#.###.....",
        "........#.....#...###",
        "#######.#.#.#...#.###",
        "#.....#.#.#...#....#.",
        "#.###.#.#.#.#.#.#..##",
        "#.###.#..###.#.#.#.#.",
        "#.###.#.##.#.###.##.#",
        "#.....#.#..###.###.#.",
        "#######.#.##.###..###",
    ],
    "https://192.168.1.20:8443/": [
        "#######...#..####.#######",
        "#.....#..#....###.#.....#",
        "#.###.#.#..#..#.#.#.###.#",
        "#.###.#..#..#..##.#.###.#",
        "#.###.#..#..#..##.#.###.#",
        "#.....#...###..#..#.....#",
        "#######.#.#.#.#.#.#######",
        "........#..#.#..#........",
        "###.#####...#######...#..",
        ".#.......#.####...##....#",
        "#..#####..###.#.#..##.###",
        "###.##...##.##.#...#...#.",
        "#....###..######..##.#.##",
        ".####..#####..#...##.#..#",
        "#.#...##.#...##.#.##..###",
        ".##..#...#..##..###.#..#.",
        "#....#####.####.######...",
        "........#.#...#.#...##.##",
        "#######.#.....###.#.##.##",
        "#.....#.###..#.##...##.##",
        "#.###.#.###..##.######...",
        "#.###.#..##..##..#.####..",
        "#.###.#.###.#...#...#...#",
        "#.....#.##.###..#.#.##.#.",
        "#######.#....##.#..#...##",
    ],
}


class VersionTest(unittest.TestCase):
    def test_the_payload_length_picks_the_version(self):
        for length, version in ((0, 1), (17, 1), (18, 2), (32, 2), (33, 3), (53, 3), (54, 4), (78, 4), (79, 5), (106, 5)):
            self.assertEqual(qr.codewords(b"x" * length)[0], version, length)
            self.assertEqual(len(qr.matrix("x" * length)), version * 4 + 17, length)

    def test_too_long_is_refused(self):
        with self.assertRaises(ValueError) as caught:
            qr.codewords(b"x" * 107)
        self.assertEqual(str(caught.exception), "texto demasiado largo para un QR versión 5")

    def test_a_short_text_is_mode_length_bytes_terminator_and_padding(self):
        data = [0x40, 0x46, 0x86, 0xF6, 0xC6, 0x10] + [0xEC, 0x11] * 6 + [0xEC]
        self.assertEqual(qr.codewords(b"hola"), (1, data + qr.ec_codewords(data, 7)))

    def test_codewords_fill_the_whole_block(self):
        for _, total, ec in qr.SPEC:
            self.assertEqual(len(qr.codewords(b"a" * (total - 2))[1]), total + ec)


class MatrixTest(unittest.TestCase):
    def corner(self, grid, r0, c0):
        return [[int(grid[r0 + r][c0 + c]) for c in range(7)] for r in range(7)]

    def test_finder_patterns_sit_in_three_corners(self):
        for text in ("a", "https://192.168.40.190:8443/", "x" * 100):
            grid = qr.matrix(text)
            size = len(grid)
            for r0, c0 in ((0, 0), (0, size - 7), (size - 7, 0)):
                self.assertEqual(self.corner(grid, r0, c0), FINDER, (text, r0, c0))

    def test_finders_are_surrounded_by_light_separators(self):
        grid = qr.matrix("hola")
        self.assertFalse(any(grid[7][:8]))
        self.assertFalse(any(row[7] for row in grid[:8]))

    def test_timing_patterns_alternate(self):
        grid = qr.matrix("hola")
        size = len(grid)
        self.assertEqual([grid[6][i] for i in range(8, size - 8)], [i % 2 == 0 for i in range(8, size - 8)])
        self.assertEqual([grid[i][6] for i in range(8, size - 8)], [i % 2 == 0 for i in range(8, size - 8)])

    def test_the_dark_module_is_always_dark(self):
        for text in ("a", "x" * 60):
            grid = qr.matrix(text)
            self.assertTrue(grid[len(grid) - 8][8])

    def test_alignment_pattern_from_version_two(self):
        grid = qr.matrix("x" * 30)
        centre = len(grid) - 7
        self.assertTrue(grid[centre][centre])
        self.assertFalse(grid[centre - 1][centre])
        self.assertTrue(grid[centre - 2][centre - 2])

    def test_format_bits_are_written_twice(self):
        grid = qr.matrix("hola")
        cells, mirror = qr.format_cells(len(grid))
        for bit, (row, col) in list(zip(qr.FORMAT, cells)) + list(zip(qr.FORMAT, mirror)):
            self.assertEqual(grid[row][col], bit == "1", (row, col))

    def test_every_module_is_decided(self):
        grid = qr.matrix("x" * 70)
        self.assertTrue(all(isinstance(cell, bool) for row in grid for cell in row))

    def test_texts_a_decoder_read_back_keep_their_exact_modules(self):
        for text, rows in DECODED_BY_VISION.items():
            self.assertEqual(qr.matrix(text), [[cell == "#" for cell in row] for row in rows], text)

    def test_different_texts_differ_and_the_same_text_repeats(self):
        self.assertEqual(qr.matrix("uno"), qr.matrix("uno"))
        self.assertNotEqual(qr.matrix("uno"), qr.matrix("dos"))


class FieldTest(unittest.TestCase):
    def test_multiplication_by_zero(self):
        self.assertEqual(qr.mul(0, 5), 0)
        self.assertEqual(qr.mul(5, 0), 0)
        self.assertEqual(qr.mul(1, 5), 5)

    def test_generator_polynomial_degree(self):
        self.assertEqual(len(qr.generator(7)), 8)
        self.assertEqual(qr.generator(0), [1])

    def test_generator_polynomials_match_the_standard(self):
        self.assertEqual([qr.LOG[c] for c in qr.generator(7)], [0, 87, 229, 146, 149, 238, 102, 21])
        self.assertEqual([qr.LOG[c] for c in qr.generator(10)], [0, 251, 67, 46, 61, 118, 70, 64, 94, 32, 45])

    def test_error_correction_of_a_known_block(self):
        self.assertEqual(qr.ec_codewords([0] * 19, 7), [0] * 7)
        self.assertEqual(len(qr.ec_codewords([1, 2, 3], 10)), 10)
        standard_example = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17]
        self.assertEqual(qr.ec_codewords(standard_example, 10), [196, 35, 39, 119, 235, 215, 231, 226, 93, 23])


class SvgTest(unittest.TestCase):
    def test_scales_the_grid_with_a_quiet_zone(self):
        out = qr.svg("hola", scale=2, quiet=3)
        size = (21 + 6) * 2
        self.assertIn(f'viewBox="0 0 {size} {size}"', out)
        self.assertIn('d="M6 6h2v2h-2z M8 6h2v2h-2z ', out)
        self.assertTrue(out.startswith("<svg") and out.endswith("</svg>"))

    def test_paints_one_square_per_dark_module(self):
        grid = qr.matrix("hola")
        self.assertEqual(qr.svg("hola").count("z"), sum(cell for row in grid for cell in row))


if __name__ == "__main__":
    unittest.main()
