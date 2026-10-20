/* Dashboard for sponsor campaigns, footer sponsors and sites. Talks to /api/admin/*, which Cloudflare Access protects. */
import {cropFor, render, renderContain, type Crop} from './process.ts';

type Placement = 'tall' | 'square';
interface PlacementConfig { name: string; width: number; height: number; cap: number; daysPerDollar: number; prices: {days: number; dollars: number}[]; text: {headline: number; body: number} }
interface Campaign {
  id: number; sponsor: string; placement: Placement; kind: 'image' | 'text'; creative_hash: string; alt: string; name: string; headline: string; body: string;
  link_url: string; starts_at: string; ends_at: string; source: string; note: string; sites: Record<string, 'pending' | 'approved' | 'rejected'>;
}
interface State {
  sites: {host: string; name: string}[];
  campaigns: Campaign[];
  footer: {sponsors: {login: string; name: string; url: string; monthly_cents: number; synced_at: string}[]; overrides: {login: string; hidden: number; display_name: string | null; url: string | null; has_logo: number}[]};
  config: {placements: Record<Placement, PlacementConfig>; minCustomDays: number; footerLevels: {level: string; minCents: number}[]};
  githubSync: boolean;
}

const $ = <T = HTMLElement>(sel: string) => document.querySelector(sel) as unknown as T;
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]!));
const DAY = 86_400_000;
const utc = (s: string) => new Date(s.replace(' ', 'T') + 'Z');
const fmtDate = (s: string) => utc(s).toLocaleString(undefined, {dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC'});
let state: State;

function flash(message: string, error = false) {
  const el = $('#flash');
  el.textContent = message; el.classList.toggle('error', error);
}
async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {...init, headers: init.body instanceof FormData ? init.headers : {'content-type': 'application/json', ...init.headers}});
  const body = await res.json().catch(() => ({error: `${res.status} ${res.statusText}`})) as {error?: string};
  if (!res.ok) throw new Error(body.error ?? 'Something went wrong.');
  return body as T;
}
async function load() { state = await api<State>('/api/admin/state'); renderAll(); }

/* tabs */
document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab!)));
function showTab(tab: string) {
  document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(b => b.dataset.tab === tab ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current'));
  document.querySelectorAll('main > section').forEach(s => (s as HTMLElement).hidden = s.id !== `tab-${tab}`);
}

/* campaigns */
function phase(c: Campaign): 'upcoming' | 'running' | 'ended' {
  const now = Date.now();
  return utc(c.starts_at).getTime() > now ? 'upcoming' : utc(c.ends_at).getTime() > now ? 'running' : 'ended';
}
function thumb(c: Campaign) {
  if (c.kind === 'text') return `<div class="textad"><strong>${esc(c.headline)}</strong><br>${esc(c.body)}<br><small>${esc(c.name)}</small></div>`;
  if (c.creative_hash.startsWith('pending-')) return '<span class="status">No image yet</span>';
  return `<img src="/api/ads/${c.id}/image?x=1&v=${c.creative_hash.slice(0, 12)}" alt="${esc(c.alt)}">`;
}
function renderCampaigns() {
  const filter = $<HTMLSelectElement>('#filter').value;
  const list = state.campaigns.filter(c => filter === 'all' || (filter === 'attention' ? phase(c) !== 'ended' && Object.values(c.sites).includes('pending') : phase(c) === filter));
  $('#campaigns').innerHTML = list.map(c => `<article class="card">
    <div class="thumb">${thumb(c)}</div>
    <div>
      <strong>#${c.id} · ${esc(c.sponsor)}</strong> · ${state.config.placements[c.placement].name} ${c.kind} ad
      <div class="status">${phase(c)} · ${fmtDate(c.starts_at)} → ${fmtDate(c.ends_at)} UTC${c.source === 'github' ? ' · from GitHub Sponsors' : ''}</div>
      <div class="status"><a href="${esc(c.link_url)}" target="_blank" rel="noreferrer">${esc(c.link_url)}</a>${c.note ? ` · ${esc(c.note)}` : ''}</div>
      <div class="chips">${state.sites.map(s => {
        const st = c.sites[s.host] ?? 'pending';
        return `<span class="chip ${st}">${esc(s.name)} · ${st}
          ${st !== 'approved' ? `<button type="button" class="ok" data-approve="${c.id}" data-site="${esc(s.host)}">Approve</button>` : ''}
          ${st !== 'rejected' ? `<button type="button" class="bad" data-reject="${c.id}" data-site="${esc(s.host)}">Reject</button>` : ''}</span>`;
      }).join('')}</div>
    </div>
    <div class="actions"><button type="button" data-edit="${c.id}">Edit</button><button type="button" class="bad" data-delete="${c.id}">Delete</button></div>
  </article>`).join('') || '<p class="hint">No campaigns here.</p>';
}
$('#filter').addEventListener('change', renderCampaigns);
$('#campaigns').addEventListener('click', async e => {
  const b = (e.target as HTMLElement).closest('button'); if (!b) return;
  try {
    if (b.dataset.approve || b.dataset.reject) {
      const id = b.dataset.approve ?? b.dataset.reject;
      await api(`/api/admin/campaigns/${id}/sites/${encodeURIComponent(b.dataset.site!)}`, {method: 'POST', body: JSON.stringify({status: b.dataset.approve ? 'approved' : 'rejected'})});
      flash(`Campaign #${id} ${b.dataset.approve ? 'approved' : 'rejected'} on ${b.dataset.site}.`);
    } else if (b.dataset.delete) {
      if (!confirm(`Delete campaign #${b.dataset.delete} everywhere? This can’t be undone.`)) return;
      await api(`/api/admin/campaigns/${b.dataset.delete}`, {method: 'DELETE'});
      flash(`Campaign #${b.dataset.delete} deleted.`);
    } else if (b.dataset.edit) {
      editCampaign(state.campaigns.find(c => c.id === +b.dataset.edit!)!);
      return;
    }
    await load();
  } catch (err) { flash((err as Error).message, true); }
});

/* campaign form */
const form = $<HTMLFormElement>('#campaign-form');
const field = <T extends HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement = HTMLInputElement>(name: string) => form.elements.namedItem(name) as T;
let image: {bitmap: ImageBitmap; zoom: number; fx: number; fy: number} | null = null;
let rendered: {x1: Blob; x2: Blob} | null = null;

const placement = () => field<HTMLSelectElement>('placement').value as Placement;
const conf = () => state.config.placements[placement()];
function days(): number {
  const length = field<HTMLSelectElement>('length').value;
  if (length === 'amount') {
    const d = Math.floor(Number(field('amount').value) * conf().daysPerDollar);
    return d >= state.config.minCustomDays ? d : 0;
  }
  if (length === 'days') return Math.round(Number(field('days').value)) || 0;
  return Number(length);
}
function syncForm() {
  const length = field<HTMLSelectElement>('length').value, kind = field<HTMLSelectElement>('kind').value;
  form.querySelector<HTMLElement>('.amount')!.hidden = length !== 'amount';
  form.querySelector<HTMLElement>('.days')!.hidden = length !== 'days';
  form.querySelector<HTMLElement>('.start-date')!.hidden = field<HTMLSelectElement>('start-mode').value !== 'date';
  form.querySelector<HTMLElement>('.kind-image')!.hidden = kind !== 'image';
  form.querySelector<HTMLElement>('.kind-text')!.hidden = kind !== 'text';
  form.querySelector<HTMLElement>('.body-field')!.hidden = !conf().text.body;
  const d = days();
  $('#length-hint').textContent = length === 'amount'
    ? (d ? `$${field('amount').value} buys ${d} days at $1 = ${conf().daysPerDollar} days.` : `Custom amounts need at least ${state.config.minCustomDays} days: $${Math.ceil(state.config.minCustomDays / conf().daysPerDollar)} or more.`)
    : d ? `${d} days.` : '';
  for (const name of ['headline', 'body'] as const) {
    const max = conf().text[name], el = field(name), count = form.querySelector<HTMLElement>(`.count[data-for="${name}"]`)!;
    el.maxLength = max || 0;
    count.textContent = `${el.value.length}/${max}`;
    count.classList.toggle('over', el.value.length > max);
  }
  suggest();
  if (image) drawCrop();
}
let suggestTimer = 0;
function suggest() {
  clearTimeout(suggestTimer);
  if (field<HTMLSelectElement>('start-mode').value !== 'auto' || !days()) { $('#start-hint').textContent = ''; return; }
  suggestTimer = window.setTimeout(async () => {
    const id = field('id').value;
    const r = await api<{starts_at: string}>(`/api/admin/suggest?placement=${placement()}&days=${days()}${id ? `&exclude=${id}` : ''}`).catch(() => null);
    if (r) $('#start-hint').textContent = `Next free window starts ${fmtDate(r.starts_at)} UTC and ends ${fmtDate(new Date(utc(r.starts_at).getTime() + days() * DAY).toISOString().slice(0, 19).replace('T', ' '))} UTC.`;
  }, 200);
}
form.addEventListener('input', syncForm);
form.addEventListener('change', syncForm);

/* cropping: drag to move, slider to zoom; the crop always has the slot's exact shape */
const canvas = $<HTMLCanvasElement>('#crop-canvas');
function currentCrop(): Crop {
  const c = conf();
  return cropFor(image!.bitmap.width, image!.bitmap.height, c.width / c.height, image!.zoom, image!.fx, image!.fy);
}
let renderTimer = 0;
function drawCrop() {
  if (!image) return;
  const {bitmap} = image, scale = Math.min(1, 520 / bitmap.width, 420 / bitmap.height);
  canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
  const g = canvas.getContext('2d')!, c = currentCrop();
  g.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  g.fillStyle = 'rgb(0 0 0 / .55)';
  g.beginPath(); g.rect(0, 0, canvas.width, canvas.height); g.rect(c.sx * scale, c.sy * scale, c.sw * scale, c.sh * scale); g.fill('evenodd');
  g.strokeStyle = '#fff'; g.lineWidth = 2; g.strokeRect(c.sx * scale, c.sy * scale, c.sw * scale, c.sh * scale);
  clearTimeout(renderTimer);
  renderTimer = window.setTimeout(renderPreviews, 150);
}
async function renderPreviews() {
  if (!image) return;
  const c = conf(), crop = currentCrop();
  try {
    const [x1, x2] = await Promise.all([render(image.bitmap, crop, c.width, c.height), render(image.bitmap, crop, c.width * 2, c.height * 2)]);
    rendered = {x1: x1.blob, x2: x2.blob};
    for (const [key, r, w, h] of [['1x', x1, c.width, c.height], ['2x', x2, c.width * 2, c.height * 2]] as const) {
      const img = $<HTMLImageElement>(`#preview-${key}`);
      URL.revokeObjectURL(img.src); img.src = URL.createObjectURL(r.blob); img.width = c.width; img.height = c.height;
      $(`#preview-${key}-cap`).textContent = `${key}: ${w}×${h}, ${Math.round(r.blob.size / 1024)} KB, ${r.algorithm}`;
    }
  } catch (err) { rendered = null; flash((err as Error).message, true); }
}
field('file').addEventListener('change', async () => {
  const file = field('file').files?.[0];
  if (!file) return;
  try {
    image = {bitmap: await createImageBitmap(file), zoom: 1, fx: .5, fy: .5};
    $<HTMLInputElement>('#crop-zoom').value = '1';
    $('#cropper').hidden = false;
    drawCrop();
  } catch { flash('That file isn’t an image this browser can open.', true); }
});
$('#crop-zoom').addEventListener('input', e => { if (image) { image.zoom = Number((e.target as HTMLInputElement).value); drawCrop(); } });
canvas.addEventListener('pointerdown', e => {
  if (!image) return;
  canvas.setPointerCapture(e.pointerId);
  const move = (ev: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    image!.fx = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
    image!.fy = Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height));
    drawCrop();
  };
  move(e);
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', () => canvas.removeEventListener('pointermove', move), {once: true});
});

function resetForm() {
  form.reset(); field('id').value = ''; image = null; rendered = null;
  $('#cropper').hidden = true; $('#save').textContent = 'Create campaign'; $('#cancel-edit').hidden = true;
  syncForm();
}
function editCampaign(c: Campaign) {
  resetForm();
  showTab('new');
  for (const k of ['sponsor', 'placement', 'kind', 'alt', 'name', 'headline', 'body', 'link_url', 'note'] as const) field(k).value = String(c[k] ?? '');
  field('id').value = String(c.id);
  field<HTMLSelectElement>('length').value = 'days';
  field('days').value = String(Math.round((utc(c.ends_at).getTime() - utc(c.starts_at).getTime()) / DAY));
  field<HTMLSelectElement>('start-mode').value = 'date';
  field('start').value = c.starts_at.replace(' ', 'T').slice(0, 16);
  $('#save').textContent = `Save campaign #${c.id}`; $('#cancel-edit').hidden = false;
  syncForm();
}
$('#cancel-edit').addEventListener('click', () => { resetForm(); showTab('campaigns'); });

form.addEventListener('submit', async e => {
  e.preventDefault();
  const d = days();
  if (!d) { flash('Choose how long the campaign runs.', true); return; }
  const kind = field<HTMLSelectElement>('kind').value, id = field('id').value;
  if (kind === 'image' && !id && !rendered) { flash('Choose an image first.', true); return; }
  const data: Record<string, unknown> = Object.fromEntries(['sponsor', 'placement', 'kind', 'alt', 'name', 'headline', 'body', 'link_url', 'note'].map(k => [k, field(k).value]));
  const auto = field<HTMLSelectElement>('start-mode').value === 'auto';
  const start = auto ? null : field('start').value.replace('T', ' ') + ':00';
  $<HTMLButtonElement>('#save').disabled = true;
  try {
    let campaignId = Number(id);
    if (id) {
      const s = start ?? (await api<{starts_at: string}>(`/api/admin/suggest?placement=${placement()}&days=${d}&exclude=${id}`)).starts_at;
      await api(`/api/admin/campaigns/${id}`, {method: 'PATCH', body: JSON.stringify({...data, starts_at: s, ends_at: new Date(utc(s).getTime() + d * DAY).toISOString().slice(0, 19).replace('T', ' ')})});
    } else {
      const r = await api<{id: number; starts_at: string}>('/api/admin/campaigns', {method: 'POST', body: JSON.stringify({...data, days: d, starts_at: start, auto})});
      campaignId = r.id;
    }
    if (kind === 'image' && rendered) {
      const fd = new FormData();
      fd.set('x1', rendered.x1, 'x1.webp'); fd.set('x2', rendered.x2, 'x2.webp');
      await api(`/api/admin/campaigns/${campaignId}/image`, {method: 'POST', body: fd});
    }
    flash(id ? `Campaign #${campaignId} saved.` : `Campaign #${campaignId} created as a draft on every site. Approve it where the sponsor asked.`);
    resetForm(); await load(); showTab('campaigns');
    $<HTMLSelectElement>('#filter').value = 'attention'; renderCampaigns();
  } catch (err) { flash((err as Error).message, true); }
  finally { $<HTMLButtonElement>('#save').disabled = false; }
});

/* footer */
function renderFooter() {
  const {sponsors, overrides} = state.footer;
  $('#sync-hint').textContent = state.githubSync ? (sponsors[0] ? `Last refreshed ${new Date(sponsors[0].synced_at).toLocaleString()}.` : 'No public monthly sponsors yet.') : 'Set the GITHUB_TOKEN secret to read GitHub Sponsors.';
  $('#footer-list').innerHTML = sponsors.length ? `<table><thead><tr><th>Sponsor</th><th>Monthly</th><th>Shown as</th><th>Link</th><th>Logo (2:1)</th><th></th></tr></thead><tbody>${sponsors.map(s => {
    const o = overrides.find(x => x.login === s.login);
    return `<tr data-login="${esc(s.login)}"><td>${esc(s.login)}<br><label><span><input type="checkbox" name="hidden" ${o?.hidden ? 'checked' : ''}> Hide</span></label></td>
      <td>$${(s.monthly_cents / 100).toFixed(0)}</td><td><input name="display_name" value="${esc(o?.display_name ?? '')}" placeholder="${esc(s.name)}"></td>
      <td><input name="url" value="${esc(o?.url ?? '')}" placeholder="${esc(s.url)}"></td>
      <td><img src="/api/footer/${encodeURIComponent(s.login)}/logo?v=${Date.now()}" alt="" width="96" height="48" style="object-fit:contain"><input type="file" name="logo" accept="image/*"></td>
      <td><button type="button" data-save-footer>Save</button></td></tr>`;
  }).join('')}</tbody></table>` : '';
}
$('#footer-list').addEventListener('click', async e => {
  const b = (e.target as HTMLElement).closest('[data-save-footer]'); if (!b) return;
  const row = b.closest('tr')!, login = row.dataset.login!;
  const v = (n: string) => row.querySelector<HTMLInputElement>(`[name="${n}"]`)!;
  try {
    await api(`/api/admin/footer/${encodeURIComponent(login)}`, {method: 'POST', body: JSON.stringify({hidden: v('hidden').checked, display_name: v('display_name').value || null, url: v('url').value || null})});
    const file = v('logo').files?.[0];
    if (file) {
      const fd = new FormData();
      fd.set('logo', await renderContain(await createImageBitmap(file), 480, 240), 'logo.webp');
      await api(`/api/admin/footer/${encodeURIComponent(login)}/logo`, {method: 'POST', body: fd});
    }
    flash(`Saved ${login}.`); await load();
  } catch (err) { flash((err as Error).message, true); }
});
$('#sync').addEventListener('click', async () => {
  try { const r = await api<{synced: number}>('/api/admin/sync', {method: 'POST'}); flash(`Found ${r.synced} public monthly sponsors.`); await load(); }
  catch (err) { flash((err as Error).message, true); }
});

/* sites */
function renderSites() {
  $('#sites').innerHTML = `<table><thead><tr><th>Site</th><th>Host</th></tr></thead><tbody>${state.sites.map(s => `<tr><td>${esc(s.name)}</td><td>${esc(s.host)}</td></tr>`).join('')}</tbody></table>`;
}
$<HTMLFormElement>('#site-form').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target as HTMLFormElement, data = Object.fromEntries(new FormData(f));
  try { await api('/api/admin/sites', {method: 'POST', body: JSON.stringify(data)}); flash(`Added ${data.host}.`); f.reset(); await load(); }
  catch (err) { flash((err as Error).message, true); }
});

function renderAll() { renderCampaigns(); renderFooter(); renderSites(); syncForm(); }
load().catch(err => flash((err as Error).message, true));
