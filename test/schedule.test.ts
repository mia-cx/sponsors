import assert from 'node:assert/strict';
import {test} from 'node:test';
import {PLACEMENTS, footerLevel} from '../src/worker/config.ts';
import {footerSponsors} from '../src/worker/github.ts';
import {checkImage, imageInfo, isAnimated} from '../src/worker/images.ts';
import {collapseMirrored, customDays, fromDb, nextFreeStart, peakLoad, toDb} from '../src/worker/schedule.ts';

const DAY = 86_400_000, T0 = Date.UTC(2026, 10, 1);
const w = (startDay: number, days: number) => ({starts: T0 + startDay * DAY, ends: T0 + (startDay + days) * DAY});

test('dates round-trip through the database format', () => {
  assert.equal(toDb(T0), '2026-11-01 00:00:00');
  assert.equal(fromDb('2026-11-01 00:00:00'), T0);
});

test('back-to-back campaigns do not overlap', () => {
  assert.equal(peakLoad([w(0, 14), w(14, 14)], T0, T0 + 28 * DAY), 1);
  assert.equal(peakLoad([w(0, 14), w(13, 14)], T0, T0 + 28 * DAY), 2);
});

test('a full placement books the next free window', () => {
  const full = Array.from({length: 6}, (_, i) => w(0, 14 + i));
  assert.equal(nextFreeStart(full, 6, T0, 14), T0 + 14 * DAY);
  assert.equal(nextFreeStart(full.slice(0, 5), 6, T0, 14), T0);
  // Five more campaigns start on day 14, so the placement stays full until the last early one ends on day 19.
  assert.equal(nextFreeStart([...full, w(14, 28), w(14, 28), w(14, 28), w(14, 28), w(14, 28)], 6, T0, 28), T0 + 19 * DAY);
});

test('the same sponsor and creative at the same time is mirrored', () => {
  const row = (id: number, sponsor: string, hash: string) => ({id, sponsor, placement: 'tall', creative_hash: hash, starts_at: '', ends_at: ''});
  const out = collapseMirrored([row(1, 'a', 'x'), row(2, 'b', 'y'), row(3, 'a', 'x'), row(4, 'a', 'z')]);
  assert.deepEqual(out.map(r => [r.id, r.mirrored]), [[1, true], [2, false], [4, false]]);
});

test('custom amounts buy days at the 4-week rate, with a minimum', () => {
  assert.equal(customDays(10, PLACEMENTS.tall.daysPerDollar, 7), 20);
  assert.equal(customDays(3, PLACEMENTS.tall.daysPerDollar, 7), 0);
  assert.equal(customDays(2, PLACEMENTS.square.daysPerDollar, 7), 8);
  // Prices stay consistent with the tiers: 4 weeks costs the custom rate.
  for (const p of Object.values(PLACEMENTS)) assert.equal(p.prices.find(x => x.days === 28)!.dollars * p.daysPerDollar, 28);
});

test('footer levels follow the monthly amount', () => {
  assert.equal(footerLevel(10000), 'hero');
  assert.equal(footerLevel(1000), 'featured');
  assert.equal(footerLevel(300), 'grid');
  assert.equal(footerLevel(0), null);
});

test('private and one-time sponsors never reach the footer', () => {
  const node = (privacyLevel: 'PUBLIC' | 'PRIVATE', isOneTime: boolean, login: string) => ({privacyLevel, tier: {monthlyPriceInCents: 1000, isOneTime}, sponsorEntity: {login, name: null, avatarUrl: 'https://a', url: 'https://u'}});
  assert.deepEqual(footerSponsors([node('PUBLIC', false, 'a'), node('PRIVATE', false, 'b'), node('PUBLIC', true, 'c')]).map(s => s.login), ['a']);
});

function webpVP8X(width: number, height: number, extra = '') {
  const b = new Uint8Array(30 + extra.length);
  b.set(new TextEncoder().encode('RIFF'), 0); b.set(new TextEncoder().encode('WEBPVP8X'), 8);
  b[24] = (width - 1) & 255; b[25] = ((width - 1) >> 8) & 255; b[27] = (height - 1) & 255; b[28] = ((height - 1) >> 8) & 255;
  b.set(new TextEncoder().encode(extra), 30);
  return b;
}
test('uploaded images must match the slot size exactly', () => {
  assert.deepEqual(imageInfo(webpVP8X(320, 1200)), {type: 'image/webp', width: 320, height: 1200});
  assert.equal(checkImage(webpVP8X(320, 1200), 320, 1200), null);
  assert.match(checkImage(webpVP8X(321, 1200), 320, 1200)!, /must be 320×1200/);
  assert.match(checkImage(new Uint8Array(400 * 1024), 160, 160)!, /limit/);
  assert.match(checkImage(new TextEncoder().encode('GIF89a........................'), 160, 160)!, /PNG or WebP/);
  assert.equal(isAnimated(webpVP8X(160, 160, 'ANIM')), true);
});
