import { createServer } from "node:http";
import { createReadStream, readdirSync, readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import worker from "./room-service/worker.mjs";

const database = new DatabaseSync(process.env.QUIZPOP_DB_PATH || ":memory:");
database.exec("PRAGMA foreign_keys = ON");
const migrations = new URL("./room-service/drizzle/", import.meta.url);
const migrationFiles = readdirSync(migrations).filter(name => name.endsWith(".sql")).sort();
const applied = database.prepare("PRAGMA user_version").get().user_version;
for (const [index, file] of migrationFiles.entries()) {
  if (index < applied) continue;
  database.exec("BEGIN");
  try {
    database.exec(readFileSync(new URL(file, migrations), "utf8"));
    database.exec(`PRAGMA user_version = ${index + 1}`);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
const DB = {
  prepare(sql) {
    const statement = database.prepare(sql);
    return {
      bind(...values) {
        return {
          first: () => statement.get(...values) ?? null,
          all: () => ({ results: statement.all(...values) }),
          run: () => ({ meta: statement.run(...values) })
        };
      }
    };
  },
  batch(statements) {
    database.exec("BEGIN");
    try {
      const results = statements.map(statement => statement.run());
      database.exec("COMMIT");
      return results;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
};

const port = Number(process.env.QUIZPOP_PORT ?? 4173);
const url = `http://127.0.0.1:${port}`;
const server = createServer(async (request, response) => {
  try {
    const target = new URL(request.url, url);
    if (target.pathname.startsWith("/api/")) {
      const hasBody = request.method !== "GET" && request.method !== "HEAD";
      const webRequest = new Request(target, {
        method: request.method,
        headers: request.headers,
        ...(hasBody ? { body: Readable.toWeb(request), duplex: "half" } : {})
      });
      const result = await worker.fetch(webRequest, { DB });
      response.writeHead(result.status, Object.fromEntries(result.headers));
      if (result.body) Readable.fromWeb(result.body).pipe(response);
      else response.end();
    } else if (target.pathname === "/" || target.pathname === "/index.html") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      createReadStream(new URL("./dist/index.html", import.meta.url)).pipe(response);
    } else {
      response.writeHead(404).end();
    }
  } catch (error) {
    console.error(error);
    response.writeHead(500).end();
  }
});
server.listen(port, "127.0.0.1", () => console.log(`QuizPop is running at ${url}`));
