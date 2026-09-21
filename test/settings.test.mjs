import test from 'node:test';
import assert from 'node:assert/strict';
import { splitPath } from '../src/folder-handle.js';
import { sanitizeFolder, resolveFolder, DEFAULTS } from '../src/settings.js';

test('sanitizeFolder keeps an ordinary relative path', () => {
  assert.equal(sanitizeFolder('School/PSYCH 1X03'), 'School/PSYCH 1X03');
});

test('sanitizeFolder strips leading and trailing slashes', () => {
  assert.equal(sanitizeFolder('/Lectures/'), 'Lectures');
});

test('sanitizeFolder refuses parent traversal', () => {
  assert.equal(sanitizeFolder('../../etc'), 'etc');
  assert.equal(sanitizeFolder('a/../../b'), 'a/b');
  assert.equal(sanitizeFolder('..'), '');
});

test('sanitizeFolder drops a drive letter and collapses repeated slashes', () => {
  assert.equal(sanitizeFolder('C:\\Users\\mc\\\\Lectures'), 'Users/mc/Lectures');
});

test('sanitizeFolder removes characters illegal in filenames', () => {
  assert.equal(sanitizeFolder('Bio<>:"|?*101'), 'Bio101');
});

test('sanitizeFolder returns empty for nothing usable', () => {
  assert.equal(sanitizeFolder(''), '');
  assert.equal(sanitizeFolder('   '), '');
  assert.equal(sanitizeFolder(undefined), '');
});

const settings = {
  ...DEFAULTS,
  downloadFolder: 'Lectures',
  folderRules: [
    { match: 'psych', matchKind: 'title', folder: 'School/Psych' },
    { match: 'section/abc123', matchKind: 'url', folder: 'School/Stats' },
    { match: 'psych', matchKind: 'title', folder: 'Never reached' }
  ]
};

test('resolveFolder matches a title rule case-insensitively', () => {
  assert.equal(resolveFolder('PSYCH 1X03 Lecture 4', 'https://echo360.ca/x', settings), 'School/Psych');
});

test('resolveFolder matches a url rule', () => {
  assert.equal(
    resolveFolder('Week 2', 'https://echo360.ca/section/abc123/home', settings),
    'School/Stats'
  );
});

test('resolveFolder takes the first matching rule', () => {
  const both = {
    ...settings,
    folderRules: [
      { match: 'week', matchKind: 'title', folder: 'First' },
      { match: 'week', matchKind: 'title', folder: 'Second' }
    ]
  };
  assert.equal(resolveFolder('Week 2', '', both), 'First');
});

test('resolveFolder falls back to the default folder when no rule matches', () => {
  assert.equal(resolveFolder('Chemistry 101', 'https://echo360.ca/x', settings), 'Lectures');
});

test('resolveFolder returns empty when nothing is configured', () => {
  assert.equal(resolveFolder('Anything', '', DEFAULTS), '');
});

test('resolveFolder sanitizes a rule folder that was stored unsafely', () => {
  const nasty = { ...DEFAULTS, folderRules: [{ match: 'x', matchKind: 'title', folder: '../../tmp' }] };
  assert.equal(resolveFolder('x', '', nasty), 'tmp');
});

test('splitPath separates the folders from the file name', () => {
  assert.deepEqual(splitPath('School/Psych/lecture.mp4'), {
    folders: ['School', 'Psych'],
    name: 'lecture.mp4'
  });
});

test('splitPath handles a bare file name', () => {
  assert.deepEqual(splitPath('lecture.mp4'), { folders: [], name: 'lecture.mp4' });
});

test('splitPath drops empty segments rather than creating unnamed folders', () => {
  assert.deepEqual(splitPath('/School//lecture.mp4'), {
    folders: ['School'],
    name: 'lecture.mp4'
  });
});

test('splitPath reports no name when there is nothing to write', () => {
  assert.equal(splitPath('').name, '');
});
