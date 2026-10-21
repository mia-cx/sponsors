/* Placements, prices and footer levels. Every site that shows sponsor ads uses these. */
export const SPONSORS_URL = 'https://github.com/sponsors/mia-riezebos';
export const SPONSOR_EMAIL = 'sponsor@mia.cx';

export type Placement = 'tall' | 'square';

export const PLACEMENTS: Record<Placement, {
  name: string;
  width: number; height: number;
  /** Most campaigns that may overlap on one site; a mirrored campaign counts twice. */
  cap: number;
  /** How long each ad stays up per turn. */
  seconds: number;
  /** One-time GitHub Sponsors tiers, in US dollars. */
  prices: {days: number; dollars: number}[];
  /** Custom one-time amounts buy days at the 4-week rate. */
  daysPerDollar: number;
  text: {headline: number; body: number};
}> = {
  tall: {name: 'Tall', width: 160, height: 600, cap: 6, seconds: 30, prices: [{days: 14, dollars: 8}, {days: 28, dollars: 14}], daysPerDollar: 2, text: {headline: 40, body: 90}},
  square: {name: 'Square', width: 160, height: 160, cap: 8, seconds: 20, prices: [{days: 14, dollars: 4}, {days: 28, dollars: 7}], daysPerDollar: 4, text: {headline: 30, body: 0}},
};
export const MIN_CUSTOM_DAYS = 7;
export const MAX_IMAGE_BYTES = 300 * 1024;

// Monthly sponsors appear in the footer grid, sized by their monthly amount.
export const FOOTER_LEVELS = [
  {level: 'hero', minCents: 10000, columns: 3, logo: true},
  {level: 'featured', minCents: 1000, columns: 6, logo: true},
  {level: 'grid', minCents: 1, columns: 8, logo: false},
] as const;
export type FooterLevel = typeof FOOTER_LEVELS[number]['level'];

export const footerLevel = (monthlyCents: number): FooterLevel | null =>
  FOOTER_LEVELS.find(l => monthlyCents >= l.minCents)?.level ?? null;
