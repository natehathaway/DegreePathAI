import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { createApp, createAssistant, createStore } from "../server.mjs";

let directory;
let server;
let baseUrl;
let store;
const assistantCalls = [];

async function register(name, email) {
  const response = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, email, password: "demo-password-123" }),
  });
  assert.equal(response.status, 201);
  const cookie = response.headers.get("set-cookie").split(";")[0];
  return { cookie, user: (await response.json()).user };
}

async function request(pathname, cookie, options = {}) {
  return fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...options.headers,
    },
  });
}

before(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "degreepath-test-"));
  store = createStore(path.join(directory, "degreepath.json"));
  await store.init();
  server = createApp({
    store,
    answerQuestion: async (call) => {
      assistantCalls.push(call);
      return `Answer for: ${call.question}`;
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(directory, { recursive: true, force: true });
});

test("course completion follows sample prerequisites and persists progress", async () => {
  const { cookie } = await register("Ada Demo", "ada@example.test");
  const blocked = await request("/api/courses", cookie, {
    method: "POST",
    body: JSON.stringify({ courseId: "CSE 201", completed: true }),
  });
  assert.equal(blocked.status, 409);

  for (const courseId of ["CSE 101", "CSE 102", "CSE 201"]) {
    const response = await request("/api/courses", cookie, {
      method: "POST",
      body: JSON.stringify({ courseId, completed: true }),
    });
    assert.equal(response.status, 200);
  }
  const dashboard = await request("/api/dashboard", cookie);
  const data = await dashboard.json();
  assert.equal(data.summary.completedCredits, 9);
  assert.equal(data.summary.totalCredits, 12);
  assert.equal(data.requirements.find((item) => item.id === "software").complete, true);
  assert.equal(data.requirements.find((item) => item.id === "software").completedCount, 2);
  const reloadedStore = createStore(path.join(directory, "degreepath.json"));
  await reloadedStore.init();
  assert.deepEqual(
    reloadedStore.read((database) => database.users.find((user) => user.email === "ada@example.test").completedCourseIds),
    ["CSE 101", "CSE 102", "CSE 201"],
  );
});

test("conversation messages are ordered, persist, and remain private to their owner", async () => {
  const owner = await register("Grace Demo", "grace@example.test");
  const other = await register("Lin Demo", "lin@example.test");
  const created = await request("/api/conversations", owner.cookie, {
    method: "POST",
    body: JSON.stringify({ question: "What sample course is next?" }),
  });
  assert.equal(created.status, 201);
  const conversation = (await created.json()).conversation;
  assert.deepEqual(conversation.messages.map((message) => message.role), ["user", "assistant"]);

  const added = await request(`/api/conversations/${conversation.id}/messages`, owner.cookie, {
    method: "POST",
    body: JSON.stringify({ question: "And after that?" }),
  });
  assert.equal(added.status, 200);
  const updated = (await added.json()).conversation;
  assert.deepEqual(updated.messages.map((message) => message.role), ["user", "assistant", "user", "assistant"]);
  assert.equal(assistantCalls.at(-1).question, "And after that?");
  assert.equal("messages" in assistantCalls.at(-1).context, false);
  const reopened = await request(`/api/conversations/${conversation.id}`, owner.cookie);
  assert.deepEqual((await reopened.json()).conversation.messages, updated.messages);

  const hidden = await request(`/api/conversations/${conversation.id}`, other.cookie);
  assert.equal(hidden.status, 404);
  const forbiddenDelete = await request(`/api/conversations/${conversation.id}`, other.cookie, { method: "DELETE" });
  assert.equal(forbiddenDelete.status, 404);
  const list = await request("/api/conversations", other.cookie);
  assert.deepEqual((await list.json()).conversations, []);
  const deleted = await request(`/api/conversations/${conversation.id}`, owner.cookie, { method: "DELETE" });
  assert.equal(deleted.status, 200);
  const reloadedStore = createStore(path.join(directory, "degreepath.json"));
  await reloadedStore.init();
  assert.equal(reloadedStore.read((database) => database.conversations.some((item) => item.id === conversation.id)), false);
});

test("new conversations pass only the current question and current structured context", async () => {
  const { cookie } = await register("Katherine Demo", "katherine@example.test");
  const response = await request("/api/conversations", cookie, {
    method: "POST",
    body: JSON.stringify({ question: "Start fresh" }),
  });
  assert.equal(response.status, 201);
  const call = assistantCalls.at(-1);
  assert.equal(call.question, "Start fresh");
  assert.equal(Array.isArray(call.context.courses), true);
  assert.equal(Array.isArray(call.context.requirements), true);
  assert.equal("messages" in call.context, false);
  assert.equal("email" in call.context, false);
});

test("unconfigured assistant labels its local response as a demo", async () => {
  const answer = createAssistant({ apiKey: "" });
  const response = await answer({
    question: "What is next?",
    context: {
      courses: [
        { id: "CSE 101", title: "Introduction to Computing", completed: false, prerequisites: [] },
      ],
      summary: { completedCredits: 0, totalCredits: 12 },
      completedCourseIds: [],
    },
  });
  assert.match(response, /Demo planning response \(AI is not configured\)/);
  assert.match(response, /CSE 101/);
});

test("sign-in restores the account session and sign-out revokes it", async () => {
  const account = await register("Margaret Demo", "margaret@example.test");
  const login = await request("/api/auth/login", null, {
    method: "POST",
    body: JSON.stringify({ email: " MARGARET@example.test ", password: "demo-password-123" }),
  });
  assert.equal(login.status, 200);
  const sessionCookie = login.headers.get("set-cookie").split(";")[0];
  const session = await request("/api/session", sessionCookie);
  assert.equal((await session.json()).user.id, account.user.id);

  const logout = await request("/api/auth/logout", sessionCookie, { method: "POST", body: "{}" });
  assert.equal(logout.status, 200);
  const revoked = await request("/api/dashboard", sessionCookie);
  assert.equal(revoked.status, 401);
});

test("serves the application and static browser assets", async () => {
  const [page, script, stylesheet] = await Promise.all([
    request("/", null),
    request("/app.js", null),
    request("/styles.css", null),
  ]);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /text\/html/);
  assert.match(await page.text(), /Fictional sample data/);
  assert.match(script.headers.get("content-type"), /javascript/);
  assert.match(stylesheet.headers.get("content-type"), /text\/css/);
});
