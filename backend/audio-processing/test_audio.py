import unittest

import numpy as np

from audio import normalize_audio


class NormalizeAudioTest(unittest.TestCase):
    def test_peak_bounds_preserve_silence_and_waveform(self):
        for peak, expected in [(0, 0), (0.1, 0.7), (0.7, 0.7), (0.8, 0.8), (0.9, 0.9), (1.2, 0.9)]:
            with self.subTest(peak=peak):
                audio = np.array([[peak, -peak / 2], [-peak, peak / 4]])
                result = normalize_audio(audio)
                np.testing.assert_allclose(result, [[expected, -expected / 2], [-expected, expected / 4]])


if __name__ == "__main__":
    unittest.main()
