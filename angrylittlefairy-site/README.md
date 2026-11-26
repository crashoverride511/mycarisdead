# angrylittlefairy.com

Single static page, no build step. Everything lives in `index.html`.

## Swap in photos
Drop JPGs into `images/` with these names and they show up automatically:
- `hero.jpg` (portrait, 4:5, also used as the link preview image when the URL is shared)
- `01.jpg` (tall) `02.jpg` `03.jpg` `04.jpg` (wide) `05.jpg` `06.jpg` (wide)

Keep each under ~500 KB (export at ~2000px on the long side, quality 75-80).

## Edit text and links
Search `index.html` for `EDIT:` to find the tagline, social URLs/handles, bio, stats and email.

## Deploy (Cloudflare Pages)
Workers & Pages > Create > Pages > Upload assets, drag in this folder, then
Custom domains > add `angrylittlefairy.com`.

## Email
Email Routing on the domain: create `bookings@angrylittlefairy.com` and forward it to her inbox.
