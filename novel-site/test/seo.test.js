const test = require('node:test');
const assert = require('node:assert');
const seo = require('../src/seo');

test('excerpt trims at a word boundary and strips HTML', () => {
  assert.strictEqual(seo.excerpt('<p>Short &amp; sweet.</p>'), 'Short & sweet.');
  const long = seo.excerpt(`<p>${'word '.repeat(80)}</p>`, 155);
  assert.ok(long.length <= 155 && long.endsWith('…') && !long.includes('wor…'), long);
});

test('jsonLd cannot break out of its <script> tag', () => {
  const out = seo.jsonLd({ name: '</script><script>alert(1)</script>' });
  assert.ok(!out.includes('</script>') && !out.includes('<'));
  assert.strictEqual(JSON.parse(out).name, '</script><script>alert(1)</script>');
});

test('book schema includes rating only when there are votes', () => {
  const novel = { slug: 'x', title: 'X', description: 'A story.', cover: 'c.png', author: 'A', alt_titles: 'Y\nZ', status: 'ongoing', rating: 4.5, rating_count: 0, last_release: 1700000000 };
  let data = seo.bookSchema('https://site.test', novel, [{ name: 'Fantasy' }]);
  const book = data['@graph'][0];
  assert.strictEqual(book['@type'], 'Book');
  assert.deepStrictEqual(book.alternateName, ['Y', 'Z']);
  assert.strictEqual(book.aggregateRating, undefined);
  data = seo.bookSchema('https://site.test', { ...novel, rating_count: 3 }, []);
  assert.strictEqual(data['@graph'][0].aggregateRating.ratingCount, 3);
});

test('novel checklist flags missing basics', () => {
  assert.deepStrictEqual(seo.novelIssues({ description: 'short', chapter_count: 0 }),
    ['No cover image', 'Synopsis is short (5 characters, aim for 120+)', 'No genres', 'No published chapters']);
  assert.deepStrictEqual(seo.novelIssues({ cover: 'c', description: 'x'.repeat(130), genre_names: 'Fantasy', chapter_count: 3 }), []);
});
