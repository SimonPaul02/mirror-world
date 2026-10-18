// Small browser-compatible assertions used by the shared input/raster validators.
function assert(condition, message = 'Validation failed') {
  if (!condition) throw new Error(message);
}
assert.equal = (actual, expected, message) => assert(actual === expected,
  message ?? `Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
assert.deepEqual = (actual, expected, message) => assert(JSON.stringify(actual) === JSON.stringify(expected), message);
export default assert;
