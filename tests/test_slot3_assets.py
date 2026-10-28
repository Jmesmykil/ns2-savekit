#!/usr/bin/env python3
import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('slot3_assets', ROOT / 'tools/build-slot3-assets.py')
assets = importlib.util.module_from_spec(spec)
spec.loader.exec_module(assets)


class RepairScopeTests(unittest.TestCase):
    def test_changes_only_repair_loop(self):
        source = b'for i=1,3 do elsewhere end\nlocal function repair()\n    local repaired=0\n    for i=1,3 do body end'
        result = assets.restrict_repair(source)
        self.assertTrue(result.startswith(b'for i=1,3 do elsewhere end'))
        self.assertEqual(result.count(b'for i=3,3 do'), 1)
        self.assertEqual(result.replace(b'for i=3,3 do', b'for i=1,3 do'), source)

    def test_missing_or_duplicate_repair_context_refused(self):
        context = b'local function repair()\n    local repaired=0\n    for i=1,3 do'
        for data in (b'no repair function', context + b'\n' + context):
            with self.assertRaisesRegex(ValueError, 'exactly one'):
                assets.restrict_repair(data)


if __name__ == '__main__':
    unittest.main()
