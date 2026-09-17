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


class VersionTest(unittest.TestCase):
    def test_the_payload_length_picks_the_version(self):
        for length, version in ((0, 1), (17, 1), (18, 2), (32, 2), (33, 3), (53, 3), (54, 4), (78, 4), (79, 5), (106, 5)):
            self.assertEqual(qr.codewords(b"x" * length)[0], version, length)
            self.assertEqual(len(qr.matrix("x" * length)), version * 4 + 17, length)

    def test_too_long_is_refused(self):
        with self.assertRaises(ValueError):
            qr.codewords(b"x" * 107)

    def test_codewords_fill_the_whole_block(self):
        for version, total, ec in qr.SPEC:
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

    def test_error_correction_of_a_known_block(self):
        self.assertEqual(qr.ec_codewords([0] * 19, 7), [0] * 7)
        self.assertEqual(len(qr.ec_codewords([1, 2, 3], 10)), 10)


class SvgTest(unittest.TestCase):
    def test_scales_the_grid_with_a_quiet_zone(self):
        out = qr.svg("hola", scale=2, quiet=3)
        size = (21 + 6) * 2
        self.assertIn(f'viewBox="0 0 {size} {size}"', out)
        self.assertIn("<path", out)
        self.assertTrue(out.startswith("<svg") and out.endswith("</svg>"))

    def test_paints_one_square_per_dark_module(self):
        grid = qr.matrix("hola")
        self.assertEqual(qr.svg("hola").count("z"), sum(cell for row in grid for cell in row))


if __name__ == "__main__":
    unittest.main()
