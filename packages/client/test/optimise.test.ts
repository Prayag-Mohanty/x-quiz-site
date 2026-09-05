/**
 * Deciding whether to shrink an image, and to what.
 *
 * The redraw itself needs a canvas and cannot run here, so what is tested is
 * the decision — which is where the damage would be. Shrinking the wrong thing
 * destroys a question: an animated GIF flattened to its first frame, or a
 * carefully sized diagram upscaled into mush.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { LEAVE_ALONE_BYTES, targetSize, worthOptimising } from '../src/optimiseImage.js';

const KB = 1024;

describe('worthOptimising', () => {
  test('a big photograph, yes', () => {
    assert.equal(worthOptimising({ type: 'image/png', size: 4200 * KB }), true);
    assert.equal(worthOptimising({ type: 'image/jpeg', size: 900 * KB }), true);
  });

  test('a small image, no — the round trip already dominates', () => {
    assert.equal(worthOptimising({ type: 'image/png', size: 120 * KB }), false);
    assert.equal(worthOptimising({ type: 'image/jpeg', size: LEAVE_ALONE_BYTES }), false);
  });

  test('never audio or video', () => {
    assert.equal(worthOptimising({ type: 'audio/mpeg', size: 8000 * KB }), false);
    assert.equal(worthOptimising({ type: 'video/mp4', size: 90_000 * KB }), false);
  });

  test('never a GIF — a canvas would flatten the animation to one frame', () => {
    assert.equal(worthOptimising({ type: 'image/gif', size: 3000 * KB }), false);
  });

  test('never an SVG — it is already resolution-independent', () => {
    assert.equal(worthOptimising({ type: 'image/svg+xml', size: 900 * KB }), false);
  });
});

describe('targetSize', () => {
  test('shrinks the long edge and keeps the shape', () => {
    assert.deepEqual(targetSize(4000, 3000), { width: 1600, height: 1200 });
    assert.deepEqual(targetSize(3000, 4000), { width: 1200, height: 1600 });
  });

  test('leaves an image that already fits exactly alone', () => {
    assert.deepEqual(targetSize(1600, 900), { width: 1600, height: 900 });
    assert.deepEqual(targetSize(800, 600), { width: 800, height: 600 });
  });

  test('never upscales', () => {
    const { width, height } = targetSize(320, 200);
    assert.equal(width, 320);
    assert.equal(height, 200);
  });

  test('a panorama is bounded by its long edge, not its area', () => {
    assert.deepEqual(targetSize(6000, 500), { width: 1600, height: 133 });
  });
});
