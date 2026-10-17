const authPanel = document.querySelector("#auth-panel");
const appPanel = document.querySelector("#app-panel");
const authForm = document.querySelector("#auth-form");
const authTitle = document.querySelector("#auth-title");
const authSubmit = document.querySelector("#auth-submit");
const authSwitch = document.querySelector("#auth-switch");
const nameField = document.querySelector("#name-field");
const notice = document.querySelector("#notice");
const logoutButton = document.querySelector("#logout-button");
const accountName = document.querySelector("#account-name");
const requirementsList = document.querySelector("#requirements-list");
const coursesList = document.querySelector("#courses-list");
const summaryCard = document.querySelector("#summary-card");
const conversationList = document.querySelector("#conversation-list");
const messagesList = document.querySelector("#messages-list");
const questionForm = document.querySelector("#question-form");
const questionInput = document.querySelector("#question-input");
const chatEmpty = document.querySelector("#chat-empty");
const sendButton = document.querySelector("#send-button");
let authMode = "register";
let activeConversationId = null;

function element(tagName, className, text) {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function showNotice(message) {
  notice.textContent = message;
  notice.classList.remove("hidden");
  window.clearTimeout(showNotice.timeout);
  showNotice.timeout = window.setTimeout(() => notice.classList.add("hidden"), 6000);
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "The request failed.");
  return result;
}

function showAuth(mode = "register") {
  authMode = mode;
  authPanel.classList.remove("hidden");
  appPanel.classList.add("hidden");
  logoutButton.classList.add("hidden");
  accountName.textContent = "";
  nameField.classList.toggle("hidden", mode === "login");
  authForm.elements.name.required = mode === "register";
  authForm.elements.password.autocomplete = mode === "register" ? "new-password" : "current-password";
  authTitle.textContent = mode === "register" ? "Create your demo account" : "Welcome back";
  authSubmit.textContent = mode === "register" ? "Create account" : "Sign in";
  authSwitch.textContent = mode === "register" ? "Already have an account? Sign in" : "New here? Create an account";
}

async function loadDashboard() {
  const data = await api("/api/dashboard");
  accountName.textContent = data.user.name;
  summaryCard.replaceChildren();
  summaryCard.append(element("span", "", `${data.summary.progressPercent}%`));
  summaryCard.append(document.createTextNode(` · ${data.summary.completedCredits}/${data.summary.totalCredits} sample credits`));

  requirementsList.replaceChildren(...data.requirements.map((requirement) => {
    const card = element("div", "requirement-card");
    const top = element("div", "requirement-top");
    top.append(element("span", "requirement-name", requirement.title));
    top.append(element("span", "requirement-count", `${requirement.completedCount}/${requirement.totalCount}`));
    const track = element("div", "progress-track");
    const fill = element("div", "progress-fill");
    fill.style.width = `${Math.round((requirement.completedCount / requirement.totalCount) * 100)}%`;
    track.append(fill);
    card.append(top, track);
    return card;
  }));

  coursesList.replaceChildren(...data.courses.map((course) => {
    const card = element("article", "course-card");
    const titleRow = element("div", "course-title-row");
    const title = element("div");
    title.append(element("span", "course-id", course.id), element("span", "course-title", course.title));
    titleRow.append(title);
    const meta = element("div", "course-meta", `${course.credits} fictional credits · ${course.prerequisites.length ? `Prerequisites: ${course.prerequisites.join(", ")}` : "No sample prerequisites"} · ${course.requirementId}`);
    const action = element("button", "button course-action", course.completed ? "Mark incomplete" : "Mark complete");
    action.classList.add(course.completed ? "button-secondary" : "button-primary");
    action.type = "button";
    action.disabled = !course.completed && !course.canComplete;
    action.title = action.disabled ? "Complete sample prerequisites first." : "";
    action.addEventListener("click", async () => {
      action.disabled = true;
      try {
        await api("/api/courses", {
          method: "POST",
          body: JSON.stringify({ courseId: course.id, completed: !course.completed }),
        });
        await loadDashboard();
      } catch (error) {
        showNotice(error.message);
      }
    });
    card.append(titleRow, meta, action);
    return card;
  }));
}

function renderConversationList(conversations) {
  conversationList.replaceChildren();
  for (const conversation of conversations) {
    const item = element("div", `conversation-item${conversation.id === activeConversationId ? " active" : ""}`);
    const open = element("button", "conversation-title", conversation.title);
    open.type = "button";
    open.title = conversation.title;
    open.addEventListener("click", () => openConversation(conversation.id));
    const preview = element("span", "conversation-preview", conversation.preview);
    const remove = element("button", "delete-chat", "Delete conversation");
    remove.type = "button";
    remove.addEventListener("click", async () => {
      try {
        await api(`/api/conversations/${conversation.id}`, { method: "DELETE" });
        if (activeConversationId === conversation.id) {
          activeConversationId = null;
          renderMessages(null);
        }
        await refreshConversations();
      } catch (error) {
        showNotice(error.message);
      }
    });
    item.append(open, preview, remove);
    conversationList.append(item);
  }
}

function renderMessages(conversation) {
  messagesList.replaceChildren();
  const hasConversation = Boolean(conversation);
  chatEmpty.classList.toggle("hidden", hasConversation);
  questionForm.classList.toggle("hidden", !hasConversation && activeConversationId !== null);
  if (!hasConversation) {
    questionForm.classList.toggle("hidden", activeConversationId === null);
    return;
  }
  questionForm.classList.remove("hidden");
  for (const message of conversation.messages) {
    const bubble = element("div", `message message-${message.role}`);
    bubble.append(element("span", "message-role", message.role === "user" ? "You" : "DegreePath demo"));
    bubble.append(document.createTextNode(message.content));
    messagesList.append(bubble);
  }
  messagesList.scrollTop = messagesList.scrollHeight;
}

async function refreshConversations() {
  const result = await api("/api/conversations");
  renderConversationList(result.conversations);
}

async function openConversation(id) {
  try {
    const result = await api(`/api/conversations/${id}`);
    activeConversationId = id;
    renderMessages(result.conversation);
    await refreshConversations();
  } catch (error) {
    showNotice(error.message);
  }
}

async function loadApp() {
  authPanel.classList.add("hidden");
  appPanel.classList.remove("hidden");
  logoutButton.classList.remove("hidden");
  activeConversationId = null;
  questionForm.classList.add("hidden");
  renderMessages(null);
  await Promise.all([loadDashboard(), refreshConversations()]);
}

authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const values = new FormData(authForm);
  const body = {
    name: values.get("name"),
    email: values.get("email"),
    password: values.get("password"),
  };
  authSubmit.disabled = true;
  try {
    await api(`/api/auth/${authMode}`, { method: "POST", body: JSON.stringify(body) });
    authForm.reset();
    await loadApp();
  } catch (error) {
    showNotice(error.message);
  } finally {
    authSubmit.disabled = false;
  }
});

authSwitch.addEventListener("click", () => showAuth(authMode === "register" ? "login" : "register"));

logoutButton.addEventListener("click", async () => {
  try {
    await api("/api/auth/logout", { method: "POST", body: "{}" });
    showAuth("login");
  } catch (error) {
    showNotice(error.message);
  }
});

document.querySelector("#new-chat-button").addEventListener("click", () => {
  activeConversationId = null;
  renderMessages(null);
  questionForm.classList.remove("hidden");
  chatEmpty.classList.add("hidden");
  questionInput.focus();
  renderConversationListFromCurrent();
});

function renderConversationListFromCurrent() {
  refreshConversations().catch((error) => showNotice(error.message));
}

questionForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const question = questionInput.value.trim();
  if (!question) return;
  sendButton.disabled = true;
  try {
    const url = activeConversationId
      ? `/api/conversations/${activeConversationId}/messages`
      : "/api/conversations";
    const result = await api(url, { method: "POST", body: JSON.stringify({ question }) });
    activeConversationId = result.conversation.id;
    questionInput.value = "";
    renderMessages(result.conversation);
    await refreshConversations();
  } catch (error) {
    showNotice(error.message);
  } finally {
    sendButton.disabled = false;
  }
});

async function initialize() {
  try {
    const session = await api("/api/session");
    if (session.user) await loadApp();
    else showAuth();
  } catch (error) {
    showAuth();
    showNotice(error.message);
  }
}

initialize();
