const { test } = require('node:test');
const assert = require('node:assert');

test('smoke: node native test runner works', () => {
    assert.strictEqual(1 + 1, 2);
});
