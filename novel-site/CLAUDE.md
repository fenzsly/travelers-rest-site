# Notes for working on this site

## Every update needs a changelog entry
The owner installs updates from Admin → Update & backup, which shows `CHANGELOG.json` as the update history
(and the not-yet-installed entries as "what's new" before installing). For every change you push, add a new
entry at the **top** of `CHANGELOG.json`:

```json
{ "id": "YYYY-MM-DD-short-name", "date": "YYYY-MM-DD", "title": "Short title", "changes": ["Plain-language change", "…"] }
```

- `id` must be unique and never change (install times are tracked by it).
- `date` is the release date (the day it's pushed).
- Write `changes` for the site owner, not developers: what they or readers will notice. 2–5 bullets.
- If several commits make up one update, add to that entry instead of creating another one.
