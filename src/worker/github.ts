/* Copies public monthly sponsors from GitHub Sponsors into D1 for the footer grid. */
const QUERY = `query($after: String) {
  viewer {
    sponsorshipsAsMaintainer(first: 100, after: $after, activeOnly: true, includePrivate: false) {
      pageInfo { hasNextPage endCursor }
      nodes {
        privacyLevel
        tier { monthlyPriceInCents isOneTime }
        sponsorEntity {
          ... on User { login name avatarUrl url }
          ... on Organization { login name avatarUrl url }
        }
      }
    }
  }
}`;

export interface FooterSponsor { login: string; name: string; avatar_url: string; url: string; monthly_cents: number }

interface Node {
  privacyLevel: 'PUBLIC' | 'PRIVATE';
  tier: {monthlyPriceInCents: number; isOneTime: boolean} | null;
  sponsorEntity: {login: string; name: string | null; avatarUrl: string; url: string} | null;
}

/** Public, recurring sponsorships only: private sponsors and one-time payments never appear in the footer. */
export function footerSponsors(nodes: Node[]): FooterSponsor[] {
  return nodes
    .filter(n => n.privacyLevel === 'PUBLIC' && n.tier && !n.tier.isOneTime && n.tier.monthlyPriceInCents > 0 && n.sponsorEntity)
    .map(n => ({login: n.sponsorEntity!.login, name: n.sponsorEntity!.name || n.sponsorEntity!.login, avatar_url: n.sponsorEntity!.avatarUrl, url: n.sponsorEntity!.url, monthly_cents: n.tier!.monthlyPriceInCents}));
}

export async function fetchSponsors(token: string): Promise<FooterSponsor[]> {
  const nodes: Node[] = [];
  let after: string | null = null;
  do {
    const res = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: {authorization: `bearer ${token}`, 'content-type': 'application/json', 'user-agent': 'mia-cx-sponsors'},
      body: JSON.stringify({query: QUERY, variables: {after}}),
    });
    const json = await res.json() as {data?: {viewer: {sponsorshipsAsMaintainer: {pageInfo: {hasNextPage: boolean; endCursor: string}; nodes: Node[]}}}; errors?: unknown};
    if (!res.ok || !json.data) throw new Error(`GitHub Sponsors sync failed: ${res.status} ${JSON.stringify(json.errors ?? '')}`);
    const page = json.data.viewer.sponsorshipsAsMaintainer;
    nodes.push(...page.nodes);
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  return footerSponsors(nodes);
}

export async function syncSponsors(db: D1Database, token: string): Promise<number> {
  const sponsors = await fetchSponsors(token);
  const now = new Date().toISOString();
  await db.batch([
    db.prepare('DELETE FROM footer_sponsors'),
    ...sponsors.map(s => db.prepare('INSERT INTO footer_sponsors (login, name, avatar_url, url, monthly_cents, synced_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
      .bind(s.login, s.name, s.avatar_url, s.url, s.monthly_cents, now)),
  ]);
  return sponsors.length;
}
