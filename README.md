# Sponsors

The sponsor ad service behind my sites, at https://sponsors.mia.cx. It stores campaigns, serves the ads each site shows
in its sidebars, lists monthly GitHub sponsors for site footers, and hosts the `/admin` dashboard.

## How sites use it

A site's Worker gets a [service binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)
to this Worker and forwards these requests with `?site=<its host>`, so pages only ever talk to their own origin:

| Path | Returns |
| --- | --- |
| `/api/ads?site=` | Approved ads running now, per placement, with rotation timing. Mirrored campaigns are flagged. |
| `/api/ads/:id/image?x=1\|2` | The ad image at 1× or 2×. |
| `/api/availability?site=` | Placements, sizes, caps, prices, and the next free start for each run length. |
| `/api/footer` | Public monthly sponsors, grouped into hero, featured and grid levels. |
| `/api/footer/:login/logo` | A footer sponsor's logo, or their GitHub avatar. |

The site keeps its own rails code, footer grid and `/advertise` page in its own style.
[discord-wrapped](https://github.com/mia-riezebos/discord-wrapped) is the reference integration.

## Placements and prices

Set in `src/worker/config.ts`; the advertise pages read them from `/api/availability`.

| Placement | Size | Cap per site | Per turn | 2 weeks | 4 weeks | Custom amounts |
| --- | --- | --- | --- | --- | --- | --- |
| Tall | 160 × 600 | 6 | 12 s | $8 | $14 | $1 = 2 days |
| Square | 160 × 160 | 8 | 8 s | $4 | $7 | $1 = 4 days |

Custom one-time amounts need at least 7 days. A sponsor who buys the same campaign twice is mirrored: their ad shows on
both sidebars at once and counts twice against the cap. When a placement is full, new campaigns are booked into the next
free window.

Monthly sponsors appear in footers: $100+ a month as hero logos, $10+ as logos, everyone else by name. Private sponsors
and one-time payments never appear. The list refreshes from GitHub Sponsors every hour.

## The dashboard

`/admin` is behind Cloudflare Access, and the Worker also verifies the Access token itself. From it you:

- create a campaign for a sponsor, with the next free start filled in for you;
- upload an image, crop it to the slot's shape and get exact 1× and 2× sizes (Lanczos3 when shrinking, nearest
  neighbour when enlarging, via [ditherette](https://github.com/mia-cx/ditherette)), or write a text ad;
- approve the campaign on the sites the sponsor asked for and reject it on the rest (every campaign starts as a draft
  on every site);
- hide or restyle footer sponsors and upload their logos;
- add a site. Running and upcoming campaigns become drafts on it.

## Development

```sh
pnpm install
pnpm exec wrangler d1 migrations apply DB --local
pnpm dev            # http://localhost:8787/admin works without Access when LOCAL_ADMIN=1 is in .dev.vars
pnpm test
```

## Locking /admin with Cloudflare Access

Run `bash scripts/setup-access.sh`. It asks for a short-lived API token, creates the Access app through the
Cloudflare API, sets the `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` Worker secrets, and checks that `/admin` now redirects
to the Access login. Until then `/admin` answers 403.

By hand, the same steps are:

1. In [Zero Trust](https://one.dash.cloudflare.com/), on the mia.cx account, create a team if you don't have one
   (Free plan). Note the team domain, like `yourteam.cloudflareaccess.com`, under Settings.
2. Access → Applications → Add an application → Self-hosted. Name it "Sponsor ads admin" and add two public
   hostnames: `sponsors.mia.cx` with path `admin`, and `sponsors.mia.cx` with path `api/admin`.
3. Add a policy: action Allow, Include → Emails → your address. Save.
4. Open the app again and copy its Application Audience (AUD) tag.
5. Set the Worker secrets: `pnpm exec wrangler secret put ACCESS_TEAM_DOMAIN` (as `https://yourteam.cloudflareaccess.com`)
   and `pnpm exec wrangler secret put ACCESS_AUD`.
6. Open https://sponsors.mia.cx/admin: Access asks for a one-time code by email, then the dashboard loads.

## Releasing

Pull requests need a changeset (`pnpm changeset`). Merging to `main` opens a version pull request; merging that deploys,
after applying D1 migrations. Run `bash scripts/setup.sh` once to set the CI secrets and the GitHub token that reads your
sponsors, and again when a token expires.
