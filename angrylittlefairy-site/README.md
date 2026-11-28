# angrylittlefairy.com

Single static page, no build step. Everything lives in `index.html`.

## Swap in photos
Two sides, two photo sets. Drop JPGs into `images/`:
- Sweet side: `light-hero.jpg` (portrait 4:5, also the link preview image), `light-01.jpg` ... `light-06.jpg`
- Wicked side (18+, only loads after the age gate): `dark-hero.jpg`, `dark-01.jpg` ... `dark-06.jpg`
- In each gallery 01 is tall, 04 and 06 are wide.

Keep each under ~500 KB (export at ~2000px on the long side, quality 75-80).

## How the flip works
The page opens on the sweet side. Any "other side" button shows the 18+ gate once per browser,
then the whole page flips to the wicked side. `angrylittlefairy.com/#wicked` links straight there (gate still applies).

## Wicked side extras
- Look: black latex and satin, hard pink, purple and chrome. Red only shows up as blood: the drips off "pay." and a faint glow.
- Her photo wears a chrome heart collar tag that says "Property of Alyssa". Chain-and-heart-padlock dividers sit between sections.
- "Settle your tab" shows a black card owned by her (number ends in MINE, valid thru forever) that tilts toward the cursor.
- Hidden words ("mine", "obey", "you're mine", "good little wallet") sit behind the hero and only show under the cursor. On phones the light drifts on its own.
- An "incoming call from Owner" pops up once per visit, 9 seconds after crossing over. Answer scrolls to tribute; decline says "Declining costs extra."
- The minimum tribute (`$TBD`) appears twice: in step 01 and under the card.
- Everything animated respects the phone's reduce-motion setting.

## Edit text and links
Search `index.html` for `EDIT:` to find the tagline, social URLs/handles, bio, stats and email.

## Deploy
Live at https://angrylittlefairy.com as the Cloudflare Worker `angrylittlefairy`
(www redirects to the bare domain). After editing `index.html`, run `python3 deploy.py`.

Photos: the Worker only serves the page right now, so images in `images/` won't show
until they're hosted (next step: an R2 bucket, or move to Pages with Git).

## Email
Email Routing on the domain: create `bookings@angrylittlefairy.com` and forward it to her inbox.
