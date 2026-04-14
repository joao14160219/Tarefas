const TABLE_NAME = "task_checklist";

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

function normalizeTask(row) {
  const now = Date.now();
  const dueDate = row.due_date ? new Date(row.due_date).getTime() : null;
  const isCompleted = row.status === "completed";
  const isOverdue = !isCompleted && dueDate !== null && !Number.isNaN(dueDate) && dueDate < now;

  return {
    id: row.id,
    title: row.title || "",
    description: row.description || "",
    owner_name: row.owner_name || "",
    status: row.status || "pending",
    created_at: row.created_at || null,
    due_date: row.due_date || null,
    completed_at: row.completed_at || null,
    is_completed: isCompleted,
    is_overdue: isOverdue,
  };
}

function buildPayload(rows) {
  const tasks = rows.map(normalizeTask);
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

  return { summary, tasks, timeline };
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
    `${TABLE_NAME}?select=id,title,description,owner_name,status,created_at,due_date,completed_at&order=created_at.desc`
  );
  return Array.isArray(data) ? data : [];
}

async function createTask(body) {
  const title = String(body.title || "").trim();
  const ownerName = String(body.owner_name || "").trim();
  const description = String(body.description || "").trim();
  const dueDate = String(body.due_date || "").trim();

  if (!title || !ownerName || !dueDate) {
    const error = new Error("title, owner_name and due_date are required");
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
        owner_name: ownerName,
        description,
        due_date: parsedDueDate.toISOString(),
        status: "pending",
      },
    ]),
  });
}

async function updateTask(body) {
  const id = String(body.id || "").trim();
  const action = String(body.action || "").trim();

  if (!id || !action) {
    const error = new Error("id and action are required");
    error.status = 400;
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
    if (req.method === "GET") {
      const rows = await fetchTasks();
      return json(res, 200, buildPayload(rows));
    }

    if (req.method === "POST") {
      const body = await parseBody(req);
      await createTask(body);
      const rows = await fetchTasks();
      return json(res, 200, buildPayload(rows));
    }

    if (req.method === "PATCH") {
      const body = await parseBody(req);
      await updateTask(body);
      const rows = await fetchTasks();
      return json(res, 200, buildPayload(rows));
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

