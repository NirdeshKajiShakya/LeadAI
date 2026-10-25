import assert from 'node:assert/strict';
import { aiStoryPoints, estimateStoryPoints, isValidStoryPoints } from './storyPoints.js';

assert.equal(isValidStoryPoints(0), true);
assert.equal(isValidStoryPoints(8), true);
assert.equal(isValidStoryPoints(4), true);
assert.equal(isValidStoryPoints(2.5), false);
assert.equal(isValidStoryPoints('3'), false);
assert.equal(isValidStoryPoints(101), false);

assert.equal(aiStoryPoints(5, { title: 'Simple documentation' }), 5);
assert.equal(aiStoryPoints(4, { title: 'Simple documentation' }), 1);
assert.equal(aiStoryPoints(undefined, { title: 'Database migration pipeline' }), 13);
assert.equal(estimateStoryPoints({ title: 'Add login API integration' }), 5);
assert.equal(estimateStoryPoints({ title: 'Unclassified task' }), 2);

console.log('story-point validation and AI estimation checks passed.');
