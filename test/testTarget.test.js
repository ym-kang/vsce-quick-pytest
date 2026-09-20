const assert = require('node:assert/strict');
const test = require('node:test');
const { findTestTargets } = require('../out/testTarget');

test('finds module-level pytest functions', () => {
  const targets = findTestTargets('def test_add():\n    assert 1 + 1 == 2\n', '/repo/tests/test_math.py');
  assert.deepEqual(targets.map((target) => target.nodeId), [
    '/repo/tests/test_math.py::test_add'
  ]);
});

test('finds methods inside Test classes, including classes without parentheses', () => {
  const source = [
    'class TestMath:',
    '    def test_add(self):',
    '        pass',
    '',
    '    def helper(self):',
    '        pass'
  ].join('\n');
  const targets = findTestTargets(source, '/repo/tests/test_math.py');
  assert.deepEqual(targets.map((target) => target.nodeId), [
    '/repo/tests/test_math.py::TestMath::test_add'
  ]);
});

test('finds tests in any Python file path', () => {
  const targets = findTestTargets('def test_add():\n    pass\n', '/repo/src/math.py');
  assert.deepEqual(targets.map((target) => target.nodeId), [
    '/repo/src/math.py::test_add'
  ]);
});

test('does not treat helper classes as pytest test classes', () => {
  const source = 'class Helpers:\n    def test_fixture_like_name(self):\n        pass\n';
  assert.deepEqual(findTestTargets(source, '/repo/tests/test_math.py'), []);
});
