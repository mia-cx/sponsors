/* Sponsor ads service: public ad, availability and footer APIs for every site, plus the /admin dashboard. */
import {accessUser, type AccessEnv} from './access.ts';
import {FOOTER_LEVELS, MIN_CUSTOM_DAYS, PLACEMENTS, SPONSOR_EMAIL, SPONSORS_URL, footerLevel, type Placement} from './config.ts';
import {syncSponsors} from './github.ts';
import {checkImage, isAnimated} from './images.ts';
import {collapseMirrored, fromDb, nextFreeStart, toDb, type Window} from './schedule.ts';

interface Env extends AccessEnv {
  DB: D1Database;
  BUCKET: R2Bucket;
  ASSETS: Fetcher;
  GITHUB_TOKEN?: string;
  /** Set only in .dev.vars: lets `wrangler dev` on localhost open /admin without Access. */
  LOCAL_ADMIN?: string;
}

interface CampaignRow {
  id: number; sponsor: string; placement: Placement; kind: 'image' | 'text'; creative_hash: string;
  alt: string; name: string; headline: string; body: string; link_url: string;
  starts_at: string; ends_at: string; source: string; note: string; created_at: string;
}

const DAY = 86_400_000;
const json = (body: unknown, init: ResponseInit & {maxAge?: number} = {}) => new Response(JSON.stringify(body), {
  status: init.status ?? 200,
  headers: {'content-type': 'application/json', 'cache-control': init.maxAge ? `public, max-age=${init.maxAge}` : 'no-store'},
});
const fail = (status: number, error: string) => json({error}, {status});
const isPlacement = (p: unknown): p is Placement => p === 'tall' || p === 'square';
const sha256 = async (data: BufferSource | string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? new TextEncoder().encode(data) : data))].map(b => b.toString(16).padStart(2, '0')).join('');
const imageKey = (id: number, scale: 1 | 2) => `ads/${id}/${scale}x`;

/* ---------- public ---------- */
async function siteParam(env: Env, url: URL): Promise<string | null> {
  const site = url.searchParams.get('site');
  if (!site) return null;
  return (await env.DB.prepare('SELECT host FROM sites WHERE host = ?1').bind(site).first<string>('host')) ?? null;
}

async function activeAds(env: Env, site: string) {
  const now = toDb(Date.now());
  const {results} = await env.DB.prepare(`SELECT c.* FROM campaigns c JOIN campaign_sites s ON s.campaign_id = c.id
    WHERE s.site = ?1 AND s.status = 'approved' AND c.starts_at <= ?2 AND c.ends_at > ?2 ORDER BY c.id`).bind(site, now).all<CampaignRow>();
  return collapseMirrored(results);
}

async function publicAds(env: Env, site: string) {
  const ads = (await activeAds(env, site)).map(c => ({
    id: c.id, placement: c.placement, kind: c.kind, mirrored: c.mirrored, sponsor: c.sponsor, href: c.link_url,
    ...(c.kind === 'image'
      ? {alt: c.alt, image: {src: `/api/ads/${c.id}/image?x=1&v=${c.creative_hash.slice(0, 12)}`, src2x: `/api/ads/${c.id}/image?x=2&v=${c.creative_hash.slice(0, 12)}`}}
      : {name: c.name, headline: c.headline, body: c.body}),
  }));
  const placements = Object.fromEntries(Object.entries(PLACEMENTS).map(([k, p]) => [k, {width: p.width, height: p.height, seconds: p.seconds}]));
  return {placements, ads, sponsorsUrl: SPONSORS_URL};
}

/** Windows that count against a placement's cap on one site: approved or still pending, not yet over. */
async function bookedWindows(env: Env, site: string, placement: Placement, excludeId = 0): Promise<Window[]> {
  const {results} = await env.DB.prepare(`SELECT c.starts_at, c.ends_at FROM campaigns c JOIN campaign_sites s ON s.campaign_id = c.id
    WHERE s.site = ?1 AND s.status != 'rejected' AND c.placement = ?2 AND c.ends_at > ?3 AND c.id != ?4`)
    .bind(site, placement, toDb(Date.now()), excludeId).all<{starts_at: string; ends_at: string}>();
  return results.map(r => ({starts: fromDb(r.starts_at), ends: fromDb(r.ends_at)}));
}

async function availability(env: Env, site: string) {
  const now = Date.now();
  const placements = await Promise.all(Object.entries(PLACEMENTS).map(async ([key, p]) => {
    const windows = await bookedWindows(env, site, key as Placement);
    const active = windows.filter(w => w.starts <= now && w.ends > now).length;
    return [key, {
      ...p, active, free: Math.max(0, p.cap - active),
      nextOpening: Object.fromEntries(p.prices.map(price => [price.days, new Date(nextFreeStart(windows, p.cap, now, price.days)).toISOString()])),
    }];
  }));
  return {site, placements: Object.fromEntries(placements), minCustomDays: MIN_CUSTOM_DAYS, sponsorsUrl: SPONSORS_URL, email: SPONSOR_EMAIL};
}

async function footer(env: Env) {
  const {results} = await env.DB.prepare(`SELECT f.login, coalesce(o.display_name, f.name) AS name, coalesce(o.url, f.url) AS url, f.monthly_cents,
    coalesce(o.has_logo, 0) AS has_logo, f.synced_at FROM footer_sponsors f LEFT JOIN footer_overrides o ON o.login = f.login
    WHERE coalesce(o.hidden, 0) = 0 ORDER BY f.monthly_cents DESC, lower(f.name)`)
    .all<{login: string; name: string; url: string; monthly_cents: number; has_logo: number; synced_at: string}>();
  return {
    sponsorsUrl: SPONSORS_URL,
    levels: FOOTER_LEVELS.map(l => ({
      level: l.level, columns: l.columns, logo: l.logo,
      sponsors: results.filter(s => footerLevel(s.monthly_cents) === l.level).map(s => ({
        login: s.login, name: s.name, url: s.url,
        logo: l.logo ? `/api/footer/${encodeURIComponent(s.login)}/logo?v=${s.has_logo ? 'own' : 'gh'}-${s.synced_at.slice(0, 10)}` : null,
      })),
    })),
  };
}

async function footerLogo(env: Env, login: string): Promise<Response> {
  const row = await env.DB.prepare(`SELECT f.avatar_url, coalesce(o.has_logo, 0) AS has_logo FROM footer_sponsors f
    LEFT JOIN footer_overrides o ON o.login = f.login WHERE f.login = ?1`).bind(login).first<{avatar_url: string; has_logo: number}>();
  if (!row) return new Response('Not found', {status: 404});
  if (row.has_logo) {
    const obj = await env.BUCKET.get(`footer/${login}`);
    if (obj) return new Response(obj.body, {headers: {'content-type': obj.httpMetadata?.contentType ?? 'image/webp', 'cache-control': 'public, max-age=86400'}});
  }
  // Avatars are fetched here so sites never load images from another origin.
  const res = await fetch(`${row.avatar_url}${row.avatar_url.includes('?') ? '&' : '?'}s=240`, {cf: {cacheTtl: 86400, cacheEverything: true}});
  const type = res.headers.get('content-type') ?? '';
  if (!res.ok || !/^image\/(png|jpeg|webp|gif)$/.test(type)) return new Response('Not found', {status: 404});
  return new Response(res.body, {headers: {'content-type': type, 'cache-control': 'public, max-age=86400'}});
}

/* ---------- admin ---------- */
async function adminState(env: Env) {
  const [sites, campaigns, statuses, sponsors, overrides] = await Promise.all([
    env.DB.prepare('SELECT * FROM sites ORDER BY added_at').all(),
    env.DB.prepare('SELECT * FROM campaigns ORDER BY ends_at DESC').all<CampaignRow>(),
    env.DB.prepare('SELECT * FROM campaign_sites').all<{campaign_id: number; site: string; status: string}>(),
    env.DB.prepare('SELECT * FROM footer_sponsors ORDER BY monthly_cents DESC').all(),
    env.DB.prepare('SELECT * FROM footer_overrides').all(),
  ]);
  return {
    sites: sites.results,
    campaigns: campaigns.results.map(c => ({...c, sites: Object.fromEntries(statuses.results.filter(s => s.campaign_id === c.id).map(s => [s.site, s.status]))})),
    footer: {sponsors: sponsors.results, overrides: overrides.results},
    config: {placements: PLACEMENTS, minCustomDays: MIN_CUSTOM_DAYS, footerLevels: FOOTER_LEVELS},
    githubSync: !!env.GITHUB_TOKEN,
  };
}

/** Earliest start that fits on every site the campaign could still run on. */
async function suggestStart(env: Env, placement: Placement, days: number, from: number, excludeId = 0): Promise<number> {
  const {results: sites} = await env.DB.prepare('SELECT host FROM sites').all<{host: string}>();
  let start = from;
  // Repeat until every site agrees, since moving later for one site can collide on another.
  for (let round = 0; round < 20; round++) {
    let moved = false;
    for (const {host} of sites) {
      const s = nextFreeStart(await bookedWindows(env, host, placement, excludeId), PLACEMENTS[placement].cap, start, days);
      if (s > start) { start = s; moved = true; }
    }
    if (!moved) break;
  }
  return start;
}

function cleanText(v: unknown, max: number): string {
  return String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

async function campaignFields(input: Record<string, unknown>) {
  const placement = input.placement;
  if (!isPlacement(placement)) throw new Error('Choose tall or square.');
  const kind = input.kind === 'text' ? 'text' : 'image';
  const p = PLACEMENTS[placement];
  const link = String(input.link_url ?? '').trim();
  if (!/^https:\/\/[^\s]+$/.test(link)) throw new Error('The link must start with https://');
  const sponsor = String(input.sponsor ?? '').trim().replace(/^@/, '');
  if (!/^[a-z\d](?:[a-z\d-]{0,38})$/i.test(sponsor)) throw new Error('Enter the sponsor’s GitHub login.');
  const fields = {
    sponsor, placement, kind, link_url: link,
    alt: cleanText(input.alt, 200), name: cleanText(input.name, 40),
    headline: cleanText(input.headline, p.text.headline), body: p.text.body ? cleanText(input.body, p.text.body) : '',
    note: cleanText(input.note, 500),
  };
  if (kind === 'text' && (!fields.name || !fields.headline)) throw new Error('Text ads need a name and a headline.');
  if (kind === 'image' && !fields.alt) throw new Error('Describe the image for screen readers.');
  return fields;
}

async function createCampaign(env: Env, input: Record<string, unknown>) {
  const f = await campaignFields(input);
  const days = Math.round(Number(input.days));
  if (!(days >= 1 && days <= 366)) throw new Error('Choose how many days it runs.');
  const from = input.starts_at ? fromDb(String(input.starts_at)) : Date.now();
  if (!Number.isFinite(from)) throw new Error('That start date isn’t valid.');
  const starts = input.auto === false ? from : await suggestStart(env, f.placement, days, from);
  const hash = f.kind === 'text' ? await sha256(`${f.name}\n${f.headline}\n${f.body}\n${f.link_url}`) : `pending-${crypto.randomUUID()}`;
  const row = await env.DB.prepare(`INSERT INTO campaigns (sponsor, placement, kind, creative_hash, alt, name, headline, body, link_url, starts_at, ends_at, source, note)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13) RETURNING id`)
    .bind(f.sponsor, f.placement, f.kind, hash, f.alt, f.name, f.headline, f.body, f.link_url, toDb(starts), toDb(starts + days * DAY), input.source === 'github' ? 'github' : 'manual', f.note)
    .first<number>('id');
  // Every site gets a pending row; approve the ones the sponsor asked for.
  await env.DB.prepare(`INSERT INTO campaign_sites (campaign_id, site) SELECT ?1, host FROM sites`).bind(row).run();
  return {id: row, starts_at: toDb(starts), ends_at: toDb(starts + days * DAY)};
}

async function updateCampaign(env: Env, id: number, input: Record<string, unknown>) {
  const current = await env.DB.prepare('SELECT * FROM campaigns WHERE id = ?1').bind(id).first<CampaignRow>();
  if (!current) throw new Error('No such campaign.');
  const f = await campaignFields({...current, ...input});
  const starts = input.starts_at ? fromDb(String(input.starts_at)) : fromDb(current.starts_at);
  const ends = input.ends_at ? fromDb(String(input.ends_at)) : fromDb(current.ends_at);
  if (!(Number.isFinite(starts) && Number.isFinite(ends) && ends > starts)) throw new Error('The end must be after the start.');
  const hash = f.kind === 'text' ? await sha256(`${f.name}\n${f.headline}\n${f.body}\n${f.link_url}`) : current.creative_hash;
  await env.DB.prepare(`UPDATE campaigns SET sponsor = ?2, placement = ?3, kind = ?4, alt = ?5, name = ?6, headline = ?7, body = ?8, link_url = ?9,
    note = ?10, starts_at = ?11, ends_at = ?12, creative_hash = ?13 WHERE id = ?1`)
    .bind(id, f.sponsor, f.placement, f.kind, f.alt, f.name, f.headline, f.body, f.link_url, f.note, toDb(starts), toDb(ends), hash).run();
}

async function uploadCampaignImage(env: Env, id: number, request: Request) {
  const c = await env.DB.prepare('SELECT * FROM campaigns WHERE id = ?1').bind(id).first<CampaignRow>();
  if (!c) throw new Error('No such campaign.');
  const p = PLACEMENTS[c.placement];
  const form = await request.formData();
  const files: Record<1 | 2, Uint8Array<ArrayBuffer>> = {1: new Uint8Array(0), 2: new Uint8Array(0)};
  for (const scale of [1, 2] as const) {
    const file = form.get(`x${scale}`);
    if (!(file instanceof File)) throw new Error(`Missing the ${scale}× image.`);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const problem = checkImage(bytes, p.width * scale, p.height * scale) ?? (isAnimated(bytes) ? 'Animated images aren’t allowed.' : null);
    if (problem) throw new Error(`${scale}× image: ${problem}`);
    files[scale] = bytes;
  }
  for (const scale of [1, 2] as const) {
    await env.BUCKET.put(imageKey(id, scale), files[scale], {httpMetadata: {contentType: files[scale][0] === 0x89 ? 'image/png' : 'image/webp'}});
  }
  await env.DB.prepare(`UPDATE campaigns SET kind = 'image', creative_hash = ?2 WHERE id = ?1`).bind(id, await sha256(files[2].slice())).run();
}

async function adImage(env: Env, id: number, scale: 1 | 2): Promise<Response> {
  const obj = await env.BUCKET.get(imageKey(id, scale));
  if (!obj) return new Response('Not found', {status: 404});
  return new Response(obj.body, {headers: {'content-type': obj.httpMetadata?.contentType ?? 'image/webp', 'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff'}});
}

async function addSite(env: Env, input: Record<string, unknown>) {
  const host = String(input.host ?? '').trim().toLowerCase();
  const name = cleanText(input.name, 80);
  if (!/^[a-z\d.-]+\.[a-z]{2,}$/.test(host) || !name) throw new Error('Enter the site’s host (like example.com) and a name.');
  await env.DB.batch([
    env.DB.prepare('INSERT INTO sites (host, name) VALUES (?1, ?2)').bind(host, name),
    // Campaigns that are still running or upcoming become drafts on the new site too.
    env.DB.prepare(`INSERT INTO campaign_sites (campaign_id, site) SELECT id, ?1 FROM campaigns WHERE ends_at > ?2`).bind(host, toDb(Date.now())),
  ]);
}

async function admin(request: Request, env: Env, url: URL): Promise<Response> {
  const {pathname} = url, method = request.method;
  const body = async () => (await request.json()) as Record<string, unknown>;
  if (pathname === '/api/admin/state') return json(await adminState(env));
  if (pathname === '/api/admin/suggest' && method === 'GET') {
    const placement = url.searchParams.get('placement');
    if (!isPlacement(placement)) return fail(400, 'Choose tall or square.');
    const from = url.searchParams.get('from') ? fromDb(url.searchParams.get('from')!) : Date.now();
    const start = await suggestStart(env, placement, Number(url.searchParams.get('days')) || 14, from, Number(url.searchParams.get('exclude')) || 0);
    return json({starts_at: toDb(start)});
  }
  if (pathname === '/api/admin/campaigns' && method === 'POST') return json(await createCampaign(env, await body()));
  const campaign = pathname.match(/^\/api\/admin\/campaigns\/(\d+)(\/image|\/sites\/([^/]+))?$/);
  if (campaign) {
    const id = Number(campaign[1]);
    if (campaign[2] === '/image' && method === 'POST') { await uploadCampaignImage(env, id, request); return json({ok: true}); }
    if (campaign[3] && method === 'POST') {
      const status = (await body()).status;
      if (!['pending', 'approved', 'rejected'].includes(String(status))) return fail(400, 'Unknown status.');
      if (status === 'approved') {
        const c = await env.DB.prepare('SELECT kind, creative_hash FROM campaigns WHERE id = ?1').bind(id).first<{kind: string; creative_hash: string}>();
        if (c?.kind === 'image' && c.creative_hash.startsWith('pending-')) return fail(400, 'Upload the image before approving.');
      }
      await env.DB.prepare('UPDATE campaign_sites SET status = ?3 WHERE campaign_id = ?1 AND site = ?2').bind(id, decodeURIComponent(campaign[3]), status).run();
      return json({ok: true});
    }
    if (!campaign[2] && method === 'PATCH') { await updateCampaign(env, id, await body()); return json({ok: true}); }
    if (!campaign[2] && method === 'DELETE') {
      await env.DB.prepare('DELETE FROM campaigns WHERE id = ?1').bind(id).run();
      await env.BUCKET.delete([imageKey(id, 1), imageKey(id, 2)]);
      return json({ok: true});
    }
  }
  if (pathname === '/api/admin/sites' && method === 'POST') { await addSite(env, await body()); return json({ok: true}); }
  const override = pathname.match(/^\/api\/admin\/footer\/([^/]+)(\/logo)?$/);
  if (override && method === 'POST') {
    const login = decodeURIComponent(override[1]);
    if (override[2]) {
      const file = (await request.formData()).get('logo');
      if (!(file instanceof File)) return fail(400, 'Missing the logo.');
      const bytes = new Uint8Array(await file.arrayBuffer());
      const problem = checkImage(bytes, 480, 240);
      if (problem) return fail(400, problem);
      await env.BUCKET.put(`footer/${login}`, bytes, {httpMetadata: {contentType: bytes[0] === 0x89 ? 'image/png' : 'image/webp'}});
      await env.DB.prepare(`INSERT INTO footer_overrides (login, has_logo) VALUES (?1, 1) ON CONFLICT (login) DO UPDATE SET has_logo = 1`).bind(login).run();
      return json({ok: true});
    }
    const b = await body();
    const urlValue = b.url ? String(b.url).trim() : null;
    if (urlValue && !/^https:\/\//.test(urlValue)) return fail(400, 'The link must start with https://');
    await env.DB.prepare(`INSERT INTO footer_overrides (login, hidden, display_name, url) VALUES (?1, ?2, ?3, ?4)
      ON CONFLICT (login) DO UPDATE SET hidden = ?2, display_name = ?3, url = ?4`)
      .bind(login, b.hidden ? 1 : 0, b.display_name ? cleanText(b.display_name, 60) : null, urlValue).run();
    return json({ok: true});
  }
  if (pathname === '/api/admin/sync' && method === 'POST') {
    if (!env.GITHUB_TOKEN) return fail(400, 'Set the GITHUB_TOKEN secret first.');
    return json({synced: await syncSponsors(env.DB, env.GITHUB_TOKEN)});
  }
  return fail(404, 'Not found');
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const {pathname} = url;
    try {
      if (pathname === '/admin' || pathname.startsWith('/admin/') || pathname.startsWith('/api/admin/')) {
        // Access sits in front of these paths; checking its token here too keeps them closed if that setup ever slips.
        // wrangler dev rewrites the host to the production domain, so the flag alone marks local dev.
        // It only ever lives in the git-ignored .dev.vars; production never has it.
        const local = env.LOCAL_ADMIN === '1';
        if (!local && !(await accessUser(request, env))) return new Response('Sign in through Cloudflare Access.', {status: 403});
        if (pathname.startsWith('/api/admin/')) return await admin(request, env, url);
        return env.ASSETS.fetch(request);
      }
      if (pathname === '/api/ads' || pathname === '/api/availability') {
        const site = await siteParam(env, url);
        if (!site) return fail(404, 'Unknown site.');
        return json(pathname === '/api/ads' ? await publicAds(env, site) : await availability(env, site), {maxAge: 60});
      }
      const image = pathname.match(/^\/api\/ads\/(\d+)\/image$/);
      if (image) return adImage(env, Number(image[1]), url.searchParams.get('x') === '2' ? 2 : 1);
      if (pathname === '/api/footer') return json(await footer(env), {maxAge: 300});
      const logo = pathname.match(/^\/api\/footer\/([^/]+)\/logo$/);
      if (logo) return footerLogo(env, decodeURIComponent(logo[1]));
      if (pathname === '/') return Response.redirect(SPONSORS_URL, 302);
      return env.ASSETS.fetch(request);
    } catch (err) {
      return fail(400, err instanceof Error ? err.message : 'Something went wrong.');
    }
  },
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    if (env.GITHUB_TOKEN) await syncSponsors(env.DB, env.GITHUB_TOKEN);
  },
};
