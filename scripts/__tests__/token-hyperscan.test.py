"""Compile the SSOT in the native engine too; this is not a GitHub server dry run."""
import json
from pathlib import Path
import unittest
import hyperscan

POLICY = json.loads((Path(__file__).parents[2] / 'security/agentdeck-token-patterns.json').read_text())
TOKEN = ''.join(format(i % 16, 'x') for i in range(32))


class HyperscanPatterns(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.database = hyperscan.Database(mode=hyperscan.HS_MODE_BLOCK)
        cls.database.compile(expressions=[(p['start_delimiter'] + p['pattern'] + p['end_delimiter']).encode() for p in POLICY['patterns']],
                             ids=list(range(len(POLICY['patterns']))))

    def matches(self, text):
        result = set()
        self.database.scan(text.encode(), match_event_handler=lambda pattern, start, end, flags, context: result.add(pattern))
        return result

    def test_native_engine_positive_contexts(self):
        for key in ['pairingToken', 'authToken', 'auth_token', 'pairing_token', 'AGENTDECK_TOKEN']:
            for token in [TOKEN, TOKEN.upper()]:
                with self.subTest(key=key):
                    self.assertEqual(self.matches('"' + key + '": "' + token + '"'), {0})
        self.assertEqual(self.matches('Bearer ' + TOKEN), {1})
        self.assertEqual(self.matches('bEaReR ' + TOKEN), {1})
        self.assertEqual(self.matches('WSS://host/path?token=' + TOKEN), {2})
        self.assertEqual(self.matches('ws://localhost:9120?token=' + TOKEN), {2})
        self.assertEqual(self.matches('wss://host/path?x=1&token=' + TOKEN + '&x=2'), {2})

    def test_native_engine_negative_boundaries_and_noncredentials(self):
        for text in [TOKEN, 'checksum="' + TOKEN + '"', 'authToken="redacted"', 'authToken=randomBytes(16)',
                     'Bearer ' + TOKEN[:31], 'Bearer ' + TOKEN + 'a', 'Bearer ' + TOKEN * 2,
                     'Bearer ' + TOKEN + '_', 'Bearer ' + TOKEN + '-', 'not_authToken="' + TOKEN + '"']:
            with self.subTest(length=len(text)):
                self.assertEqual(self.matches(text), set())


if __name__ == '__main__':
    unittest.main()
