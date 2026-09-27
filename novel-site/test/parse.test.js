const test = require('node:test');
const assert = require('node:assert');
const p = require('../src/parse');

const file = (name, text) => ({ originalname: name, buffer: Buffer.from(text) });

test('parseHeading understands common chapter headings', () => {
  assert.deepStrictEqual(p.parseHeading('Chapter 12: The Gate'), { number: 12, title: 'The Gate' });
  assert.deepStrictEqual(p.parseHeading('Ch. 3 - Hello'), { number: 3, title: 'Hello' });
  assert.deepStrictEqual(p.parseHeading('## Chapter 7.5'), { number: 7.5, title: '' });
  assert.deepStrictEqual(p.parseHeading('第12章 标题'), { number: 12, title: '标题' });
  assert.strictEqual(p.parseHeading('Prologue').title, 'Prologue');
  assert.strictEqual(p.parseHeading('Just a normal sentence.'), null);
});

test('one file per chapter: number from heading, then filename', async () => {
  const { chapters } = await p.parseFilesAsChapters([
    file('a.txt', 'Chapter 4: Four\n\nBody text.'),
    file('ch010.txt', 'No heading here. It is a sentence.\n\nMore.'),
  ]);
  assert.strictEqual(chapters[0].number, 4);
  assert.strictEqual(chapters[0].title, 'Four');
  assert.ok(!chapters[0].content.includes('Chapter 4'));
  assert.strictEqual(chapters[1].number, 10);
  assert.strictEqual(chapters[1].title, '');
  assert.ok(chapters[1].content.includes('No heading here'));
});

test('split one document into many chapters', () => {
  const chs = p.splitTextIntoChapters('Chapter 1: A\n\none\n\nChapter 2: B\n\ntwo\n\n***\n\nthree');
  assert.strictEqual(chs.length, 2);
  assert.strictEqual(chs[1].title, 'B');
  assert.ok(/<hr/.test(chs[1].content));
});

test('custom split pattern and missing numbers', () => {
  const chs = p.splitTextIntoChapters('== Start ==\nx\n== Middle ==\ny', { pattern: '^==' });
  p.assignMissingNumbers(chs, 10);
  assert.deepStrictEqual(chs.map((c) => c.number), [11, 12]);
});

test('sanitizes dangerous HTML', async () => {
  const { chapters } = await p.parseFilesAsChapters([file('1.html', '<h1>Chapter 1</h1><p onclick="x()">hi<script>alert(1)</script></p><a href="javascript:alert(1)">l</a>')]);
  const html = chapters[0].content;
  assert.ok(!/script|onclick|javascript:/i.test(html), html);
});

test('word count handles CJK', () => {
  assert.strictEqual(p.wordCount('<p>hello world</p>'), 2);
  assert.strictEqual(p.wordCount('<p>你好世界</p>'), 4);
});
