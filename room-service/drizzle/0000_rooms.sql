CREATE TABLE rooms (
  code TEXT PRIMARY KEY NOT NULL,
  host_key TEXT NOT NULL UNIQUE,
  quiz TEXT NOT NULL,
  seconds INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  phase TEXT NOT NULL DEFAULT 'lobby' CHECK (phase IN ('lobby', 'question', 'reveal', 'finished')),
  question_index INTEGER NOT NULL DEFAULT 0,
  deadline INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE INDEX rooms_expiration ON rooms (expires_at);
--> statement-breakpoint
CREATE TABLE players (
  room_code TEXT NOT NULL REFERENCES rooms (code) ON DELETE CASCADE,
  player_key TEXT NOT NULL,
  nickname TEXT NOT NULL COLLATE NOCASE,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (room_code, player_key),
  UNIQUE (room_code, nickname)
);
--> statement-breakpoint
CREATE TABLE answers (
  room_code TEXT NOT NULL,
  player_key TEXT NOT NULL,
  question_index INTEGER NOT NULL,
  choice INTEGER NOT NULL,
  points INTEGER NOT NULL,
  PRIMARY KEY (room_code, player_key, question_index),
  FOREIGN KEY (room_code, player_key) REFERENCES players (room_code, player_key) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX answers_by_question ON answers (room_code, question_index);
