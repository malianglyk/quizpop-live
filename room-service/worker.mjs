const roomLifetime = 4 * 60 * 60 * 1000;
const capacity = 60;
const maxBodyBytes = 64 * 1024;
const maxRoomBytes = 2 * 1024 * 1024;
const maxImageLength = 23 + 4 * Math.ceil((64 * 1024) / 3);
const imagePattern = /^data:image\/jpeg;base64,\/9j\/[A-Za-z0-9+/]*={0,2}$/;
const minQuestionSeconds = 5;
const maxQuestionSeconds = 300;
const pagesOrigin = "https://malianglyk.github.io";

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function select(db, sql, ...values) {
  return db.prepare(sql).bind(...values).first();
}

async function list(db, sql, ...values) {
  const { results } = await db.prepare(sql).bind(...values).all();
  return results;
}

async function change(db, sql, ...values) {
  const { meta } = await db.prepare(sql).bind(...values).run();
  return meta.changes;
}

async function readJson(request, limit = maxBodyBytes) {
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, "Send the room details.");
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) {
        await reader.cancel();
        throw new ApiError(413, "This request is too large.");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error();
    return data;
  } catch {
    throw new ApiError(400, "Send valid room details.");
  }
}

async function getKey(request) {
  const token = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.get("Authorization") || "")?.[1];
  if (!token) throw new ApiError(401, "Open this room from the browser tab you used to join or host.");
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
}

function textField(value, max, required = true) {
  if (typeof value !== "string") throw new ApiError(400, "Check the text you entered.");
  const text = value.trim();
  if ((required && !text) || text.length > max) throw new ApiError(400, "Check the text you entered.");
  return text;
}

function validQuestionTime(seconds) {
  return Number.isInteger(seconds) && seconds >= minQuestionSeconds && seconds <= maxQuestionSeconds;
}

function validateQuiz(input) {
  if (!input || !Array.isArray(input.questions) || input.questions.length < 1 || input.questions.length > 20) {
    throw new ApiError(400, "Choose a quiz with 1 to 20 questions.");
  }
  const images = [];
  const quiz = {
    title: textField(input.title, 70),
    questions: input.questions.map((question, index) => {
      if (!Array.isArray(question) || !Array.isArray(question[1]) || question[1].length !== 4 ||
          !Number.isInteger(question[2]) || question[2] < 0 || question[2] > 3) {
        throw new ApiError(400, "Each question needs four choices and one correct answer.");
      }
      const seconds = question[4] ?? null;
      if (seconds !== null && !validQuestionTime(seconds)) {
        throw new ApiError(400, `Each question’s time limit must be a whole number from ${minQuestionSeconds} to ${maxQuestionSeconds} seconds.`);
      }
      const image = question[5] ?? null;
      if (image !== null) {
        if (typeof image !== "string" || image.length > maxImageLength || !imagePattern.test(image)) {
          throw new ApiError(400, "Upload the question image again in the quiz builder.");
        }
        images.push({ index, image });
      }
      return [
        textField(question[0], 220),
        question[1].map(option => textField(option, 120)),
        question[2],
        textField(question[3], 350, false),
        seconds,
        image !== null
      ];
    })
  };
  return { quiz, images };
}

function phaseAt(room, now) {
  return room.phase === "question" && now >= room.deadline ? "reveal" : room.phase;
}

function questionSeconds(room, question) {
  return question[4] ?? room.seconds;
}

async function createRoom(db, hostKey, data) {
  const { quiz, images } = validateQuiz(data.quiz);
  if (!validQuestionTime(data.seconds)) {
    throw new ApiError(400, `Set a default time limit from ${minQuestionSeconds} to ${maxQuestionSeconds} seconds.`);
  }
  const now = Date.now();
  await change(db, "DELETE FROM rooms WHERE expires_at <= ?", now);
  const expires = now + roomLifetime;
  const savedQuiz = JSON.stringify(quiz);
  for (let attempt = 0; attempt < 6; attempt++) {
    const random = crypto.getRandomValues(new Uint32Array(1))[0];
    const code = String(100000 + random % 900000);
    const insertRoom = db.prepare(`
      INSERT OR IGNORE INTO rooms (code, host_key, quiz, seconds, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).bind(code, hostKey, savedQuiz, data.seconds, expires);
    const assets = images.map(({ index, image }) => db.prepare(`
      INSERT OR IGNORE INTO room_images (room_code, question_index, source)
      SELECT code, ?, ? FROM rooms WHERE code = ? AND host_key = ? AND expires_at = ?
    `).bind(index, image, code, hostKey, expires));
    const result = assets.length ? (await db.batch([insertRoom, ...assets]))[0] : await insertRoom.run();
    if (result.meta.changes) return { code };
    const existing = await select(db, "SELECT code FROM rooms WHERE host_key = ?", hostKey);
    if (existing) return { code: existing.code };
  }
  throw new ApiError(503, "Couldn’t generate a room code. Try again.");
}

async function joinRoom(db, room, key, data) {
  const nickname = textField(data.nickname, 24);
  if (room.host_key === key) throw new ApiError(409, "Use a different tab to join as a participant.");
  if (await select(db, "SELECT nickname FROM players WHERE room_code = ? AND player_key = ?", room.code, key)) {
    return { code: room.code };
  }
  if (room.phase !== "lobby") throw new ApiError(409, "This quiz has already started.");
  const inserted = await change(db, `
    INSERT OR IGNORE INTO players (room_code, player_key, nickname, joined_at)
    SELECT code, ?, ?, ?
    FROM rooms
    WHERE code = ? AND phase = 'lobby' AND expires_at > ?
      AND (SELECT COUNT(*) FROM players WHERE room_code = rooms.code) < ?
  `, key, nickname, Date.now(), room.code, Date.now(), capacity);
  if (inserted || await select(db, "SELECT nickname FROM players WHERE room_code = ? AND player_key = ?", room.code, key)) {
    return { code: room.code };
  }
  if (await select(db, "SELECT nickname FROM players WHERE room_code = ? AND nickname = ? COLLATE NOCASE", room.code, nickname)) {
    throw new ApiError(409, "That nickname is in use. Choose another.");
  }
  const current = await select(db, "SELECT phase FROM rooms WHERE code = ?", room.code);
  if (current?.phase === "lobby") throw new ApiError(409, "The room is full.");
  throw new ApiError(409, "This quiz has already started or the room has expired.");
}

async function roomState(db, room, role, key, nickname) {
  const now = Date.now();
  const phase = phaseAt(room, now);
  const quiz = JSON.parse(room.quiz);
  const state = {
    code: room.code,
    title: quiz.title,
    index: room.question_index,
    total: quiz.questions.length,
    phase,
    ranking: !!room.show_ranking,
    role,
    nickname,
    seconds: questionSeconds(room, quiz.questions[room.question_index]),
    deadline: room.deadline,
    serverTime: now
  };

  if (phase === "lobby") {
    const players = await list(db, "SELECT nickname FROM players WHERE room_code = ? ORDER BY joined_at, nickname", room.code);
    state.playerCount = players.length;
    if (role === "host") state.players = players.map(player => player.nickname);
    return state;
  }

  if (phase === "question" || phase === "reveal") {
    const [prompt, options, correct, explanation, , hasImage] = quiz.questions[room.question_index];
    state.question = { prompt, options, hasImage: !!hasImage };
    if (phase === "reveal") {
      state.question.correct = correct;
      state.question.explanation = explanation;
      if (!state.ranking) {
        const responses = await list(db, `
          SELECT players.nickname, answers.choice FROM players LEFT JOIN answers
          ON answers.room_code = players.room_code AND answers.player_key = players.player_key
            AND answers.question_index = ?
          WHERE players.room_code = ?
          ORDER BY players.nickname COLLATE NOCASE, players.player_key
        `, room.question_index, room.code);
        const counts = [0, 0, 0, 0];
        let unanswered = 0;
        for (const { choice } of responses) {
          if (choice === null) unanswered++;
          else counts[choice]++;
        }
        state.distribution = { counts, unanswered };
        if (role === "host") state.responses = responses;
      }
    }
    if (role === "player") {
      const answer = await select(db, `
        SELECT choice, points FROM answers
        WHERE room_code = ? AND player_key = ? AND question_index = ?
      `, room.code, key, room.question_index);
      state.choice = answer?.choice ?? null;
      if (phase === "reveal") state.points = answer?.points ?? 0;
    } else if (phase === "question") {
      const counts = await select(db, `
        SELECT COUNT(*) AS playerCount,
          (SELECT COUNT(*) FROM answers WHERE room_code = ? AND question_index = ?) AS answerCount
        FROM players WHERE room_code = ?
      `, room.code, room.question_index, room.code);
      state.playerCount = counts.playerCount;
      state.answerCount = counts.answerCount;
    }
  }

  if (phase === "reveal" || phase === "finished") {
    const scores = await list(db, `
      WITH totals AS (
        SELECT players.nickname, players.player_key, COALESCE(SUM(answers.points), 0) AS score,
          SUM(CASE WHEN answers.question_index < ? THEN answers.points ELSE 0 END) AS previous_score
        FROM players LEFT JOIN answers
          ON answers.room_code = players.room_code AND answers.player_key = players.player_key
          AND answers.question_index <= ?
        WHERE players.room_code = ?
        GROUP BY players.player_key
      )
      SELECT nickname, player_key, score,
        ROW_NUMBER() OVER (ORDER BY previous_score DESC, nickname COLLATE NOCASE, player_key) AS previous_rank
      FROM totals ORDER BY score DESC, nickname COLLATE NOCASE, player_key
    `, room.question_index, room.question_index, room.code);
    const ranked = scores.map((player, index) => ({
      nickname: player.nickname,
      score: player.score,
      rank: index + 1,
      movement: room.question_index ? player.previous_rank - (index + 1) : null,
      you: role === "player" && player.player_key === key
    }));
    state.leaderboard = ranked.slice(0, 5);
    if (role === "player") state.yourRank = ranked.find(player => player.you)?.rank;
  }
  return state;
}

async function advanceRoom(db, room, data) {
  const now = Date.now();
  const phase = phaseAt(room, now);
  const ranking = !!room.show_ranking;
  if (data.phase !== phase || data.index !== room.question_index ||
      (typeof data.ranking === "boolean" && data.ranking !== ranking)) {
    throw new ApiError(409, "The room changed. Check the current question and try again.");
  }
  const { questions } = JSON.parse(room.quiz);
  let nextPhase;
  let nextIndex = room.question_index;
  let deadline = 0;
  let nextRanking = 0;
  if (phase === "lobby") {
    nextPhase = "question";
  } else if (phase === "question") {
    nextPhase = "reveal";
  } else if (phase === "reveal") {
    if (data.ranking === false) {
      nextPhase = "reveal";
      nextRanking = 1;
    } else if (nextIndex + 1 < questions.length) {
      nextIndex++;
      nextPhase = "question";
    } else {
      nextPhase = "finished";
    }
  } else {
    throw new ApiError(409, "This quiz is complete.");
  }
  if (nextPhase === "question") deadline = now + questionSeconds(room, questions[nextIndex]) * 1000;
  const changed = await change(db, `
    UPDATE rooms SET phase = ?, question_index = ?, deadline = ?, show_ranking = ?
    WHERE code = ? AND phase = ? AND question_index = ? AND deadline = ? AND show_ranking = ? AND expires_at > ?
      AND EXISTS (SELECT 1 FROM players WHERE room_code = rooms.code)
  `, nextPhase, nextIndex, deadline, nextRanking, room.code, room.phase, room.question_index, room.deadline, room.show_ranking, now);
  if (!changed) throw new ApiError(409, "Wait for a player to join or refresh the room and try again.");
  return { updated: true };
}

async function submitAnswer(db, room, key, data, receivedAt) {
  const { index, choice } = data;
  if (!Number.isInteger(index) || !Number.isInteger(choice) || choice < 0 || choice > 3) {
    throw new ApiError(400, "Choose one of the four answers.");
  }
  if (phaseAt(room, receivedAt) !== "question" || index !== room.question_index) {
    throw new ApiError(409, "This question has closed.");
  }
  const question = JSON.parse(room.quiz).questions[index];
  const duration = questionSeconds(room, question) * 1000;
  const remaining = Math.min(duration, room.deadline - receivedAt);
  const points = question[2] === choice ? 600 + Math.round(400 * remaining / duration) : 0;
  const inserted = await change(db, `
    INSERT OR IGNORE INTO answers (room_code, player_key, question_index, choice, points)
    SELECT code, ?, ?, ?, ?
    FROM rooms
    WHERE code = ? AND phase = 'question' AND question_index = ?
      AND deadline > ? AND expires_at > ?
  `, key, index, choice, points, room.code, index, receivedAt, receivedAt);
  if (!inserted) {
    const previous = await select(db, `
      SELECT choice FROM answers WHERE room_code = ? AND player_key = ? AND question_index = ?
    `, room.code, key, index);
    if (previous?.choice === choice) return { accepted: true };
    throw new ApiError(409, previous ? "Your answer is already locked in." : "This question has closed.");
  }
  return { accepted: true };
}

const libraryPageSize = 16;

function librarySearchText(value) {
  return value.normalize("NFKC").toLowerCase().trim();
}

async function searchLibrary(db, owner, params) {
  const terms = librarySearchText((params.get("q") || "").slice(0, 140)).split(/\s+/).filter(Boolean).slice(0, 8);
  const requested = Number(params.get("page"));
  const page = Number.isSafeInteger(requested) ? Math.max(1, Math.min(10000, requested)) : 1;
  const matches = terms.map(() => "AND instr(search_text, ?) > 0").join(" ");
  const rows = await list(db, `
    SELECT owner_key = '' AS sample, collection_id, position, collection_title, question
    FROM library_questions
    WHERE owner_key IN ('', ?) ${matches}
    ORDER BY sample DESC, updated_at DESC, collection_id, position
    LIMIT ? OFFSET ?
  `, owner, ...terms, libraryPageSize + 1, (page - 1) * libraryPageSize);
  return {
    page,
    hasNext: rows.length > libraryPageSize,
    questions: rows.slice(0, libraryPageSize).map(row => ({
      id: (row.sample ? "sample:" : "mine:") + row.collection_id + ":" + row.position,
      title: row.collection_title,
      question: JSON.parse(row.question)
    }))
  };
}

async function saveToLibrary(db, owner, input) {
  if (typeof input.id !== "string" || !/^custom-[a-z0-9-]{1,90}$/i.test(input.id)) {
    throw new ApiError(400, "Invalid question collection.");
  }
  const { quiz, images } = validateQuiz(input);
  const imagesByIndex = new Map(images.map(({ index, image }) => [index, image]));
  const now = Date.now();
  const replaceCollection = db.prepare("DELETE FROM library_questions WHERE owner_key = ? AND collection_id = ?")
    .bind(owner, input.id);
  const rows = quiz.questions.map((question, position) => {
    const [prompt, options, correct, explanation, seconds] = question;
    const data = [prompt, options, correct, explanation, seconds ?? 20, imagesByIndex.get(position) ?? null];
    const search = librarySearchText([quiz.title, prompt, ...options, explanation].join(" "));
    return db.prepare(`
      INSERT INTO library_questions (owner_key, collection_id, position, collection_title, question, search_text, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(owner, input.id, position, quiz.title, JSON.stringify(data), search, now);
  });
  await db.batch([replaceCollection, ...rows]);
  return { saved: rows.length };
}

async function route(request, db, path, receivedAt) {
  if (path === "/api/library" && (request.method === "GET" || request.method === "POST")) {
    const owner = await getKey(request);
    if (request.method === "POST") return saveToLibrary(db, owner, await readJson(request, maxRoomBytes));
    return searchLibrary(db, owner, new URL(request.url).searchParams);
  }
  if (path === "/api/health" && request.method === "GET") {
    await select(db, "SELECT code FROM rooms LIMIT 1");
    return { ok: true };
  }
  if (path === "/api/rooms" && request.method === "POST") {
    return createRoom(db, await getKey(request), await readJson(request, maxRoomBytes));
  }
  const match = /^\/api\/rooms\/([0-9]{6})(?:\/(join|advance|answer|image))?$/.exec(path);
  const method = match?.[2] && match[2] !== "image" ? "POST" : "GET";
  if (!match || request.method !== method) {
    throw new ApiError(404, "This room action is unavailable.");
  }
  const [, code, action] = match;
  const key = await getKey(request);
  const room = await select(db, "SELECT * FROM rooms WHERE code = ? AND expires_at > ?", code, receivedAt);
  if (!room) throw new ApiError(404, "That room code is invalid or has expired.");
  if (action === "join") return joinRoom(db, room, key, await readJson(request));

  const isHost = room.host_key === key;
  const player = isHost ? null : await select(db, "SELECT nickname FROM players WHERE room_code = ? AND player_key = ?", code, key);
  if (!isHost && !player) throw new ApiError(401, "Join this room with the code and a nickname first.");
  if (!action) return roomState(db, room, isHost ? "host" : "player", key, player?.nickname ?? null);
  if (action === "image") {
    const index = new URL(request.url).searchParams.get("index");
    if (index === String(room.question_index) && (room.phase === "question" || room.phase === "reveal")) {
      const asset = await select(db, "SELECT source FROM room_images WHERE room_code = ? AND question_index = ?", code, room.question_index);
      if (asset) return { image: asset.source };
    }
    throw new ApiError(404, "No image for this question.");
  }
  if (action === "advance" && isHost) return advanceRoom(db, room, await readJson(request));
  if (action === "answer" && player) return submitAnswer(db, room, key, await readJson(request), receivedAt);
  throw new ApiError(403, "Your role cannot perform that room action.");
}

export default {
  async fetch(request, env) {
    const receivedAt = Date.now();
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");
    const headers = new Headers({ "Cache-Control": "no-store", "Vary": "Origin" });
    if (origin && origin !== pagesOrigin && origin !== url.origin) {
      return Response.json({ error: "Open QuizPop to join a room." }, { status: 403, headers });
    }
    if (origin) headers.set("Access-Control-Allow-Origin", origin);
    if (request.method === "OPTIONS") {
      headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
      headers.set("Access-Control-Max-Age", "3600");
      return new Response(null, { status: 204, headers });
    }
    try {
      const body = await route(request, env.DB, url.pathname, receivedAt);
      return Response.json(body, { headers });
    } catch (error) {
      if (error instanceof ApiError) return Response.json({ error: error.message }, { status: error.status, headers });
      console.error(JSON.stringify({ message: "QuizPop room request failed", error: error.message }));
      return Response.json({ error: "The room service is temporarily unavailable. Try again." }, { status: 500, headers });
    }
  }
};
