-- Sites that show sponsor ads. A new campaign gets a pending row for every site.
CREATE TABLE sites (
  host TEXT PRIMARY KEY,                    -- e.g. discordwrapped.app
  name TEXT NOT NULL,
  added_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sponsor TEXT NOT NULL,                    -- GitHub login
  placement TEXT NOT NULL CHECK (placement IN ('tall', 'square')),
  kind TEXT NOT NULL CHECK (kind IN ('image', 'text')),
  creative_hash TEXT NOT NULL,              -- same sponsor + same creative + overlapping dates = mirrored
  alt TEXT NOT NULL DEFAULT '',             -- image ads: what the image says
  name TEXT NOT NULL DEFAULT '',            -- text ads
  headline TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  link_url TEXT NOT NULL CHECK (link_url LIKE 'https://%'),
  starts_at TEXT NOT NULL,                  -- UTC, 'YYYY-MM-DD HH:MM:SS'
  ends_at TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'github')),
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (datetime(starts_at) IS NOT NULL AND datetime(ends_at) > datetime(starts_at))
);
CREATE INDEX campaigns_window ON campaigns (placement, starts_at, ends_at);

-- Approval is per site: approve where the sponsor asked, reject the rest.
CREATE TABLE campaign_sites (
  campaign_id INTEGER NOT NULL REFERENCES campaigns (id) ON DELETE CASCADE,
  site TEXT NOT NULL REFERENCES sites (host) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  PRIMARY KEY (campaign_id, site)
);

-- Public monthly sponsors, refreshed from GitHub Sponsors every hour.
CREATE TABLE footer_sponsors (
  login TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  avatar_url TEXT NOT NULL,
  url TEXT NOT NULL,
  monthly_cents INTEGER NOT NULL,
  synced_at TEXT NOT NULL
);

-- Manual changes to how a sponsor appears in the footer.
CREATE TABLE footer_overrides (
  login TEXT PRIMARY KEY,
  hidden INTEGER NOT NULL DEFAULT 0,
  display_name TEXT,
  url TEXT CHECK (url IS NULL OR url LIKE 'https://%'),
  has_logo INTEGER NOT NULL DEFAULT 0       -- logo stored in R2 at footer/<login>.webp
);

INSERT INTO sites (host, name) VALUES ('discordwrapped.app', 'Discord Wrapped');
