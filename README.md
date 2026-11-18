# QuizPop

Host a live quiz, join by room code, or play a practice round on your own.

## Run locally

With Node.js 24 installed, run `node dev.mjs` from this directory and open [QuizPop on localhost](http://127.0.0.1:4173/). The local server uses an in-memory database and resets rooms when it restarts. You can also open `dist/index.html` directly for solo quizzes and the quiz builder.

1. In one tab, choose **Host a quiz**, select a quiz, and create a room.
2. In a second tab, choose **Join a quiz** and enter the six-digit code and a nickname.
3. In the host tab, start the quiz. Each reveal shows the response counts and the host can see individual choices. **Next: leaderboard** shows the five highest-scoring participants and rank changes from the previous question.

Set a time limit of 5 to 300 seconds on any question in the quiz builder. Before hosting, use **Set time by question** to review or change the limits for that room, including for the sample quizzes. Blank limits use the room default in live play or 15 seconds in timed solo play.

Use **Question image (optional)** to attach a JPG, PNG, or WebP file up to 12 MB. QuizPop resizes the image for play and saves it with the question. The host and participants see the image during the question.

Players can join while the lobby is open. A room supports up to 60 participants and its code expires after four hours. Use **Resume room** in the same tab after a refresh.

## Deployment

GitHub Pages serves the static files in `dist/`. A separate Cloudflare Worker with a D1 database runs the room API. The GitHub Pages origin is allowed in `room-service/worker.mjs`, and the API URL is set in the `quizpop-room-api` meta tag in `dist/index.html`.

To deploy the room service, apply the SQL migration in `room-service/drizzle/` to D1, bind the database as `DB`, and deploy `room-service/worker.mjs`. Run `node room-service/build.mjs` to produce the Worker entrypoint used by Sites.

Custom quizzes are saved in the browser. When one is hosted, the room service stores a copy for that session. Players join with a nickname and room code.
