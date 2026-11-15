-- Privacy-safe daily counters for marketing: no ids, IPs or user agents.
CREATE TABLE daily_events (
  day TEXT NOT NULL,
  name TEXT NOT NULL,
  src TEXT NOT NULL DEFAULT 'direct',
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, name, src)
);
