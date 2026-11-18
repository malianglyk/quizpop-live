ALTER TABLE rooms ADD COLUMN show_ranking INTEGER NOT NULL DEFAULT 0 CHECK (show_ranking IN (0, 1));
--> statement-breakpoint
CREATE TABLE room_images (
  room_code TEXT NOT NULL REFERENCES rooms (code) ON DELETE CASCADE,
  question_index INTEGER NOT NULL,
  source TEXT NOT NULL,
  PRIMARY KEY (room_code, question_index)
);
