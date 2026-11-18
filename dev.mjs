import { createServer } from "node:http";
import { createReadStream, readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import worker from "./room-service/worker.mjs";

const database = new DatabaseSync(":memory:");
database.exec("PRAGMA foreign_keys = ON");
database.exec(readFileSync(new URL("./room-service/drizzle/0000_rooms.sql", import.meta.url), "utf8"));
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
