-- Solo practice runs saved for signed-in players (matches already live in match_players).
CREATE TABLE practice_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT NOT NULL,
  duration_s INTEGER NOT NULL,
  correct INTEGER NOT NULL,
  wrong INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX practice_runs_uid ON practice_runs (uid, created_at);

-- Lets a guest's matches be attached to the account they sign in with.
CREATE INDEX match_players_key ON match_players (player_key) WHERE uid IS NULL;
