const crypto = require("crypto");

const TABLE_NAME = "task_checklist";
const SESSION_COOKIE = "jofa_session";

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";

    req.on("data", (chunk) => {
      raw += chunk;
    });

    req.on("end", () => {
      if (!raw) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });

    req.on("error", reject);
  });
}

function parseCookies(req) {
  const cookieHeader = req.headers.cookie || "";
  return cookieHeader.split(";").reduce((acc, part) => {
    const trimmed = part.trim();
    if (!trimmed) return acc;
    const separator = trimmed.indexOf("=");
    const key = separator >= 0 ? trimmed.slice(0, separator) : trimmed;
    const value = separator >= 0 ? trimmed.slice(separator + 1) : "";
    acc[key] = decodeURIComponent(value);
    return acc;
  }, {});
}

function base64UrlDecode(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Buffer.from(padded, "base64").toString("utf8");
}

function readSession(req) {
  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret) {
    const error = new Error("Missing SESSION_SECRET in Vercel environment variables");
    error.status = 500;
    throw error;
  }

  const cookies = parseCookies(req);
  const raw = cookies[SESSION_COOKIE];
  if (!raw) return null;

  const [encodedPayload, signature] = raw.split(".");
  if (!encodedPayload || !signature) return null;

  const expectedSignature = crypto
    .createHmac("sha256", sessionSecret)
    .update(encodedPayload)
    .digest("base64url");

  if (signature.length !== expectedSignature.length) {
    return null;
  }

  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
    return null;
  }

  try {
    const payload = JSON.parse(base64UrlDecode(encodedPayload));
    if (!payload?.key || !payload?.name) return null;
    return payload;
  } catch {
    return null;
  }
}

function normalizeTask(row, session) {
  const now = Date.now();
  const dueDate = row.due_date ? new Date(row.due_date).getTime() : null;
  const isCompleted = row.status === "completed";
  const isOverdue = !isCompleted && dueDate !== null && !Number.isNaN(dueDate) && dueDate < now;
  const canEdit = session ? row.creator_user_key === session.key : false;
  const canToggleComplete = session
    ? row.creator_user_key === session.key || row.owner_user_key === session.key
    : false;

  return {
    id: row.id,
    title: row.title || "",
    description: row.description || "",
    owner_name: row.owner_name || "",
    owner_user_key: row.owner_user_key || "",
    creator_name: row.creator_name || row.owner_name || "",
    creator_user_key: row.creator_user_key || row.owner_user_key || "",
    status: row.status || "pending",
    created_at: row.created_at || null,
    due_date: row.due_date || null,
    completed_at: row.completed_at || null,
    is_completed: isCompleted,
    is_overdue: isOverdue,
    can_edit: canEdit,
    can_toggle_complete: canToggleComplete,
  };
}

function buildPayload(rows, session) {
  const tasks = rows.map((row) => normalizeTask(row, session));
  const summary = tasks.reduce((acc, task) => {
    acc.total += 1;
    if (task.is_completed) {
      acc.completed += 1;
    } else if (task.is_overdue) {
      acc.overdue += 1;
    } else {
      acc.pending += 1;
    }
    return acc;
  }, { total: 0, pending: 0, overdue: 0, completed: 0 });

  const timeline = tasks
    .flatMap((task) => {
      const items = [
        {
          created_at: task.created_at,
          title: `Tarefa criada: ${task.title}`,
          description: `${task.owner_name || "Sem responsavel"} | prazo ${formatTimelineDate(task.due_date)} | criada em ${formatTimelineDate(task.created_at)}`,
        },
      ];

      if (task.completed_at) {
        items.push({
          created_at: task.completed_at,
          title: `Tarefa concluida: ${task.title}`,
          description: `${task.owner_name || "Sem responsavel"} | concluida em ${formatTimelineDate(task.completed_at)}`,
        });
      }

      return items;
    })
    .filter((item) => item.created_at)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, 10);

  return {
    summary,
    tasks,
    timeline,
    currentUser: session ? { key: session.key, name: session.name } : null,
  };
}

function formatTimelineDate(value) {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Sao_Paulo",
  }).format(date);
}

function getEnv() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    return {
      error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in Vercel environment variables",
    };
  }

  return { supabaseUrl, serviceRoleKey };
}

async function supabaseRequest(path, options = {}) {
  const env = getEnv();
  if (env.error) {
    throw new Error(env.error);
  }

  const headers = {
    apikey: env.serviceRoleKey,
    Authorization: `Bearer ${env.serviceRoleKey}`,
    ...options.headers,
  };

  const response = await fetch(`${env.supabaseUrl}/rest/v1/${path}`, {
    ...options,
    headers,
  });

  const text = await response.text();
  let data;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    const error = new Error("Supabase request failed");
    error.details = data;
    error.status = response.status;
    throw error;
  }

  return data;
}

async function fetchTasks() {
  const data = await supabaseRequest(
    `${TABLE_NAME}?select=id,title,description,owner_name,owner_user_key,creator_name,creator_user_key,status,created_at,due_date,completed_at&order=created_at.desc`
  );
  return Array.isArray(data) ? data : [];
}

async function fetchTaskById(id) {
  const data = await supabaseRequest(
    `${TABLE_NAME}?select=id,owner_user_key,creator_user_key&id=eq.${encodeURIComponent(id)}`
  );
  return Array.isArray(data) ? data[0] || null : null;
}

async function createTask(body, session) {
  const title = String(body.title || "").trim();
  const description = String(body.description || "").trim();
  const dueDate = String(body.due_date || "").trim();
  const assignedUserKey = String(body.owner_user_key || "").trim();
  const assignedName = String(body.owner_name || "").trim();

  if (!title || !dueDate || !assignedUserKey || !assignedName) {
    const error = new Error("title, due_date, owner_user_key and owner_name are required");
    error.status = 400;
    throw error;
  }

  const parsedDueDate = new Date(dueDate);
  if (Number.isNaN(parsedDueDate.getTime())) {
    const error = new Error("Invalid due_date");
    error.status = 400;
    throw error;
  }

  await supabaseRequest(TABLE_NAME, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify([
      {
        title,
        owner_name: assignedName,
        owner_user_key: assignedUserKey,
        creator_name: session.name,
        creator_user_key: session.key,
        description,
        due_date: parsedDueDate.toISOString(),
        status: "pending",
      },
    ]),
  });
}

async function updateTask(body, session) {
  const id = String(body.id || "").trim();
  const action = String(body.action || "").trim();

  if (!id || !action) {
    const error = new Error("id and action are required");
    error.status = 400;
    throw error;
  }

  const task = await fetchTaskById(id);
  if (!task) {
    const error = new Error("Task not found");
    error.status = 404;
    throw error;
  }

  if (action === "complete" || action === "reopen") {
    const canToggle = task.creator_user_key === session.key || task.owner_user_key === session.key;
    if (!canToggle) {
      const error = new Error("Voce so pode alterar o status de tarefas suas ou designadas para voce");
      error.status = 403;
      throw error;
    }
  } else if (task.creator_user_key !== session.key) {
    const error = new Error("Voce so pode editar as tarefas que criou");
    error.status = 403;
    throw error;
  }

  let patch;
  if (action === "complete") {
    patch = {
      status: "completed",
      completed_at: new Date().toISOString(),
    };
  } else if (action === "reopen") {
    patch = {
      status: "pending",
      completed_at: null,
    };
  } else if (action === "edit") {
    const title = String(body.title || "").trim();
    const description = String(body.description || "").trim();
    const dueDate = String(body.due_date || "").trim();

    if (!title || !dueDate) {
      const error = new Error("title and due_date are required");
      error.status = 400;
      throw error;
    }

    const parsedDueDate = new Date(dueDate);
    if (Number.isNaN(parsedDueDate.getTime())) {
      const error = new Error("Invalid due_date");
      error.status = 400;
      throw error;
    }

    patch = {
      title,
      description,
      due_date: parsedDueDate.toISOString(),
    };
  } else {
    const error = new Error("Unsupported action");
    error.status = 400;
    throw error;
  }

  await supabaseRequest(`${TABLE_NAME}?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(patch),
  });
}

module.exports = async (req, res) => {
  try {
    const session = readSession(req);

    if (!session) {
      return json(res, 401, { error: "Sessao expirada. Faca login novamente." });
    }

    if (req.method === "GET") {
      const rows = await fetchTasks();
      return json(res, 200, buildPayload(rows, session));
    }

    if (req.method === "POST") {
      const body = await parseBody(req);
      await createTask(body, session);
      const rows = await fetchTasks();
      return json(res, 200, buildPayload(rows, session));
    }

    if (req.method === "PATCH") {
      const body = await parseBody(req);
      await updateTask(body, session);
      const rows = await fetchTasks();
      return json(res, 200, buildPayload(rows, session));
    }

    res.setHeader("Allow", "GET, POST, PATCH");
    return json(res, 405, { error: "Method not allowed" });
  } catch (error) {
    return json(res, error.status || error.details?.status || 500, {
      error: error.message || "Unexpected API error",
      details: error.details || null,
    });
  }
};
