/* Verifies the Cloudflare Access login token, so /admin stays closed even if the Access app is misconfigured. */
export interface AccessEnv { ACCESS_TEAM_DOMAIN?: string; ACCESS_AUD?: string }

const b64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), c => c.charCodeAt(0));
let keyCache: {domain: string; keys: Map<string, CryptoKey>; at: number} | null = null;

async function keys(domain: string): Promise<Map<string, CryptoKey>> {
  if (keyCache && keyCache.domain === domain && Date.now() - keyCache.at < 3_600_000) return keyCache.keys;
  const res = await fetch(`${domain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error('Could not load Access keys');
  const {keys: jwks} = await res.json() as {keys: (JsonWebKey & {kid: string})[]};
  const map = new Map<string, CryptoKey>();
  for (const k of jwks) map.set(k.kid, await crypto.subtle.importKey('jwk', k, {name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256'}, false, ['verify']));
  keyCache = {domain, keys: map, at: Date.now()};
  return map;
}

/** The signed-in email, or null if the request isn't from a valid Access session. */
export async function accessUser(request: Request, env: AccessEnv): Promise<string | null> {
  const domain = env.ACCESS_TEAM_DOMAIN?.replace(/\/$/, ''), aud = env.ACCESS_AUD;
  const token = request.headers.get('cf-access-jwt-assertion');
  if (!domain || !aud || !token) return null;
  const [h, p, s] = token.split('.');
  if (!h || !p || !s) return null;
  try {
    const header = JSON.parse(new TextDecoder().decode(b64url(h)));
    const payload = JSON.parse(new TextDecoder().decode(b64url(p)));
    const key = (await keys(domain)).get(header.kid);
    if (!key || header.alg !== 'RS256') return null;
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(s), new TextEncoder().encode(`${h}.${p}`));
    const now = Date.now() / 1000;
    const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!ok || !auds.includes(aud) || payload.iss !== domain || payload.exp < now || (payload.nbf && payload.nbf > now + 60)) return null;
    return payload.email ?? payload.sub ?? 'unknown';
  } catch {
    return null;
  }
}
