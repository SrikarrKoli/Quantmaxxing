CREATE TABLE players (
  uid TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  provider TEXT NOT NULL,
  rating REAL NOT NULL DEFAULT 1200,
  rated_games INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  draws INTEGER NOT NULL DEFAULT 0,
  total_correct INTEGER NOT NULL DEFAULT 0,
  best_60 INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX players_rating ON players (rating DESC) WHERE rated_games > 0;

CREATE TABLE matches (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL,
  duration_s INTEGER NOT NULL,
  seed TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  end_reason TEXT NOT NULL,
  rated INTEGER NOT NULL DEFAULT 0,
  player_count INTEGER NOT NULL
);
CREATE INDEX matches_ended ON matches (ended_at DESC);

-- One row per participant. Also the privacy-safe telemetry source for the heart rule.
CREATE TABLE match_players (
  match_id TEXT NOT NULL REFERENCES matches (id) ON DELETE CASCADE,
  player_key TEXT NOT NULL,
  uid TEXT,
  kind TEXT NOT NULL,
  username TEXT NOT NULL,
  placement INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  correct INTEGER NOT NULL,
  wrong INTEGER NOT NULL,
  questions_reached INTEGER NOT NULL,
  hearts_left INTEGER NOT NULL,
  eliminated INTEGER NOT NULL,
  eliminated_at_ms INTEGER,
  mistake_times_ms TEXT NOT NULL DEFAULT '[]',
  device TEXT NOT NULL DEFAULT 'unknown',
  rating_before REAL,
  rating_after REAL,
  PRIMARY KEY (match_id, player_key)
);
CREATE INDEX match_players_uid ON match_players (uid, match_id) WHERE uid IS NOT NULL;
