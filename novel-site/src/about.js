// The About page: its text is editable in Admin → Site settings (Markdown, with {placeholders}).
const { marked } = require('marked');
const { getSettings } = require('./settings');
const { sanitize } = require('./parse');

const DEFAULT_ABOUT = `**{site_name}** is a free website for reading English translations of web novels and light novels online. {site_description}

We currently host **{novels} novels** and **{chapters} chapters**{genres_sentence}.

## Reading on {site_name}

- A comfortable reader with dark, sepia and light themes, adjustable fonts and arrow-key navigation.
- Free accounts to keep a library, track your progress and get notified about new chapters.
- Ratings, reviews, comments and reactions on every novel and chapter.
- RSS feeds for the whole site and for each novel.

## Follow new chapters

Bookmark [{domain}](/), add novels to your library, or subscribe to the [RSS feed](/rss.xml).{social_sentence}

## Translations

{footer_text} If you are an author or rights holder and would like a work removed, please [contact us](/contact?topic=copyright) and we will respond promptly.

## Contact

Questions, feedback, problems with the site or business enquiries: use the [contact page](/contact){email_sentence}.
`;

/** Placeholders that can be used in the About text, with what they show. */
const PLACEHOLDERS = {
  '{site_name}': 'site name',
  '{site_description}': 'site description (SEO page)',
  '{novels}': 'number of novels',
  '{chapters}': 'number of chapters',
  '{genres_sentence}': '“, across genres like …”',
  '{domain}': 'your web address',
  '{social_sentence}': 'your social links (SEO page)',
  '{footer_text}': 'footer text',
  '{email_sentence}': '“or email …” (if a contact email is set)',
};

/** The About page as safe HTML, with placeholders filled in. */
function aboutHtml({ totals, genres, baseUrl }) {
  const s = getSettings();
  const links = (s.social_links || '').split(/\s+/).filter((l) => /^https?:\/\//.test(l));
  const values = {
    '{site_name}': s.site_name,
    '{site_description}': s.site_description,
    '{novels}': totals.novels.toLocaleString('en-US'),
    '{chapters}': totals.chapters.toLocaleString('en-US'),
    '{genres_sentence}': genres.length ? `, across genres like ${genres.slice(0, 6).map((g) => g.name).join(', ')}` : '',
    '{domain}': baseUrl.replace(/^https?:\/\//, ''),
    '{social_sentence}': links.length ? ` You can also find us here: ${links.map((l) => `[${l.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')}](${l})`).join(', ')}.` : '',
    '{footer_text}': s.footer_text,
    '{email_sentence}': s.contact_email ? ` or email [${s.contact_email}](mailto:${s.contact_email})` : '',
  };
  const text = (s.about_body || DEFAULT_ABOUT).replace(/\{[a-z_]+\}/g, (k) => (k in values ? values[k] : k));
  // Links to this site's own pages (and email links) open normally; only outside links open in a new tab.
  return sanitize(marked.parse(text)).replace(/<a href="(\/[^/"][^"]*|\/|mailto:[^"]*)"[^>]*>/g, (m) => m.replace(/ target="_blank"| rel="[^"]*"/g, ''));
}

module.exports = { DEFAULT_ABOUT, PLACEHOLDERS, aboutHtml };
