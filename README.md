# Clearance Delivery Trainer

Live site: https://clearance-delivery.netlify.app/ (GeezerGeek Pilot Apps)

Practice copying and reading back IFR clearances (CRAFT): pick a departure, call Clearance
Delivery or Ground, copy the clearance, read it back by voice and get graded.

## Layout
- `site/` — what Netlify publishes (see `netlify.toml`): `index.html`, `claude.md`, `data/`
  (`airports.js`, `prefroutes.js`, `navaids.js`).
- `netlify/functions/nasr-freq.js` — server function that keeps the current 28-day FAA NASR
  frequency table (FRQ CSV) in the Netlify Blobs store `clearance-delivery-nasr`.
  `?action=update` refreshes it, `?action=get` returns it, `?action=inspect&id=XXX` shows one airport's raw rows.

## Deploys
Netlify deploys from `main` with no build step. Push a commit and the site updates.
