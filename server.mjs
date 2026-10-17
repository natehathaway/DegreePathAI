import { createServer as createHttpServer } from "node:http";
import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const scrypt = promisify(scryptCallback);
const root = path.dirname(fileURLToPath(import.meta.url));
const cookieName = "degreepath_session";
const sessionLifetimeMs = 7 * 24 * 60 * 60 * 1000;
const requirements = [
  { id: "foundations", title: "Foundations (fictional)", courseIds: ["CSE 101", "MATH 101"] },
  { id: "software", title: "Software development (fictional)", courseIds: ["CSE 102", "CSE 201"] },
];
const courses = [
  { id: "CSE 101", title: "Introduction to Computing", credits: 3, requirementId: "foundations", prerequisites: [] },
  { id: "MATH 101", title: "Mathematical Foundations", credits: 3, requirementId: "foundations", prerequisites: [] },
  { id: "CSE 102", title: "Programming Fundamentals", credits: 3, requirementId: "software", prerequisites: ["CSE 101"] },
  { id: "CSE 201", title: "Software Design", credits: 3, requirementId: "software", prerequisites: ["CSE 102"] },
];

class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function emptyDatabase() {
  return { users: [], sessions: [], conversations: [] };
}

export function createStore(filePath = path.join(root, "data", "degreepath.json")) {
  let state;
  let queue = Promise.resolve();

  async function persist(nextState) {
    await mkdir(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(nextState, null, 2)}\n`, { flag: "wx" });
    await rename(temporaryPath, filePath);
  }

  return {
    async init() {
      await mkdir(path.dirname(filePath), { recursive: true });
      try {
        const contents = await readFile(filePath, "utf8");
        const parsed = JSON.parse(contents);
        if (!parsed || !Array.isArray(parsed.users) || !Array.isArray(parsed.sessions) || !Array.isArray(parsed.conversations)) {
          throw new Error("The database file has an invalid structure.");
        }
        state = parsed;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        state = emptyDatabase();
        await persist(state);
      }
    },
    read(selector) {
      if (!state) throw new Error("The database has not been initialized.");
      return selector(state);
    },
    mutate(mutator) {
      if (!state) throw new Error("The database has not been initialized.");
      const operation = queue.then(async () => {
        const nextState = structuredClone(state);
        const result = mutator(nextState);
        await persist(nextState);
        state = nextState;
        return result;
      });
      queue = operation.catch(() => {});
      return operation;
    },
  };
}

function safeUser(user) {
  return { id: user.id, name: user.name, email: user.email };
}

function cookieHeader(token, maxAge = sessionLifetimeMs / 1000) {
  return `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}

function sessionToken(request) {
  const cookie = request.headers.cookie ?? "";
  const pair = cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${cookieName}=`));
  return pair ? pair.slice(cookieName.length + 1) : null;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    let oversized = false;
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      if (oversized) return;
      body += chunk;
      if (Buffer.byteLength(body, "utf8") > 32_000) {
        oversized = true;
        body = "";
        reject(new AppError(413, "Request body is too large."));
      }
    });
    request.on("end", () => {
      if (oversized) return;
      try {
        const parsed = JSON.parse(body);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          reject(new AppError(400, "Request body must be a JSON object."));
          return;
        }
        resolve(parsed);
      } catch {
        reject(new AppError(400, "Request body must be valid JSON."));
      }
    });
    request.on("error", reject);
  });
}

function sendJson(response, status, value, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  response.end(JSON.stringify(value));
}

function dashboardFor(user) {
  const completed = new Set(user.completedCourseIds);
  const courseList = courses.map((course) => ({
    ...course,
    completed: completed.has(course.id),
    canComplete: course.prerequisites.every((id) => completed.has(id)),
  }));
  const requirementList = requirements.map((requirement) => {
    const completeCount = requirement.courseIds.filter((id) => completed.has(id)).length;
    return {
      ...requirement,
      completedCount: completeCount,
      totalCount: requirement.courseIds.length,
      complete: completeCount === requirement.courseIds.length,
    };
  });
  const completedCredits = courseList.filter((course) => course.completed).reduce((total, course) => total + course.credits, 0);
  const totalCredits = courses.reduce((total, course) => total + course.credits, 0);
  return {
    courses: courseList,
    requirements: requirementList,
    summary: {
      completedCredits,
      totalCredits,
      progressPercent: Math.round((completedCredits / totalCredits) * 100),
    },
    dataNotice: "Fictional sample data only — not BYU–Idaho catalog or advising information.",
  };
}

function localAnswer(question, context) {
  const remaining = context.courses.filter((course) => !course.completed);
  const nextAvailable = remaining.find((course) => course.prerequisites.every((id) => context.completedCourseIds.includes(id)));
  const progress = `${context.summary.completedCredits} of ${context.summary.totalCredits} fictional sample credits`;
  const nextStep = nextAvailable
    ? ` The next sample course without an unmet prerequisite is ${nextAvailable.id}: ${nextAvailable.title}.`
    : " All courses in this fictional sample set are complete.";
  return `Demo planning response (AI is not configured): You have completed ${progress}.${nextStep} This is based only on the prototype's fictional data and is not official BYU–Idaho advice.`;
}

export function createAssistant({ apiKey = process.env.AI_API_KEY, baseUrl = process.env.AI_BASE_URL, model = process.env.AI_MODEL } = {}) {
  return async ({ question, context }) => {
    if (!apiKey) return localAnswer(question, context);
    let response;
    try {
      response = await fetch(baseUrl || "https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({
          model: model || "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content: "You explain degree-planning possibilities using only the supplied structured context. It is fictional, unverified sample data, not official BYU–Idaho requirements. Do not invent requirements, change prerequisite or progress calculations, or imply academic approval. Clearly identify the sample-data limitation. The current question and context are the only information available; do not assume prior conversation.",
            },
            { role: "user", content: JSON.stringify({ question, degreeContext: context }) },
          ],
        }),
      });
    } catch {
      throw new AppError(502, "The configured AI provider could not be reached. Check server configuration and try again.");
    }
    if (!response.ok) {
      throw new AppError(502, "The configured AI provider returned an error. Check server configuration and try again.");
    }
    let result;
    try {
      result = await response.json();
    } catch {
      throw new AppError(502, "The configured AI provider returned an invalid response.");
    }
    const answer = result.choices?.[0]?.message?.content;
    if (typeof answer !== "string" || !answer.trim()) {
      throw new AppError(502, "The configured AI provider did not return an answer.");
    }
    return answer.trim();
  };
}

function conversationPreview(conversation) {
  const lastMessage = conversation.messages.at(-1);
  return {
    id: conversation.id,
    title: conversation.title,
    updatedAt: conversation.updatedAt,
    preview: lastMessage?.content ?? "",
  };
}

function validateQuestion(value) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 2_000) {
    throw new AppError(400, "Enter a question of 1 to 2,000 characters.");
  }
  return value.trim();
}

export function createApp({ store = createStore(), answerQuestion = createAssistant() } = {}) {
  const server = createHttpServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);
      const pathname = requestUrl.pathname;

      if (request.headers.origin) {
        const origin = new URL(request.headers.origin);
        if (origin.host !== request.headers.host) throw new AppError(403, "Cross-origin requests are not allowed.");
      }

      if (request.method === "GET" && pathname === "/") {
        const html = await readFile(path.join(root, "public", "index.html"));
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "X-Content-Type-Options": "nosniff" });
        response.end(html);
        return;
      }
      if (request.method === "GET" && (pathname === "/app.js" || pathname === "/styles.css")) {
        const contentType = pathname.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8";
        const file = await readFile(path.join(root, "public", pathname.slice(1)));
        response.writeHead(200, { "Content-Type": contentType, "X-Content-Type-Options": "nosniff" });
        response.end(file);
        return;
      }

      if (request.method === "POST" && (pathname === "/api/auth/register" || pathname === "/api/auth/login")) {
        const body = await readBody(request);
        const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
        const password = typeof body.password === "string" ? body.password : "";
        if (pathname.endsWith("register")) {
          const name = typeof body.name === "string" ? body.name.trim() : "";
          if (name.length < 2 || name.length > 60 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 8 || password.length > 256) {
            throw new AppError(400, "Use a name of 2–60 characters, a valid email, and a password of 8–256 characters.");
          }
          const salt = randomBytes(16);
          const passwordHash = await scrypt(password, salt, 64);
          const token = randomBytes(32).toString("base64url");
          const user = await store.mutate((database) => {
            if (database.users.some((record) => record.email === email)) throw new AppError(409, "An account with that email already exists.");
            const newUser = { id: randomUUID(), name, email, salt: salt.toString("hex"), passwordHash: passwordHash.toString("hex"), completedCourseIds: [] };
            database.users.push(newUser);
            database.sessions.push({ token, userId: newUser.id, expiresAt: Date.now() + sessionLifetimeMs });
            return safeUser(newUser);
          });
          sendJson(response, 201, { user }, { "Set-Cookie": cookieHeader(token) });
          return;
        }
        const userRecord = store.read((database) => database.users.find((record) => record.email === email));
        if (!userRecord) throw new AppError(401, "Email or password is incorrect.");
        const candidate = await scrypt(password, Buffer.from(userRecord.salt, "hex"), 64);
        if (!timingSafeEqual(candidate, Buffer.from(userRecord.passwordHash, "hex"))) {
          throw new AppError(401, "Email or password is incorrect.");
        }
        const token = randomBytes(32).toString("base64url");
        await store.mutate((database) => {
          database.sessions.push({ token, userId: userRecord.id, expiresAt: Date.now() + sessionLifetimeMs });
        });
        sendJson(response, 200, { user: safeUser(userRecord) }, { "Set-Cookie": cookieHeader(token) });
        return;
      }

      if (pathname.startsWith("/api/")) {
        const token = sessionToken(request);
        const session = token ? store.read((database) => database.sessions.find((record) => record.token === token && record.expiresAt > Date.now())) : null;
        const user = session ? store.read((database) => database.users.find((record) => record.id === session.userId)) : null;
        if (pathname === "/api/session" && request.method === "GET") {
          sendJson(response, 200, { user: user ? safeUser(user) : null });
          return;
        }
        if (!user) throw new AppError(401, "Sign in to continue.");

        if (pathname === "/api/auth/logout" && request.method === "POST") {
          if (token) await store.mutate((database) => {
            database.sessions = database.sessions.filter((record) => record.token !== token);
          });
          sendJson(response, 200, { ok: true }, { "Set-Cookie": cookieHeader("", 0) });
          return;
        }
        if (pathname === "/api/dashboard" && request.method === "GET") {
          sendJson(response, 200, { user: safeUser(user), ...dashboardFor(user) });
          return;
        }
        if (pathname === "/api/courses" && request.method === "POST") {
          const body = await readBody(request);
          const course = courses.find((item) => item.id === body.courseId);
          if (!course || typeof body.completed !== "boolean") throw new AppError(400, "Choose a valid course and completion status.");
          await store.mutate((database) => {
            const currentUser = database.users.find((record) => record.id === user.id);
            const completed = new Set(currentUser.completedCourseIds);
            if (body.completed) {
              if (!course.prerequisites.every((id) => completed.has(id))) throw new AppError(409, "Complete the sample prerequisites first.");
              completed.add(course.id);
            } else {
              const dependent = courses.find((item) => completed.has(item.id) && item.prerequisites.includes(course.id));
              if (dependent) throw new AppError(409, `Complete or remove ${dependent.id} before unmarking this prerequisite.`);
              completed.delete(course.id);
            }
            currentUser.completedCourseIds = [...completed];
          });
          const currentUser = store.read((database) => database.users.find((record) => record.id === user.id));
          sendJson(response, 200, dashboardFor(currentUser));
          return;
        }
        if (pathname === "/api/conversations" && request.method === "GET") {
          const list = store.read((database) => database.conversations
            .filter((conversation) => conversation.userId === user.id)
            .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
            .map(conversationPreview));
          sendJson(response, 200, { conversations: list });
          return;
        }
        if (pathname === "/api/conversations" && request.method === "POST") {
          const body = await readBody(request);
          const question = validateQuestion(body.question);
          const context = { ...dashboardFor(user), completedCourseIds: [...user.completedCourseIds] };
          const answer = await answerQuestion({ question, context });
          const now = new Date().toISOString();
          const conversation = {
            id: randomUUID(),
            userId: user.id,
            title: question.slice(0, 72),
            createdAt: now,
            updatedAt: now,
            messages: [
              { id: randomUUID(), role: "user", content: question, createdAt: now },
              { id: randomUUID(), role: "assistant", content: answer, createdAt: new Date().toISOString() },
            ],
          };
          await store.mutate((database) => database.conversations.push(conversation));
          sendJson(response, 201, { conversation });
          return;
        }
        const conversationMatch = pathname.match(/^\/api\/conversations\/([0-9a-f-]+)(?:\/messages)?$/i);
        if (conversationMatch) {
          const conversationId = conversationMatch[1];
          const isMessagesRoute = pathname.endsWith("/messages");
          const ownedConversation = store.read((database) => database.conversations.find((item) => item.id === conversationId && item.userId === user.id));
          if (!ownedConversation) throw new AppError(404, "Conversation not found.");
          if (request.method === "GET" && !isMessagesRoute) {
            sendJson(response, 200, { conversation: ownedConversation });
            return;
          }
          if (request.method === "DELETE" && !isMessagesRoute) {
            await store.mutate((database) => {
              database.conversations = database.conversations.filter((item) => !(item.id === conversationId && item.userId === user.id));
            });
            sendJson(response, 200, { ok: true });
            return;
          }
          if (request.method === "POST" && isMessagesRoute) {
            const body = await readBody(request);
            const question = validateQuestion(body.question);
            const currentUser = store.read((database) => database.users.find((record) => record.id === user.id));
            const context = { ...dashboardFor(currentUser), completedCourseIds: [...currentUser.completedCourseIds] };
            const answer = await answerQuestion({ question, context });
            const userMessage = { id: randomUUID(), role: "user", content: question, createdAt: new Date().toISOString() };
            const assistantMessage = { id: randomUUID(), role: "assistant", content: answer, createdAt: new Date().toISOString() };
            const updated = await store.mutate((database) => {
              const conversation = database.conversations.find((item) => item.id === conversationId && item.userId === user.id);
              if (!conversation) throw new AppError(404, "Conversation not found.");
              conversation.messages.push(userMessage, assistantMessage);
              conversation.updatedAt = assistantMessage.createdAt;
              return conversation;
            });
            sendJson(response, 200, { conversation: updated });
            return;
          }
        }
      }
      sendJson(response, 404, { error: "Not found." });
    } catch (error) {
      if (response.headersSent || response.destroyed) return;
      if (error instanceof AppError) {
        sendJson(response, error.status, { error: error.message });
        return;
      }
      console.error(error);
      sendJson(response, 500, { error: "An unexpected server error occurred." });
    }
  });
  return server;
}

async function start() {
  const store = createStore();
  await store.init();
  const server = createApp({ store });
  const port = Number(process.env.PORT || 3000);
  server.listen(port, "127.0.0.1", () => console.log(`DegreePath AI is running at http://localhost:${port}`));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  start().catch((error) => {
    console.error("Unable to start DegreePath AI:", error);
    process.exitCode = 1;
  });
}
