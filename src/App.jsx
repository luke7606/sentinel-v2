import { useState, useRef, useEffect, useCallback } from "react";
import { createClient } from "@supabase/supabase-js";

// ════════════════════════════════════════════════════════════════════════════
// SENTINEL — CAPA DE DATOS (Supabase)
// ════════════════════════════════════════════════════════════════════════════
// Para conectar a Supabase necesitás estas variables en .env.local y Vercel:
//   VITE_SUPABASE_URL=https://xxxx.supabase.co
//   VITE_SUPABASE_ANON_KEY=eyJhbG...
//
// Tablas requeridas en Supabase (ver sentinel_supabase_setup.sql):
//   - projects       → proyectos con sus datos
//   - documents      → docs/archivos subidos a cada proyecto
//   - chat_sessions  → historial de chat por usuario+proyecto (PRIVADO)
//   - config         → configuraciones globales (tokens, etc)
// ════════════════════════════════════════════════════════════════════════════
const SUPABASE_URL  = import.meta.env.VITE_SUPABASE_URL  || "";
const SUPABASE_ANON = import.meta.env.VITE_SUPABASE_ANON_KEY || "";
const sb = (SUPABASE_URL && SUPABASE_ANON) ? createClient(SUPABASE_URL, SUPABASE_ANON) : null;
// -- LOCAL STORAGE PERSISTENCE --
const DB_ENABLED = true;
const LS_PROJECTS = "sentinel_projects";
const LS_CONFIG   = "sentinel_config";

// ════════════════════════════════════════════════════════════════════════════
// FUNCIONES DE BASE DE DATOS
// Estas funciones conectan Sentinel con Supabase.
// Si Supabase no está configurado, usan localStorage como fallback.
// ════════════════════════════════════════════════════════════════════════════

async function dbLoad() {
  // Carga todos los proyectos con sus documentos
  if (!sb) {
    try { const raw = localStorage.getItem(LS_PROJECTS); return raw ? JSON.parse(raw) : null; } catch { return null; }
  }
  try {
    const { data, error } = await sb.from("projects").select("*, documents(*)");
    if (error || !data?.length) return null;
    const result = {};
    for (const p of data) {
      result[p.id] = { ...p, docs: p.documents || [], startDate: p.start_date, dueDate: p.due_date };
    }
    return result;
  } catch { return null; }
}
async function dbSaveProject(proj) {
  // Guarda un proyecto en Supabase (o localStorage como fallback)
  if (!sb) {
    try { const all = JSON.parse(localStorage.getItem(LS_PROJECTS)||"{}"); all[proj.id] = proj; localStorage.setItem(LS_PROJECTS, JSON.stringify(all)); } catch(e) { console.error(e); }
    return;
  }
  try {
    const { docs, documents, isDemo, ...data } = proj;
    await sb.from("projects").upsert({
      id: data.id, name: data.name, client: data.client, type: data.type,
      status: data.status, health: data.health, budget: data.budget, spent: data.spent,
      start_date: data.startDate, due_date: data.dueDate, color: data.color,
      milestones: data.milestones, team: data.team, tickets: data.tickets, activity: data.activity,
    });
  } catch(e) { console.error("dbSaveProject error", e); }
}
async function dbDeleteProject(id) {
  // Elimina un proyecto de Supabase (o localStorage como fallback)
  if (!sb) {
    try { const all = JSON.parse(localStorage.getItem(LS_PROJECTS)||"{}"); delete all[id]; localStorage.setItem(LS_PROJECTS, JSON.stringify(all)); } catch(e) { console.error(e); }
    return;
  }
  try { await sb.from("projects").delete().eq("id", id); } catch(e) { console.error("dbDeleteProject error", e); }
}
async function dbSaveDoc(doc, projectId) {
  // Guarda un documento vinculado a un proyecto
  if (!sb) {
    try { const all = JSON.parse(localStorage.getItem(LS_PROJECTS)||"{}"); if(all[projectId]){const docs=all[projectId].docs||[];const idx=docs.findIndex(d=>d.id===doc.id);if(idx>=0)docs[idx]=doc;else docs.push(doc);all[projectId].docs=docs;localStorage.setItem(LS_PROJECTS,JSON.stringify(all));} } catch(e) { console.error(e); }
    return;
  }
  try {
    await sb.from("documents").upsert({
      id: doc.id, project_id: projectId, name: doc.name,
      type: doc.type, source: doc.source || "upload",
      content: doc.content, uploaded_at: doc.uploadedAt,
    });
  } catch(e) { console.error("dbSaveDoc error", e); }
}
async function dbDeleteDoc(id) {
  try {
    const all = JSON.parse(localStorage.getItem(LS_PROJECTS)||"{}");
    for (const pid in all) {
      if (all[pid].docs) all[pid].docs = all[pid].docs.filter(d => d.id !== id);
    }
    localStorage.setItem(LS_PROJECTS, JSON.stringify(all));
  } catch(e) { console.error("LS doc delete error", e); }
}
async function dbSaveConfig(key, value) {
  // Guarda configuración global (tokens de integraciones, etc)
  // localStorage siempre como fallback rápido
  try { const cfg = JSON.parse(localStorage.getItem(LS_CONFIG)||"{}"); cfg[key] = value; localStorage.setItem(LS_CONFIG, JSON.stringify(cfg)); } catch {}
  if (!sb) return;
  try { await sb.from("config").upsert({ key, value, updated_at: new Date().toISOString() }); } catch(e) { console.error("dbSaveConfig error", e); }
}
async function dbLoadConfig(key) {
  // Carga configuración — primero Supabase, fallback localStorage
  if (sb) {
    try {
      const { data } = await sb.from("config").select("value").eq("key", key).single();
      if (data?.value) return data.value;
    } catch {}
  }
  try { const cfg = JSON.parse(localStorage.getItem(LS_CONFIG)||"{}"); return cfg[key] || null; } catch { return null; }
}

// ════════════════════════════════════════════════════════════════════════════
// MEMORIA DE CHAT — privada por usuario+proyecto
// Usa la tabla chat_sessions en Supabase para persistencia real.
// Cada usuario solo ve SU historial, nunca el de otros.
// ════════════════════════════════════════════════════════════════════════════
async function saveChatHistory(projectId, userId, messages) {
  // Guardar en localStorage siempre (rápido, fallback)
  try { localStorage.setItem(`sentinel_chat_${projectId}_${userId}`, JSON.stringify(messages.slice(-30))); } catch {}
  // Guardar en Supabase para persistencia real entre dispositivos
  if (!sb) return;
  try {
    const today = new Date().toISOString().split("T")[0];
    const { data: existing } = await sb.from("chat_sessions")
      .select("id").eq("project_id", projectId).eq("user_id", userId)
      .gte("created_at", today).maybeSingle();
    const payload = { project_id: projectId, user_id: userId, messages: messages.slice(-30) };
    if (existing?.id) {
      await sb.from("chat_sessions").update(payload).eq("id", existing.id);
    } else {
      await sb.from("chat_sessions").insert(payload);
    }
  } catch(e) { console.error("saveChatHistory error", e); }
}

async function loadChatHistory(projectId, userId) {
  // Primero intenta Supabase, fallback localStorage
  if (sb) {
    try {
      const { data } = await sb.from("chat_sessions")
        .select("messages, created_at")
        .eq("project_id", projectId).eq("user_id", userId)
        .order("created_at", { ascending: false }).limit(3);
      if (data?.length) {
        return data.reverse().flatMap(s => s.messages || []).slice(-25);
      }
    } catch {}
  }
  try {
    const raw = localStorage.getItem(`sentinel_chat_${projectId}_${userId}`);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}


// ── GROQ ─────────────────────────────────────────────────────
async function callGroq({ apiKey, system, messages, maxTokens = 700 }) {
  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile", max_tokens: maxTokens, temperature: 0.4,
      messages: [{ role: "system", content: system }, ...messages.slice(-20)],
    }),
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error.message);
  return d.choices?.[0]?.message?.content?.trim() || "";
}

// ════════════════════════════════════════════════════════════════════════════
// INTEGRACIONES — Cómo agregar una nueva integración a Sentinel
// ════════════════════════════════════════════════════════════════════════════
//
// Sentinel puede conectarse con cualquier app que tenga API.
// El flujo es siempre el mismo:
//
//   1. FETCH  → Llamás a la API de la app (ClickUp, Slack, Notion, etc.)
//   2. FORMAT → Convertís la respuesta en texto legible
//   3. INJECT → Lo guardás como "doc" en el proyecto activo
//   4. AI LEE → buildSystem() lo incluye en el contexto de la AI
//
// Integraciones actuales:
//   ✅ ClickUp   → tareas, listas, espacios
//   ✅ Slack     → mensajes de canales (ver SlackConnector component)
//   🔲 Notion    → páginas y bases de datos (ver sync-notion Edge Function)
//   🔲 WhatsApp  → notificaciones salientes (ver notify-whatsapp Edge Function)
//   🔲 Google Drive → documentos (agregar fetchGoogleDrive abajo)
//   🔲 GitHub    → PRs y commits (agregar fetchGitHub abajo)
//
// Para agregar una nueva integración:
//   1. Copiá el patrón de fetchClickUp abajo
//   2. Agregá el botón de sync en la sección Data Sources del UI
//   3. El doc que creás se inyecta solo en el contexto de la AI
// ════════════════════════════════════════════════════════════════════════════

// ── CLICKUP API ───────────────────────────────────────────────
async function fetchClickUp(path, token) {
  const r = await fetch(`https://api.clickup.com/api/v2${path}`, {
    headers: { "Authorization": token, "Content-Type": "application/json" }
  });
  if (!r.ok) throw new Error(`ClickUp ${r.status}`);
  return r.json();
}

async function getClickUpTasks(token, listId) {
  const data = await fetchClickUp(`/list/${listId}/task?subtasks=true&include_closed=true`, token);
  return data.tasks || [];
}

// ── SYNC ALL LISTS FROM A FOLDER ─────────────────────────────────────────
// Trae todas las listas de un folder de ClickUp en paralelo.
// Así conectás todo el folder "Sentinel Demo" de una sola vez.
// Folder ID: lo encontrás en la URL de ClickUp cuando clickeás el folder.
async function getClickUpFolderTasks(token, folderId) {
  // 1. Traer todas las listas del folder
  const listsData = await fetchClickUp(`/folder/${folderId}/list`, token);
  const lists = listsData.lists || [];
  if (!lists.length) throw new Error("No lists found in folder");

  // 2. Traer tareas de cada lista en paralelo
  const allTaskArrays = await Promise.all(
    lists.map(list =>
      fetchClickUp(`/list/${list.id}/task?subtasks=true&include_closed=true`, token)
        .then(d => (d.tasks || []).map(t => ({ ...t, listName: list.name, listId: list.id })))
        .catch(() => [])
    )
  );

  // 3. Aplanar y retornar todas las tareas con el nombre de su lista
  return { tasks: allTaskArrays.flat(), lists };
}

async function getClickUpSpaces(token, teamId) {
  const data = await fetchClickUp(`/team/${teamId}/space?archived=false`, token);
  return data.spaces || [];
}

async function getClickUpLists(token, spaceId) {
  const data = await fetchClickUp(`/space/${spaceId}/list`, token);
  return data.lists || [];
}

// ── FILE PARSER ───────────────────────────────────────────────
async function parseFile(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    const name = file.name;
    const ext = name.split(".").pop().toLowerCase();
    if (["txt","md","js","ts","py","json","yaml","yml","html","css","sql","csv"].includes(ext)) {
      reader.onload = e => resolve({ name, content: e.target.result.slice(0, 30000), type: ext === "csv" ? "csv" : "text" });
      reader.readAsText(file);
    } else if (ext === "pdf") {
      reader.onload = e => {
        const bytes = new Uint8Array(e.target.result);
        let t = "";
        for (let i = 0; i < Math.min(bytes.length, 500000); i++) if (bytes[i] > 31 && bytes[i] < 127) t += String.fromCharCode(bytes[i]);
        const readable = (t.match(/[a-zA-ZáéíóúñÁÉÍÓÚÑ0-9\s,.:;!?()\-$%@#]{6,}/g) || []).join(" ");
        resolve({ name, content: `[PDF: ${name}]\n${readable.slice(0, 8000)}`, type: "pdf" });
      };
      reader.readAsArrayBuffer(file);
    } else if (["docx","xlsx","pptx"].includes(ext)) {
      reader.onload = async e => {
        try {
          const bytes = new Uint8Array(e.target.result);
          let raw = "";
          for (let i = 0; i < Math.min(bytes.length, 500000); i++) if (bytes[i] > 31 && bytes[i] < 127) raw += String.fromCharCode(bytes[i]);
          const wtMatches = raw.match(/<w:t[^>]*>([^<]{2,})<\/w:t>/g) || [];
          const textFromTags = wtMatches.map(m => m.replace(/<[^>]+>/g, "")).join(" ");
          const fallback = (raw.match(/[a-zA-ZáéíóúñÁÉÍÓÚÑ0-9\s,.:;!?()\-$%@#]{8,}/g) || []).join(" ");
          const combined = textFromTags.length > 200 ? textFromTags : fallback;
          resolve({ name, content: `[${ext.toUpperCase()}: ${name}]\n${combined.slice(0, 10000)}`, type: "text" });
        } catch { resolve({ name, content: `[${ext.toUpperCase()}: ${name}] - Could not extract text`, type: "other" }); }
      };
      reader.readAsArrayBuffer(file);
    } else {
      reader.onload = e => resolve({ name, content: String(e.target.result || "").slice(0, 10000), type: "other" });
      reader.readAsText(file);
    }
  });
}

// ── ANOMALY DETECTOR ──────────────────────────────────────────
async function detectAnomalies({ apiKey, clickupTasks, docs, projects }) {
  if (!apiKey) return [];
  const tasksSummary = clickupTasks.slice(0, 30).map(t =>
    `[${t.status?.status?.toUpperCase()}] ${t.name} | Due: ${t.due_date ? new Date(parseInt(t.due_date)).toLocaleDateString() : "no date"} | Assignee: ${t.assignees?.[0]?.username || "unassigned"}`
  ).join("\n");

  const docsSummary = docs.slice(0, 2).map(d => d.content.slice(0, 400)).join("\n---\n");
  const today = new Date().toISOString().split("T")[0];

  const prompt = `You are a project anomaly detector. Today is ${today}.

CLICKUP TASKS:
${tasksSummary || "No tasks loaded"}

DOCUMENT CONTEXT:
${docsSummary || "No docs loaded"}

Analyze and find up to 5 anomalies. For each one return a JSON array with this exact format:
[{"severity":"high|medium|low","type":"overdue|mismatch|blocked|risk|budget","title":"short title","detail":"one sentence explanation","source":"ClickUp|Docs|Cross-source","action":"what the PM should check"}]

Only return the JSON array, nothing else.`;

  try {
    const raw = await callGroq({ apiKey, system: "You are a project anomaly detector. Return only valid JSON arrays.", messages: [{ role: "user", content: prompt }], maxTokens: 600 });
    const clean = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

// ── PROJECT TEMPLATES ─────────────────────────────────────────
const PROJECT_TEMPLATES = {
  client:  { label:"Cliente",             labelEn:"Client",             icon:"🏢", color:"#6366f1", milestones:["Discovery & Kickoff","Development Phase 1","Development Phase 2","Testing & QA","Launch & Handoff"] },
  pm:      { label:"Project Management",  labelEn:"Project Management", icon:"📋", color:"#8b5cf6", milestones:["Planning & Scope","Sprint 1","Sprint 2","Sprint 3","Delivery"] },
  hr:      { label:"Recursos Humanos",    labelEn:"Human Resources",    icon:"👥", color:"#f59e0b", milestones:["Needs Assessment","Process Design","Implementation","Training","Go-live"] },
  finance: { label:"Finanzas",            labelEn:"Finance",            icon:"💰", color:"#10b981", milestones:["Audit & Analysis","Budget Planning","Reporting Setup","Review","Close"] },
  support: { label:"Soporte / IT",        labelEn:"Support / IT",       icon:"🛠", color:"#ef4444", milestones:["Triage","Root Cause Analysis","Fix Implementation","Testing","Sign-off"] },
};

// ── TRANSLATIONS ──────────────────────────────────────────────
const LANG = {
  en: {
    platform:"Project Intelligence Platform", groqFree:"Groq API — 100% Free", groqDesc:"No credit card · 500k tokens/day",
    apiKeyLabel:"Groq API Key", connecting:"Verifying...", connectBtn:"Connect and enter →",
    howToKey:"How to get your free key",
    keySteps:[["Go to","console.groq.com","https://console.groq.com"],["Sign up (email only, no card)"],['Go to "API Keys" → Create'],["Paste here and go"]],
    keyNote:"Key never stored on any server. Session only.", groqConnected:"Groq connected",
    usernameLabel:"Username", passwordLabel:"Password",
    userPlaceholder:"admin / pm / retailco / logicorp",
    signIn:"Sign in →", wrongCredentials:"Wrong username or password", demoAccounts:"Demo accounts",
    demoList:[["#6366f1","admin","admin123","Admin — all projects"],["#8b5cf6","pm","pm123","Internal PM"],["#f59e0b","hr","hr123","Internal HR"],["#10b981","finance","finance123","Internal Finance"],["#ef4444","support","support123","Internal Support"],["#6366f1","retailco","client123","Client — Nova Commerce"],["#10b981","logicorp","logi123","Client — Fleet Tracker"]],
    dashboard:"Dashboard", aiChat:"AI Chat", dataSources:"Data Sources", tickets:"Tickets", adminNav:"Admin", monitorNav:"Monitor",
    agencyOverview:"Agency Overview", activeProjectsSub:"active projects · Real-time intelligence",
    activeProjects:"Active Projects", acrossClients:"across all clients",
    avgHealth:"Avg Health", portfolioScore:"portfolio score",
    openTickets:"Open Tickets", awaitingRes:"awaiting resolution",
    totalBudget:"Total Budget", underMgmt:"under management",
    projectHealth:"Project Health", overallScore:"overall score",
    milestonesDone:"Milestones Done", completed:"completed", budgetUsed:"Budget Used",
    projectsTracked:"Projects Tracked", allClients:"all clients",
    atRisk:"At Risk", needAttention:"need attention", milestonesDue:"Milestones Due", thisMonth:"this month",
    teamMembers:"Team Members", activeDevs:"active devs",
    totalBudgetLbl:"Total Budget", contracted:"contracted", totalSpent:"Total Spent", toDate:"to date",
    remaining:"Remaining", available:"available", avgBurnRate:"Avg Burn Rate", budgetConsumed:"budget consumed",
    teamSize:"Team Size", activeMembers:"active members", projectsMonitored:"Projects", monitored:"monitored",
    resolved:"Resolved", thisPeriod:"this period",
    milestones:"milestones", members:"members", open:"open",
    recentActivity:"Recent activity", askAI:"Ask AI about this project →",
    newChat:"New chat", docsIndexed:"docs indexed", turns:"turns",
    escalatedWarning:"Case escalated — check Tickets section",
    chatPlaceholder:(ctx)=>`Ask about ${ctx}... (Enter to send)`,
    chatRestart:"Chat restarted. How can I help?",
    dataSourcesTitle:"Data Sources", dataSourcesSub:"Connect tools and upload documents to power AI answers",
    projectLabel:"Project:", connectBtn2:"Connect →", comingSoon:"Coming soon",
    fileUpload:"📎 File Upload", urlTab:"🔗 URL", textTab:"📝 Manual Entry",
    dropzone:"Drop files or click to upload", dropzoneSub:"PDF · CSV · TXT · MD · JSON · YAML · JS · SQL · Excel",
    urlPlaceholder:"https://docs.yourproject.com, Confluence, Notion, GitHub...",
    addUrl:"Add", textPlaceholder:"Paste SOW, meeting notes, scripts, changelogs, technical specs...",
    addToKb:"Add to knowledge base", indexedDocs:"Indexed documents", noDocsYet:"No documents yet",
    ticketsTitle:"N2 Tickets", ticketsSub:"Escalated cases for manual resolution",
    backBtn:"← Back", conversation:"Conversation", clientLabel:"Client", aiLabel:"Sentinel AI",
    suggestReply:"✨ Suggest AI reply", generating:"Generating...",
    closeResolved:"Close as resolved", noTickets:"No escalated tickets yet 🎉",
    adminTitle:"Administration", adminSub:"Manage projects, clients and team access",
    createProject:"Create project", projectNamePh:"Project name",
    projectsTitle:"Projects", teamAccounts:"Team accounts", manageBtn:"Manage →",
    adminRole:"Admin — Full Access", clientPortal:"Client Portal", activeProject:"Active project",
    newProjectTitle:"New Project", templateLabel:"Template", projectNameLabel:"Project Name",
    clientNameLabel:"Client / Organization", budgetLabel:"Budget (USD)", dueDateLabel:"Due Date",
    cancelBtn:"Cancel", createProjectBtn:"Create Project",
    templateDesc:{ client:"Client-facing project with handoff milestones", pm:"Internal PM tracking with sprints", hr:"HR initiative with people metrics", finance:"Financial project with budget tracking", support:"Support or IT resolution project" },
    integrationsTitle:"Integrations", integrationsSub:"Connect external channels",
    whatsappConfig:"WhatsApp number (intl format)", emailConfig:"EmailJS Service ID",
    saveConfig:"Save", configSaved:"✓ Saved",
    notifyWhatsapp:"📱 WhatsApp", notifyEmail:"📧 Email",
    // Monitor
    monitorTitle:"Anomaly Monitor", monitorSub:"Sentinel watches your connected sources and flags inconsistencies",
    scanNow:"🔍 Scan Now", scanning:"Scanning...", lastScan:"Last scan:",
    noAnomalies:"No anomalies detected — everything looks consistent ✓",
    createTicket:"Create Ticket", dismiss:"Dismiss",
    anomalyTypes:{ overdue:"Overdue", mismatch:"Mismatch", blocked:"Blocked", risk:"Risk", budget:"Budget" },
    severityLabels:{ high:"High", medium:"Medium", low:"Low" },
    clickupSync:"ClickUp Sync", syncTasks:"Sync Tasks", syncing:"Syncing...",
    tasksLoaded:"tasks loaded", lastSynced:"Last synced:",
    notConnected:"Not connected", connected:"Connected", noKey:"No key",
    loadSpaces:"Load Spaces", configureClickup:"Configure your token and List ID",
    suggestedAction:"→ Suggested action:",
    scanPromptTitle:"Press 'Scan Now' to analyze your connected sources",
    scanPromptSub:"Sentinel will cross-reference ClickUp, docs and project data",
    deleteProject:"Delete project", deleteConfirm:"Delete this project and all its data?",
    demoTag:"DEMO", newProject:"New Project",
    projectCreated:"Project created via Sentinel", justNow:"just now",
    configureWhatsapp:"Configure WhatsApp number in Admin → Integrations",
    configureEmail:"Configure EmailJS in Admin → Integrations",
    autoMilestones:"Auto-generated milestones",
    statusLabels:{"on-track":"On Track","at-risk":"At Risk","off-track":"Off Track","done":"Done","in-progress":"In Progress","pending":"Pending","open":"Open","resolved":"Resolved"},
    welcomeAdmin:(n,count)=>`Welcome back, **${n}**. All ${count} projects are loaded. How can I help?`,
    welcomeClient:(n)=>`Hi **${n}**! I have full access to your project documentation. What would you like to know?`,
    welcomeInternal:(n,area)=>`Hi **${n}**! I'm your ${area} assistant. Ask me anything about your area.`,
    sysClient:(proj,name,docs)=>`You are Sentinel, support AI for project "${proj}" (client: ${name}). English, technical, concise. Max 3 steps. If unresolved start with ESCALAR_N2.\n${docs?`DOCS:\n${docs}`:"No docs."}`,
    sysAdmin:(projects,docs)=>`You are Sentinel, a proactive executive AI for Dramhost. ACTIVELY ANALYZE all context — projects, docs, Slack, ClickUp — and detect risks, bugs and inconsistencies WITHOUT waiting to be asked. When answering, scan everything first and report what you find proactively. If docs mention a bug, alert. If Slack and ClickUp disagree, flag it. Be direct and executive.\nPROJECTS:\n${projects}\n${docs?"FULL CONTEXT:\n"+docs:"No documents indexed."}`,
    sysInternal:{ pm:"You are Sentinel PM Assistant. Help with project tracking, sprints, milestones and velocity.", hr:"You are Sentinel HR Assistant. Help with team hours, headcount and people metrics.", finance:"You are Sentinel Finance Assistant. Help with budget tracking and forecasting.", support:"You are Sentinel Support Assistant. Help diagnose issues and suggest fixes." },
  },
  es: {
    platform:"Plataforma de Inteligencia de Proyectos", groqFree:"Groq API — 100% GRATUITO", groqDesc:"Sin tarjeta · 500k tokens/día",
    apiKeyLabel:"Tu API Key de Groq", connecting:"Verificando...", connectBtn:"Conectar y entrar →",
    howToKey:"¿Cómo obtener tu key gratis?",
    keySteps:[["Entrá a","console.groq.com","https://console.groq.com"],["Registrate (solo email, sin tarjeta)"],['Ir a "API Keys" → Crear'],["Pegá la key acá y listo"]],
    keyNote:"La key nunca se guarda en ningún servidor. Solo vive en tu sesión.", groqConnected:"Groq conectado",
    usernameLabel:"Usuario", passwordLabel:"Contraseña",
    userPlaceholder:"admin / pm / hr / finance / support / retailco / logicorp",
    signIn:"Ingresar →", wrongCredentials:"Usuario o contraseña incorrectos", demoAccounts:"Cuentas demo",
    demoList:[["#6366f1","admin","admin123","Admin — todos los proyectos"],["#8b5cf6","pm","pm123","Interno PM"],["#f59e0b","hr","hr123","Interno RRHH"],["#10b981","finance","finance123","Interno Finanzas"],["#ef4444","support","support123","Interno Soporte"],["#6366f1","retailco","client123","Cliente — Nova Commerce"],["#10b981","logicorp","logi123","Cliente — Fleet Tracker"]],
    dashboard:"Dashboard", aiChat:"Chat IA", dataSources:"Fuentes de Datos", tickets:"Tickets", adminNav:"Admin", monitorNav:"Monitor",
    agencyOverview:"Visión General", activeProjectsSub:"proyectos activos · Inteligencia en tiempo real",
    activeProjects:"Proyectos Activos", acrossClients:"en todos los clientes",
    avgHealth:"Salud Promedio", portfolioScore:"score del portafolio",
    openTickets:"Tickets Abiertos", awaitingRes:"esperando resolución",
    totalBudget:"Presupuesto Total", underMgmt:"bajo gestión",
    projectHealth:"Salud del Proyecto", overallScore:"score general",
    milestonesDone:"Milestones Listos", completed:"completados", budgetUsed:"Presupuesto Usado",
    projectsTracked:"Proyectos", allClients:"todos los clientes",
    atRisk:"En Riesgo", needAttention:"necesitan atención", milestonesDue:"Milestones", thisMonth:"este mes",
    teamMembers:"Miembros del Equipo", activeDevs:"devs activos",
    totalBudgetLbl:"Presupuesto Total", contracted:"contratado", totalSpent:"Total Gastado", toDate:"a la fecha",
    remaining:"Disponible", available:"restante", avgBurnRate:"Burn Rate Prom.", budgetConsumed:"presupuesto consumido",
    teamSize:"Tamaño del Equipo", activeMembers:"miembros activos", projectsMonitored:"Proyectos", monitored:"monitoreados",
    resolved:"Resueltos", thisPeriod:"este período",
    milestones:"milestones", members:"miembros", open:"abierto",
    recentActivity:"Actividad reciente", askAI:"Preguntarle a la IA →",
    newChat:"Nuevo chat", docsIndexed:"docs indexados", turns:"turnos",
    escalatedWarning:"Caso escalado — revisá la sección Tickets",
    chatPlaceholder:(ctx)=>`Preguntá sobre ${ctx === "all projects" ? "todos los proyectos" : ctx}... (Enter para enviar)`,
    chatRestart:"Chat reiniciado. ¿En qué puedo ayudarte?",
    dataSourcesTitle:"Fuentes de Datos", dataSourcesSub:"Conectá herramientas y subí documentos para potenciar las respuestas de IA",
    projectLabel:"Proyecto:", connectBtn2:"Conectar →", comingSoon:"Próximamente",
    fileUpload:"📎 Subir Archivo", urlTab:"🔗 URL", textTab:"📝 Entrada Manual",
    dropzone:"Arrastrá archivos o hacé click", dropzoneSub:"PDF · CSV · TXT · MD · JSON · YAML · JS · SQL · Excel",
    urlPlaceholder:"https://docs.tuproyecto.com, Confluence, Notion, GitHub...",
    addUrl:"Agregar", textPlaceholder:"Pegá SOW, notas de reunión, scripts, changelogs, specs técnicos...",
    addToKb:"Agregar a la base de conocimiento", indexedDocs:"Documentos indexados", noDocsYet:"Sin documentos aún",
    ticketsTitle:"Tickets N2", ticketsSub:"Casos escalados para resolución manual",
    backBtn:"← Volver", conversation:"Conversación", clientLabel:"Cliente", aiLabel:"Sentinel IA",
    suggestReply:"✨ Sugerir respuesta con IA", generating:"Generando...",
    closeResolved:"Cerrar como resuelto", noTickets:"Sin tickets escalados aún 🎉",
    adminTitle:"Administración", adminSub:"Gestioná proyectos, clientes y accesos",
    createProject:"Crear proyecto", projectNamePh:"Nombre del proyecto",
    projectsTitle:"Proyectos", teamAccounts:"Cuentas del equipo", manageBtn:"Gestionar →",
    adminRole:"Admin — Acceso Total", clientPortal:"Portal del Cliente", activeProject:"Proyecto activo",
    newProjectTitle:"Nuevo Proyecto", templateLabel:"Template", projectNameLabel:"Nombre del Proyecto",
    clientNameLabel:"Cliente / Organización", budgetLabel:"Presupuesto (USD)", dueDateLabel:"Fecha Límite",
    cancelBtn:"Cancelar", createProjectBtn:"Crear Proyecto",
    templateDesc:{ client:"Proyecto de cliente con milestones de entrega", pm:"Seguimiento PM interno con sprints", hr:"Iniciativa de RRHH con métricas de personas", finance:"Proyecto financiero con seguimiento de presupuesto", support:"Proyecto de soporte o resolución IT" },
    integrationsTitle:"Integraciones", integrationsSub:"Conectá canales externos a Sentinel",
    whatsappConfig:"Número WhatsApp (formato intl.)", emailConfig:"EmailJS Service ID",
    saveConfig:"Guardar", configSaved:"✓ Guardado",
    notifyWhatsapp:"📱 WhatsApp", notifyEmail:"📧 Email",
    monitorTitle:"Monitor de Anomalías", monitorSub:"Sentinel observa tus fuentes conectadas y detecta inconsistencias",
    scanNow:"🔍 Escanear Ahora", scanning:"Escaneando...", lastScan:"Último escaneo:",
    noAnomalies:"Sin anomalías detectadas — todo parece consistente ✓",
    createTicket:"Crear Ticket", dismiss:"Descartar",
    anomalyTypes:{ overdue:"Vencido", mismatch:"Inconsistencia", blocked:"Bloqueado", risk:"Riesgo", budget:"Presupuesto" },
    severityLabels:{ high:"Alto", medium:"Medio", low:"Bajo" },
    clickupSync:"Sincronización ClickUp", syncTasks:"Sincronizar Tareas", syncing:"Sincronizando...",
    tasksLoaded:"tareas cargadas", lastSynced:"Última sincronización:",
    notConnected:"No conectado", connected:"Conectado", noKey:"Sin key",
    loadSpaces:"Cargar Spaces", configureClickup:"Configurá tu token y List ID",
    suggestedAction:"→ Acción sugerida:",
    scanPromptTitle:"Presioná 'Escanear Ahora' para analizar tus fuentes",
    scanPromptSub:"Sentinel cruzará ClickUp, documentos y datos de proyectos",
    deleteProject:"Eliminar proyecto", deleteConfirm:"¿Eliminar este proyecto y todos sus datos?",
    demoTag:"DEMO", newProject:"Nuevo Proyecto",
    projectCreated:"Proyecto creado en Sentinel", justNow:"ahora mismo",
    configureWhatsapp:"Configurá el número de WhatsApp en Admin → Integraciones",
    configureEmail:"Configurá EmailJS en Admin → Integraciones",
    autoMilestones:"Milestones generados automáticamente",
    statusLabels:{"on-track":"En Curso","at-risk":"En Riesgo","off-track":"Fuera de Curso","done":"Listo","in-progress":"En Progreso","pending":"Pendiente","open":"Abierto","resolved":"Resuelto"},
    welcomeAdmin:(n,count)=>`Bienvenido, **${n}**. Los ${count} proyectos están cargados. ¿En qué puedo ayudarte?`,
    welcomeClient:(n)=>`¡Hola **${n}**! Tengo acceso a toda la documentación de tu proyecto. ¿Qué necesitás saber?`,
    welcomeInternal:(n,area)=>`¡Hola **${n}**! Soy tu asistente de ${area}. Preguntame lo que necesités.`,
    sysClient:(proj,name,docs)=>`Sos Sentinel, IA de soporte para el proyecto "${proj}" (cliente: ${name}). Español, técnico, conciso. Máximo 3 pasos. Si no se resuelve empezá con ESCALAR_N2.\n${docs?`DOCS:\n${docs}`:"Sin docs."}`,
    sysAdmin:(projects,docs)=>`Sos Sentinel, IA ejecutiva para Dramhost.\nProyectos:\n${projects}\n${docs?`Docs:\n${docs}`:""}`,
    sysInternal:{ pm:"Sos el Asistente PM de Sentinel. Ayudá con seguimiento, sprints y milestones.", hr:"Sos el Asistente RRHH. Ayudá con horas, headcount y métricas de personas.", finance:"Sos el Asistente de Finanzas. Presupuesto, costos y proyecciones.", support:"Sos el Asistente de Soporte. Diagnosticá problemas y sugerí soluciones." },
  }
};

// ── DEMO DATA ─────────────────────────────────────────────────
const DEMO_PROJECTS = {
  "nova-commerce": { id:"nova-commerce", isDemo:true, name:"Nova Commerce Platform", client:"RetailCo Inc.", type:"client", color:"#6366f1", status:"on-track", health:87, budget:120000, spent:94000, startDate:"2025-01-15", dueDate:"2025-06-30", milestones:[{id:"m1",name:"Discovery & Architecture",due:"2025-02-15",status:"done"},{id:"m2",name:"Core Backend APIs",due:"2025-03-30",status:"done"},{id:"m3",name:"Frontend MVP",due:"2025-04-30",status:"in-progress"},{id:"m4",name:"Integrations & Testing",due:"2025-05-31",status:"pending"},{id:"m5",name:"Launch & Handoff",due:"2025-06-30",status:"pending"}], team:["Alex Rivera","Sam Chen","Jordan Lee","Taylor Kim"], docs:[{id:"d1",name:"Tech Stack & Runbook",type:"text",source:"manual",uploadedAt:"2025-02-01",content:`Project: Nova Commerce Platform | Client: RetailCo Inc.\nStack: Node.js 20, React 18, PostgreSQL 15, Redis 7, AWS EC2\nPAYMENTS: Stripe v3 · webhook /api/payments/webhook\nINVENTORY: cron every 5min · Redis TTL 300s\nINFRA: AWS EC2 + PM2 · deploy: ./scripts/deploy.sh`}], tickets:[], activity:[{type:"commit",text:"feat: add Stripe webhook handler",user:"Alex Rivera",time:"2h ago"},{type:"task",text:"Frontend MVP — Sprint 4 started",user:"Sam Chen",time:"5h ago"}] },
  "fleet-tracker": { id:"fleet-tracker", isDemo:true, name:"Fleet Tracker 360", client:"LogiCorp SA", type:"client", color:"#10b981", status:"at-risk", health:61, budget:85000, spent:71000, startDate:"2025-02-01", dueDate:"2025-07-15", milestones:[{id:"m1",name:"GPS Integration Layer",due:"2025-03-01",status:"done"},{id:"m2",name:"Real-time Dashboard",due:"2025-04-15",status:"at-risk"},{id:"m3",name:"Mobile App Beta",due:"2025-05-30",status:"pending"},{id:"m4",name:"Reporting Module",due:"2025-06-30",status:"pending"}], team:["Morgan Walsh","Casey Park"], docs:[{id:"d2",name:"Architecture Overview",type:"text",source:"manual",uploadedAt:"2025-02-10",content:`Project: Fleet Tracker 360 | Client: LogiCorp SA\nStack: Python FastAPI, React Native, PostgreSQL, Redis\nGPS: WebSocket stream · update every 30s\nMOBILE: React Native 0.73 · Expo`}], tickets:[{id:"TKT-0012",summary:"Real-time map not updating after 10min idle",status:"open",severity:"high",createdAt:"2025-04-10T10:00:00Z",conversation:[{role:"user",content:"Map stops updating after 10 minutes of idle"}]}], activity:[{type:"alert",text:"Milestone 2 at risk — 3 tasks overdue",user:"System",time:"30m ago"},{type:"commit",text:"fix: websocket reconnection logic",user:"Morgan Walsh",time:"3h ago"}] },
  "hr-portal": { id:"hr-portal", isDemo:true, name:"HR Self-Service Portal", client:"Internal — Dramhost", type:"hr", color:"#f59e0b", status:"on-track", health:92, budget:45000, spent:28000, startDate:"2025-03-01", dueDate:"2025-07-01", milestones:[{id:"m1",name:"Auth & Roles",due:"2025-03-31",status:"done"},{id:"m2",name:"Leave Management",due:"2025-04-30",status:"done"},{id:"m3",name:"Payroll Integration",due:"2025-05-31",status:"in-progress"}], team:["Riley Johnson","Drew Martinez"], docs:[], tickets:[], activity:[{type:"task",text:"Payroll API integration — 70% complete",user:"Riley Johnson",time:"1h ago"}] },
};

const USERS = {
  admin:   {id:"admin",   name:"Alex Admin",    role:"admin",    password:"admin123",  avatar:"AA",color:"#6366f1"},
  pm:      {id:"pm",      name:"Sam PM",         role:"internal", area:"pm",      password:"pm123",      avatar:"SP",color:"#8b5cf6"},
  hr:      {id:"hr",      name:"Jordan HR",      role:"internal", area:"hr",      password:"hr123",      avatar:"JH",color:"#f59e0b"},
  finance: {id:"finance", name:"Taylor Finance", role:"internal", area:"finance", password:"finance123", avatar:"TF",color:"#10b981"},
  support: {id:"support", name:"Morgan Support", role:"internal", area:"support", password:"support123", avatar:"MS",color:"#ef4444"},
  retailco:{id:"retailco",name:"RetailCo Inc.",  role:"client",   password:"client123",projectId:"nova-commerce",avatar:"RC",color:"#6366f1"},
  logicorp:{id:"logicorp",name:"LogiCorp SA",    role:"client",   password:"logi123",  projectId:"fleet-tracker",avatar:"LC",color:"#10b981"},
};

const AREA_CONFIG = {
  pm:     {label:"Project Management",labelEs:"Gestión de Proyectos",icon:"📋",color:"#8b5cf6"},
  hr:     {label:"Human Resources",   labelEs:"Recursos Humanos",    icon:"👥",color:"#f59e0b"},
  finance:{label:"Finance",           labelEs:"Finanzas",             icon:"💰",color:"#10b981"},
  support:{label:"Support N2",        labelEs:"Soporte N2",           icon:"🛠",color:"#ef4444"},
};

// ── ICONS ─────────────────────────────────────────────────────
const I = {
  Send:    ()=><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>,
  Bot:     ()=><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/><circle cx="8" cy="16" r="1" fill="currentColor"/><circle cx="16" cy="16" r="1" fill="currentColor"/></svg>,
  User:    ()=><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>,
  Upload:  ()=><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/></svg>,
  Ticket:  ()=><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2z"/></svg>,
  Settings:()=><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93A10 10 0 0 0 12 2C6.48 2 2 6.48 2 12s4.48 10 10 10a10 10 0 0 0 7.07-2.93"/><path d="M12 22v-4m0-12V2M2 12h4m12 0h4"/></svg>,
  Logout:  ()=><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>,
  Trash:   ()=><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>,
  Plus:    ()=><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>,
  Check:   ()=><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>,
  Alert:   ()=><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>,
  Home:    ()=><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>,
  Link:    ()=><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>,
  Zap:     ()=><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>,
  Key:     ()=><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="7.5" cy="15.5" r="5.5"/><path d="M21 2l-9.6 9.6"/><path d="M15.5 7.5l3 3L22 7l-3-3"/></svg>,
  Eye:     ()=><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>,
  Refresh: ()=><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>,
  Grid:    ()=><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>,
  Phone:   ()=><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 13a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.45 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 9.91a16 16 0 0 0 6.13 6.13l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>,
};

function MD({text, color}) {
  const html = String(text||"")
    .replace(/\*\*(.+?)\*\*/g,"<strong>$1</strong>")
    .replace(/`([^`]+)`/g,`<code style="background:rgba(0,0,0,0.3);padding:1px 5px;border-radius:3px;font-size:11px;color:#7dd3fc;font-family:monospace">$1</code>`)
    .replace(/^(\d+)\. (.+)$/gm,`<div style="margin:3px 0;padding-left:6px">$1. $2</div>`)
    .replace(/^- (.+)$/gm,`<div style="margin:2px 0;padding-left:6px">• $1</div>`)
    .replace(/\n/g,"<br/>");
  return <span style={{color:color||"inherit",display:"block"}} dangerouslySetInnerHTML={{__html:html}}/>;
}
function Dots() {
  return <span style={{display:"flex",gap:4,alignItems:"center"}}><style>{`@keyframes bl{0%,80%,100%{opacity:.15;transform:scale(.7)}40%{opacity:1;transform:scale(1)}}`}</style>{[0,1,2].map(i=><span key={i} style={{width:6,height:6,borderRadius:"50%",background:"#818cf8",display:"inline-block",animation:`bl 1.2s ease-in-out ${i*0.2}s infinite`}}/>)}</span>;
}
function Avatar({user,size=30}) {
  return <div style={{width:size,height:size,borderRadius:"50%",background:user.color||"#4f46e5",display:"flex",alignItems:"center",justifyContent:"center",fontSize:size*0.35,fontWeight:700,color:"white",flexShrink:0}}>{user.avatar||user.name?.[0]}</div>;
}
function HealthBar({value,width=80}) {
  const color=value>=80?"#10b981":value>=60?"#f59e0b":"#ef4444";
  return <div style={{display:"flex",alignItems:"center",gap:6}}><div style={{width,height:5,background:"#1e293b",borderRadius:3,overflow:"hidden"}}><div style={{width:`${value}%`,height:"100%",background:color,borderRadius:3}}/></div><span style={{fontSize:11,color,fontWeight:700}}>{value}%</span></div>;
}
function StatusBadge({status,t}) {
  const cfg={"on-track":{bg:"#052e16",color:"#10b981",border:"#166534"},"at-risk":{bg:"#451a03",color:"#f59e0b",border:"#78350f"},"off-track":{bg:"#450a0a",color:"#ef4444",border:"#7f1d1d"},"done":{bg:"#052e16",color:"#10b981",border:"#166534"},"in-progress":{bg:"#1e1b4b",color:"#818cf8",border:"#312e81"},"pending":{bg:"#1e293b",color:"#64748b",border:"#334155"},"open":{bg:"#450a0a",color:"#ef4444",border:"#7f1d1d"},"resolved":{bg:"#052e16",color:"#10b981",border:"#166534"}};
  const c=cfg[status]||cfg["pending"];
  return <span style={{padding:"2px 8px",borderRadius:4,fontSize:10,fontWeight:700,background:c.bg,color:c.color,border:`1px solid ${c.border}`}}>{t?.statusLabels?.[status]||status}</span>;
}
function LangToggle({lang,setLang}) {
  return <div style={{display:"flex",gap:2,background:"#1e293b",borderRadius:6,padding:2}}>{["en","es"].map(l=><button key={l} onClick={()=>setLang(l)} style={{padding:"3px 8px",borderRadius:4,border:"none",cursor:"pointer",fontSize:11,fontWeight:700,fontFamily:"inherit",background:lang===l?"#4f46e5":"transparent",color:lang===l?"white":"#64748b"}}>{l==="es"?"🇦🇷 ES":"🇺🇸 EN"}</button>)}</div>;
}
function MetricCard({label,value,sub,color="#f1f5f9"}) {
  return <div style={{background:"#0d1526",border:"1px solid #1e293b",borderRadius:10,padding:"14px",textAlign:"center"}}><div style={{fontSize:11,color:"#64748b",marginBottom:4}}>{label}</div><div style={{fontSize:24,fontWeight:800,color}}>{value}</div><div style={{fontSize:10,color:"#475569",marginTop:2}}>{sub}</div></div>;
}

// ── SEVERITY CONFIG ───────────────────────────────────────────
const SEV = {
  high:   {bg:"#450a0a",color:"#ef4444",border:"#7f1d1d",dot:"#ef4444"},
  medium: {bg:"#451a03",color:"#f59e0b",border:"#78350f",dot:"#f59e0b"},
  low:    {bg:"#1e293b",color:"#64748b",border:"#334155",dot:"#64748b"},
};

// ── MONITOR VIEW ──────────────────────────────────────────────
function MonitorView({t, groqKey, clickupTasks, projects, allDocs, onCreateTicket, lang}) {
  const [anomalies, setAnomalies] = useState([]);
  const [scanning, setScanning]   = useState(false);
  const [lastScan, setLastScan]   = useState(null);
  const [dismissed, setDismissed] = useState([]);

  const scan = async () => {
    setScanning(true);
    try {
      const allProjectDocs = Object.values(projects).flatMap(p => p.docs || []);
      const detected = await detectAnomalies({ apiKey: groqKey, clickupTasks, docs: [...allProjectDocs, ...allDocs], projects: Object.values(projects) });
      setAnomalies(detected.map((a,i) => ({...a, id: Date.now()+i})));
      setLastScan(new Date());
      setDismissed([]);
    } finally { setScanning(false); }
  };

  const visible = anomalies.filter(a => !dismissed.includes(a.id));
  const hasClickup = clickupTasks.length > 0;

  return (
    <div style={S.panel}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:22}}>
        <div>
          <h2 style={S.panelH}>{t.monitorTitle}</h2>
          <p style={S.panelSub}>{t.monitorSub}</p>
        </div>
        <div style={{display:"flex",gap:8,alignItems:"center"}}>
          {lastScan && <span style={{fontSize:11,color:"#475569"}}>{t.lastScan} {lastScan.toLocaleTimeString()}</span>}
          <button onClick={scan} disabled={scanning} style={{...S.smBtn,borderColor:"#4f46e5",color:"#818cf8",gap:6}}>
            {scanning ? <Dots/> : <I.Eye/>} {scanning ? t.scanning : t.scanNow}
          </button>
        </div>
      </div>

      {/* Source status strip */}
      <div style={{display:"flex",gap:8,marginBottom:20,flexWrap:"wrap"}}>
        {[
          {name:"ClickUp", ok:hasClickup, detail: hasClickup ? `${clickupTasks.length} ${t.tasksLoaded}` : t.notConnected},
          {name:"Docs", ok:Object.values(projects).some(p=>p.docs?.length), detail:`${Object.values(projects).flatMap(p=>p.docs||[]).length} indexed`},
          {name:"Groq AI", ok:!!groqKey, detail: groqKey ? t.connected : t.noKey},
        ].map(src=>(
          <div key={src.name} style={{display:"flex",alignItems:"center",gap:6,background:"#1e293b",borderRadius:7,padding:"6px 12px",border:`1px solid ${src.ok?"#166534":"#334155"}`}}>
            <div style={{width:6,height:6,borderRadius:"50%",background:src.ok?"#10b981":"#475569"}}/>
            <span style={{fontSize:12,fontWeight:600,color:src.ok?"#e2e8f0":"#64748b"}}>{src.name}</span>
            <span style={{fontSize:11,color:"#475569"}}>· {src.detail}</span>
          </div>
        ))}
      </div>

      {/* Anomaly cards */}
      {!lastScan ? (
        <div style={{textAlign:"center",padding:"60px 0",color:"#475569"}}>
          <div style={{fontSize:32,marginBottom:12}}>🔍</div>
          <div style={{fontSize:14,color:"#64748b",marginBottom:8}}>{t.scanPromptTitle}</div>
          <div style={{fontSize:12,color:"#334155"}}>{t.scanPromptSub}</div>
        </div>
      ) : visible.length === 0 ? (
        <div style={{textAlign:"center",padding:"60px 0"}}>
          <div style={{fontSize:32,marginBottom:12}}>✅</div>
          <div style={{fontSize:14,color:"#10b981"}}>{t.noAnomalies}</div>
        </div>
      ) : (
        <div style={{display:"flex",flexDirection:"column",gap:10}}>
          {visible.map(a => {
            const sev = SEV[a.severity] || SEV.low;
            return (
              <div key={a.id} style={{background:"#0d1526",border:`1px solid ${sev.border}`,borderRadius:12,padding:"14px 16px"}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:8}}>
                  <div style={{display:"flex",gap:8,alignItems:"center"}}>
                    <div style={{width:8,height:8,borderRadius:"50%",background:sev.dot,flexShrink:0,marginTop:2}}/>
                    <div>
                      <span style={{fontSize:13,fontWeight:700,color:"#f1f5f9"}}>{a.title}</span>
                      <div style={{display:"flex",gap:6,marginTop:3}}>
                        <span style={{fontSize:10,fontWeight:700,padding:"1px 6px",borderRadius:3,background:sev.bg,color:sev.color,border:`1px solid ${sev.border}`}}>{t.severityLabels[a.severity]||a.severity}</span>
                        <span style={{fontSize:10,color:"#475569",padding:"1px 6px",background:"#1e293b",borderRadius:3}}>{t.anomalyTypes[a.type]||a.type}</span>
                        <span style={{fontSize:10,color:"#475569"}}>· {a.source}</span>
                      </div>
                    </div>
                  </div>
                  <button onClick={()=>setDismissed(d=>[...d,a.id])} style={{...S.iconBtn,fontSize:11,color:"#475569"}}>{t.dismiss} ✕</button>
                </div>
                <div style={{fontSize:12,color:"#94a3b8",marginBottom:8,paddingLeft:16}}>{a.detail}</div>
                <div style={{fontSize:11,color:"#64748b",paddingLeft:16,marginBottom:10}}>
                  <span style={{color:"#818cf8",fontWeight:600}}>{t.suggestedAction}</span> {a.action}
                </div>
                <div style={{display:"flex",gap:6,paddingLeft:16}}>
                  <button onClick={()=>onCreateTicket(a)} style={{...S.smBtn,borderColor:"#ef4444",color:"#ef4444",fontSize:11}}>🎫 {t.createTicket}</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── NEW PROJECT MODAL ─────────────────────────────────────────
function NewProjectModal({t,lang,onClose,onCreate}) {
  const [tmpl,setTmpl]=useState("client");
  const [name,setName]=useState("");
  const [client,setClient]=useState("");
  const [budget,setBudget]=useState("");
  const [dueDate,setDueDate]=useState("");
  const tpl=PROJECT_TEMPLATES[tmpl];

  const handleCreate=()=>{
    if(!name.trim())return;
    const id=name.toLowerCase().replace(/\s+/g,"-")+"-"+Date.now().toString().slice(-4);
    onCreate({id,name,client:client||"TBD",type:tmpl,color:tpl.color,status:"on-track",health:100,budget:parseInt(budget)||0,spent:0,startDate:new Date().toISOString().split("T")[0],dueDate:dueDate||"",milestones:tpl.milestones.map((m,i)=>({id:`m${i+1}`,name:m,due:"",status:"pending"})),team:[],docs:[],tickets:[],activity:[{type:"task",text:t.projectCreated||"Project created",user:"Admin",time:t.justNow||"just now"}]});
    onClose();
  };

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.7)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:999}}>
      <div style={{background:"#0d1526",border:"1px solid #334155",borderRadius:16,padding:28,width:480,maxWidth:"95vw"}}>
        <div style={{fontWeight:800,fontSize:16,color:"#f1f5f9",marginBottom:20}}>{t.newProjectTitle}</div>
        <div style={{marginBottom:16}}>
          <div style={S.label}>{t.templateLabel}</div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:6}}>
            {Object.entries(PROJECT_TEMPLATES).map(([key,tp])=>(
              <button key={key} onClick={()=>setTmpl(key)} style={{...S.smBtn,flexDirection:"column",alignItems:"center",padding:"8px 4px",gap:3,...(tmpl===key?{borderColor:tp.color,color:tp.color,background:"#1e293b"}:{})}}>
                <span style={{fontSize:16}}>{tp.icon}</span>
                <span style={{fontSize:9,textAlign:"center",lineHeight:1.2}}>{lang==="es"?tp.label:tp.labelEn}</span>
              </button>
            ))}
          </div>
          <div style={{fontSize:11,color:"#475569",marginTop:8,padding:"8px 10px",background:"#1e293b",borderRadius:7}}>{t.templateDesc[tmpl]}</div>
        </div>
        <div style={{display:"flex",flexDirection:"column",gap:10}}>
          <div><label style={S.label}>{t.projectNameLabel} *</label><input style={S.input} value={name} onChange={e=>setName(e.target.value)} placeholder="e.g. Nova Commerce v2"/></div>
          <div><label style={S.label}>{t.clientNameLabel}</label><input style={S.input} value={client} onChange={e=>setClient(e.target.value)} placeholder="e.g. RetailCo Inc."/></div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
            <div><label style={S.label}>{t.budgetLabel}</label><input style={S.input} type="number" value={budget} onChange={e=>setBudget(e.target.value)} placeholder="50000"/></div>
            <div><label style={S.label}>{t.dueDateLabel}</label><input style={{...S.input,colorScheme:"dark"}} type="date" value={dueDate} onChange={e=>setDueDate(e.target.value)}/></div>
          </div>
        </div>
        <div style={{marginTop:14,padding:"10px 12px",background:"#1e293b",borderRadius:8}}>
          <div style={{fontSize:10,color:"#64748b",fontWeight:700,textTransform:"uppercase",letterSpacing:1,marginBottom:6}}>Auto-generated milestones</div>
          <div style={{display:"flex",flexWrap:"wrap",gap:4}}>{tpl.milestones.map((m,i)=><span key={i} style={{fontSize:10,background:"#0d1526",color:"#94a3b8",padding:"2px 8px",borderRadius:4,border:"1px solid #334155"}}>{m}</span>)}</div>
        </div>
        <div style={{display:"flex",gap:8,marginTop:18,justifyContent:"flex-end"}}>
          <button onClick={onClose} style={S.smBtn}>{t.cancelBtn}</button>
          <button onClick={handleCreate} disabled={!name.trim()} style={{...S.bigBtn,width:"auto",padding:"9px 20px",fontSize:13}}>{t.createProjectBtn}</button>
        </div>
      </div>
    </div>
  );
}


// ── SLACK CONNECTOR ──────────────────────────────────────────
function SlackConnector({pid, projects, setProjects, groqKey, lang, t, dbSaveDoc, DB_ENABLED, S, I}) {
  const LS_SLACK = "sentinel_slack_tokens";
  const getSaved = () => { try { return JSON.parse(localStorage.getItem(LS_SLACK)||"{}"); } catch { return {}; } };
  const [slackToken, setSlackToken] = useState(() => getSaved()[pid]?.token || "");
  const [channelId,  setChannelId]  = useState(() => getSaved()[pid]?.channel || "");
  const [syncing,    setSyncing]    = useState(false);
  const [lastSync,   setLastSync]   = useState(null);
  const [msgCount,   setMsgCount]   = useState(0);

  const saveCredentials = (token, channel) => {
    const all = getSaved();
    all[pid] = { token, channel };
    localStorage.setItem(LS_SLACK, JSON.stringify(all));
  };

  const syncSlack = async () => {
    if (!slackToken || !channelId) { alert("Enter Slack Bot Token and Channel ID first"); return; }
    setSyncing(true);
    try {
      // Fetch messages from Slack API via proxy-less approach
      const r = await fetch(`https://slack.com/api/conversations.history?channel=${channelId}&limit=50`, {
        headers: { "Authorization": `Bearer ${slackToken}` }
      });
      const data = await r.json();
      if (!data.ok) throw new Error(data.error || "Slack API error");
      
      const messages = data.messages || [];
      // Format messages as readable content
      const formatted = messages
        .filter(m => m.type === "message" && m.text)
        .reverse()
        .map(m => {
          const time = new Date(parseFloat(m.ts) * 1000).toLocaleString();
          const user = m.username || m.user || "user";
          return `[${time}] ${user}: ${m.text}`;
        })
        .join("\n");

      const doc = {
        id: `slack-${channelId}-${Date.now()}`,
        name: `Slack #${channelId} — ${messages.length} messages`,
        type: "text",
        source: "slack",
        content: `SLACK CHANNEL: ${channelId}\nSynced: ${new Date().toLocaleString()}\n\n${formatted}`,
        uploadedAt: new Date().toISOString().split("T")[0]
      };

      setProjects(p => ({...p, [pid]: {...p[pid], docs: [...(p[pid]?.docs||[]).filter(d=>d.source!=="slack"||d.name!==doc.name), doc]}}));
      if (DB_ENABLED) dbSaveDoc(doc, pid).catch(console.error);
      setLastSync(new Date());
      setMsgCount(messages.length);
    } catch(err) {
      alert(`Slack error: ${err.message}. Make sure CORS is enabled or use a proxy.`);
    } finally { setSyncing(false); }
  };

  const connected = !!slackToken && !!channelId;

  return (
    <div style={{...S.card, marginBottom:16, borderColor: connected ? "#1d4ed8" : "#334155"}}>
      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12}}>
        <span style={{fontSize:20}}>💬</span>
        <div>
          <div style={{fontSize:13,fontWeight:700,color:"#e2e8f0"}}>Slack — Live Connection</div>
          <div style={{fontSize:11,color:"#64748b"}}>{lastSync ? `${msgCount} messages · synced ${lastSync.toLocaleTimeString()}` : "Connect to read channel messages"}</div>
        </div>
        {connected && <div style={{marginLeft:"auto",width:8,height:8,borderRadius:"50%",background:"#3b82f6"}}/>}
      </div>
      <div style={{display:"flex",flexDirection:"column",gap:8}}>
        <div>
          <label style={S.label}>Bot Token (xoxb-...)</label>
          <input style={S.input} type="password" placeholder="xoxb-..." value={slackToken}
            onChange={e => { setSlackToken(e.target.value); saveCredentials(e.target.value, channelId); }}/>
        </div>
        <div>
          <label style={S.label}>Channel ID (C0XXXXXXX)</label>
          <input style={S.input} placeholder="C0AMR75UX97" value={channelId}
            onChange={e => { setChannelId(e.target.value); saveCredentials(slackToken, e.target.value); }}/>
        </div>
        <div style={{fontSize:10,color:"#475569"}}>
          Get token: api.slack.com → Your Apps → Bot Token Scopes: channels:history, channels:read
        </div>
        <button onClick={syncSlack} disabled={syncing || !slackToken || !channelId}
          style={{...S.smBtn, borderColor:"#3b82f6", color:"#60a5fa"}}>
          {syncing ? <><Dots/> Syncing...</> : <><I.Refresh/> Sync Messages</>}
        </button>
        {lastSync && <div style={{fontSize:11,color:"#3b82f6"}}>✓ {msgCount} messages indexed</div>}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════
export default function Sentinel() {
  const [lang, setLangState]          = useState("en");
  const [groqKey, setGroqKey]         = useState(import.meta.env.VITE_GROQ_KEY||"");
  const [keyInput, setKeyInput]       = useState("");
  const [keyError, setKeyError]       = useState("");
  const [keyTesting, setKeyTesting]   = useState(false);
  const [user, setUser]               = useState(null);
  const [loginForm, setLoginForm]     = useState({u:"",p:""});
  const [loginErr, setLoginErr]       = useState("");
  const [view, setView]               = useState("dashboard");
  const [projects, setProjects]       = useState(DEMO_PROJECTS);
  const [dbLoaded, setDbLoaded]       = useState(false);
  const [dbSyncing, setDbSyncing]     = useState(false);
  const [activeProject, setActive]    = useState("nova-commerce");
  const [messages, setMessages]       = useState([]);
  const [input, setInput]             = useState("");
  const [loading, setLoading]         = useState(false);
  const [escalated, setEscalated]     = useState(false);
  const [docTab, setDocTab]           = useState("manual");
  const [urlInput, setUrlInput]       = useState("");
  const [scriptTxt, setScriptTxt]     = useState("");
  const [selectedTkt, setSelectedTkt] = useState(null);
  const [tktReply, setTktReply]       = useState("");
  const [showNewProj, setShowNewProj] = useState(false);
  const [adminTab, setAdminTab]       = useState("projects");
  // ClickUp integration state
  const [cuToken, setCuToken]         = useState(localStorage.getItem("sentinel_cu_token")||"");
  const [cuTeamId, setCuTeamId]       = useState(localStorage.getItem("sentinel_cu_team")||"9013065880");
  const [cuListId, setCuListId]       = useState(localStorage.getItem("sentinel_cu_list")||"");
  const [cuTasks, setCuTasks]         = useState([]);
  const [cuSyncing, setCuSyncing]     = useState(false);
  const [cuLastSync, setCuLastSync]   = useState(null);
  const [cuSpaces, setCuSpaces]       = useState([]);
  const [cuLists, setCuLists]         = useState([]);
  const [cuFolderId, setCuFolderId]   = useState(localStorage.getItem("sentinel_cu_folder")||"901317793533");
  const [cuSyncedLists, setCuSyncedLists] = useState([]);

  const fileRef   = useRef();
  const bottomRef = useRef();
  const inputRef  = useRef();
  const t = LANG[lang];

  useEffect(()=>{bottomRef.current?.scrollIntoView({behavior:"smooth"});},[messages]);

  // Load projects from Supabase on mount — siempre incluye demos
  useEffect(()=>{
    if(!DB_ENABLED){setDbLoaded(true);return;}
    setDbSyncing(true);
    dbLoad().then(async data=>{
      // Siempre partir de los demos del código
      let merged={...DEMO_PROJECTS};
      if(data&&Object.keys(data).length>0){
        // Agregar proyectos reales de Supabase (sobreescriben demo si mismo id)
        merged={...merged,...data};
      }
      // Si algún demo no está en Supabase y no fue borrado intencionalmente, guardarlo
      const deletedDemos=JSON.parse(localStorage.getItem("sentinel_deleted_demos")||"[]");
      for(const demo of Object.values(DEMO_PROJECTS)){
        if(!deletedDemos.includes(demo.id)&&(!data||!data[demo.id])){
          try{ await dbSaveProject(demo); }catch{}
        }
        // Si fue borrado, sacarlo del merged también
        if(deletedDemos.includes(demo.id)) delete merged[demo.id];
      }
      setProjects(merged);
      // Activar primer proyecto real o el primero disponible
      const realProjs=Object.values(merged).filter(p=>!p.isDemo);
      setActive(realProjs.length>0?realProjs[0].id:Object.keys(merged)[0]);
      setDbLoaded(true);setDbSyncing(false);
    }).catch(()=>{setProjects(DEMO_PROJECTS);setDbLoaded(true);setDbSyncing(false);});
  },[]);

  // Load ClickUp token from Supabase config
  useEffect(()=>{
    if(!DB_ENABLED)return;
    dbLoadConfig("cu_token").then(v=>{if(v){setCuToken(v);localStorage.setItem("sentinel_cu_token",v);}});
    dbLoadConfig("cu_list").then(v=>{if(v){setCuListId(v);localStorage.setItem("sentinel_cu_list",v);}});
    dbLoadConfig("wa_num").then(v=>{if(v)localStorage.setItem("sentinel_wa",v);});
  },[]);

  const pid     = user?.projectId||activeProject;
  const project = projects[pid];
  const getAreaLabel=(area)=>lang==="es"?AREA_CONFIG[area]?.labelEs:AREA_CONFIG[area]?.label;
  const allDocs = Object.values(projects).flatMap(p=>p.docs||[]);

  const setLang=(l)=>{
    setLangState(l);
    if(user&&messages.length<=1){
      const tN=LANG[l];
      let w=user.role==="admin"?tN.welcomeAdmin(user.name,Object.keys(projects).length):user.role==="client"?tN.welcomeClient(user.name):tN.welcomeInternal(user.name,l==="es"?AREA_CONFIG[user.area]?.labelEs:AREA_CONFIG[user.area]?.label);
      setMessages([{role:"assistant",content:w}]);
    }
  };

  const testKey=async()=>{
    if(!keyInput.trim())return;
    setKeyTesting(true);setKeyError("");
    try{await callGroq({apiKey:keyInput.trim(),system:"Reply: OK",messages:[{role:"user",content:"ping"}],maxTokens:5});setGroqKey(keyInput.trim());}
    catch{setKeyError("Invalid key. Check console.groq.com");}
    finally{setKeyTesting(false);}
  };

  const login=async(e)=>{
    e.preventDefault();
    const u=USERS[loginForm.u.toLowerCase()];
    if(u&&u.password===loginForm.p){
      setUser(u);if(u.projectId)setActive(u.projectId);setView("dashboard");
      const activePid=u.projectId||localStorage.getItem("sentinel_last_pid")||activeProject;
      let w=u.role==="admin"?t.welcomeAdmin(u.name,Object.keys(projects).length):u.role==="client"?t.welcomeClient(u.name):t.welcomeInternal(u.name,getAreaLabel(u.area));

      // ── Cargar historial PRIVADO de este usuario ──────────────
      // loadChatHistory busca en Supabase (chat_sessions) con fallback localStorage
      // La clave incluye userId → cada usuario tiene su propia memoria
      const prevMsgs = await loadChatHistory(activePid, u.id);

      if(prevMsgs.length>0&&groqKey){
        // Hay historial — pedir a la AI un briefing proactivo de lo que pasó
        setMessages([{role:"assistant",content:w},{role:"assistant",content:`⏳ _Analizando tu historial y las integraciones conectadas..._`}]);
        try{
          const proj=projects[activePid];
          const clickupDoc=proj?.docs?.find(d=>d.source==="clickup");
          const slackDoc=proj?.docs?.find(d=>d.source==="slack");
          const intCtx=[clickupDoc&&`ClickUp: ${clickupDoc.content.slice(0,800)}`,slackDoc&&`Slack: ${slackDoc.content.slice(0,800)}`].filter(Boolean).join("\n");
          const histText=prevMsgs.slice(-10).map(m=>`${m.role==="user"?"USER":"SENTINEL"}: ${m.content.slice(0,200)}`).join("\n");
          const briefingPrompt=`El usuario ${u.name} (${u.role}) acaba de iniciar sesión. Basándote en el historial de conversación anterior y los datos de integraciones, generá un briefing ejecutivo breve (máximo 4 puntos) que responda: ¿Qué se habló/decidió la última vez? ¿Hay algo nuevo en las apps conectadas que deba saber? ¿Hay riesgos o cambios pendientes?\n\nHISTORIAL PREVIO:\n${histText}\n\nINTEGRACIONES ACTUALES:\n${intCtx||"No hay integraciones sincronizadas aún."}\n\nProyecto activo: ${proj?.name||activePid} | Health: ${proj?.health||"?"}% | Status: ${proj?.status||"?"}`;
          // ── IDIOMA: sigue el setting actual de la UI (lang variable) ──
          const uiLang = lang; // "en" o "es" — viene del toggle de idioma
          const langInstruction = uiLang === "es"
            ? "Respondé SIEMPRE en español. Nunca uses inglés."
            : "ALWAYS respond in English. Never use Spanish.";
          const briefing=await callGroq({apiKey:groqKey,system:`You are Sentinel, an executive management brain. ${langInstruction} Be concise. Use **bold** for key points.`,messages:[{role:"user",content:briefingPrompt}],maxTokens:500});
          // La UI muestra solo el briefing — limpia y ejecutiva
          // El historial completo vive en buildSystem (contexto invisible para la AI)
          setMessages([{role:"assistant",content:w},{role:"assistant",content:`🧠 **Briefing:**\n\n${briefing}`}]);
        }catch{
          setMessages([{role:"assistant",content:w},{role:"assistant",content:`📂 _Retomando tu última sesión. Preguntame lo que necesités._`}]);
        }
      } else {
        setMessages([{role:"assistant",content:w}]);
      }
    }else{setLoginErr(t.wrongCredentials);}
  };

  // ── CLICKUP SYNC ───────────────────────────────────────────
  // ── CLICKUP SYNC ──────────────────────────────────────────────────────────
  // Soporta dos modos:
  //   1. FOLDER MODE: sincroniza todas las listas del folder (recomendado para demo)
  //   2. LIST MODE:   sincroniza una lista específica (modo legacy)
  // Para cambiar de modo, el usuario puede pegar un Folder ID o un List ID.
  const syncClickUp=async()=>{
    if(!cuToken){alert(lang==="es"?"Configurá el token de ClickUp primero":"Configure ClickUp token first");return;}
    setCuSyncing(true);
    try{
      let tasks=[], listsInfo=[];

      if(cuFolderId){
        // FOLDER MODE — trae todas las listas del folder de una vez
        const result = await getClickUpFolderTasks(cuToken, cuFolderId);
        tasks = result.tasks;
        listsInfo = result.lists;
        setCuSyncedLists(listsInfo);
      } else if(cuListId) {
        // LIST MODE — una sola lista
        tasks = await getClickUpTasks(cuToken, cuListId);
      } else {
        alert("Enter a Folder ID or select a List"); return;
      }

      setCuTasks(tasks);
      setCuLastSync(new Date());

      // ── STEP 2: Formatear como texto legible para la AI ──────────
      // Agrupado por lista para que la AI entienda la estructura
      const byList = {};
      tasks.forEach(tk => {
        const list = tk.listName || "General";
        if (!byList[list]) byList[list] = [];
        byList[list].push(tk);
      });

      const tasksSummary = Object.entries(byList).map(([listName, listTasks]) => {
        const taskLines = listTasks.map(tk => {
          const status = tk.status?.status?.toUpperCase() || "?";
          const due = tk.due_date ? new Date(parseInt(tk.due_date)).toLocaleDateString() : "no date";
          const assignee = tk.assignees?.[0]?.username || "unassigned";
          const priority = tk.priority?.priority || "normal";
          return `  [${status}][${priority}] ${tk.name} | Due: ${due} | ${assignee}`;
        }).join("\n");
        return `LIST: ${listName} (${listTasks.length} tasks)\n${taskLines}`;
      }).join("\n\n");

      const content = [
        `Lists synced: ${listsInfo.map(l=>l.name).join(", ") || "1 list"}`,
        `Total tasks: ${tasks.length}`,
        `Overdue: ${tasks.filter(tk => tk.due_date && parseInt(tk.due_date) < Date.now() && !["complete","closed"].includes(tk.status?.status)).length}`,
        `In progress: ${tasks.filter(tk => tk.status?.status === "in progress").length}`,
        `Open/blocked: ${tasks.filter(tk => ["open","blocked"].includes(tk.status?.status)).length}`,
        "",
        tasksSummary,
      ].join("\n");

      // ── STEP 3: Inject usando el patrón estándar ─────────────────
      // injectIntegrationDoc() guarda el doc en el proyecto activo
      // y lo persiste en Supabase para que la AI lo tenga siempre fresco
      await injectIntegrationDoc(pid, "clickup", "ClickUp Tasks", content, setProjects);

    } catch(err) { alert(`ClickUp sync error: ${err.message}`); }
    finally { setCuSyncing(false); }
  };

  const loadSpaces=async()=>{
    if(!cuToken||!cuTeamId)return;
    try{const spaces=await getClickUpSpaces(cuToken,cuTeamId);setCuSpaces(spaces);}
    catch(err){console.error(err);}
  };

  const loadLists=async(spaceId)=>{
    if(!cuToken||!spaceId)return;
    try{const lists=await getClickUpLists(cuToken,spaceId);setCuLists(lists);}
    catch(err){console.error(err);}
  };

  // ════════════════════════════════════════════════════════════════════════
  // AUTO-SYNC SILENCIOSO — se ejecuta al entrar al chat
  // ════════════════════════════════════════════════════════════════════════
  // Cuando el usuario navega al AI Chat, Sentinel sincroniza automáticamente
  // todas las integraciones configuradas. El usuario no ve nada — la AI
  // simplemente ya tiene los datos más frescos cuando responde.
  //
  // Para agregar una nueva integración al auto-sync:
  //   1. Obtener el token de la app (ya guardado en config)
  //   2. Llamar al fetcher de la app
  //   3. Llamar a injectIntegrationDoc()
  // ════════════════════════════════════════════════════════════════════════
  const autoSyncIntegrations = useCallback(async () => {
    if (!cuToken) return; // No hay token configurado, nada que sincronizar

    try {
      // ── AUTO-SYNC CLICKUP ─────────────────────────────────────
      // Si hay un folder o lista configurada, sincroniza silenciosamente
      if (cuFolderId || cuListId) {
        let tasks = [], listsInfo = [];

        if (cuFolderId) {
          const result = await getClickUpFolderTasks(cuToken, cuFolderId);
          tasks = result.tasks;
          listsInfo = result.lists;
          setCuSyncedLists(listsInfo);
        } else {
          tasks = await getClickUpTasks(cuToken, cuListId);
        }

        setCuTasks(tasks);
        setCuLastSync(new Date());

        // Formatear y guardar (mismo formato que el sync manual)
        const byList = {};
        tasks.forEach(tk => {
          const list = tk.listName || "General";
          if (!byList[list]) byList[list] = [];
          byList[list].push(tk);
        });

        const tasksSummary = Object.entries(byList).map(([listName, listTasks]) =>
          `LIST: ${listName} (${listTasks.length} tasks)
` +
          listTasks.map(tk =>
            `  [${tk.status?.status?.toUpperCase()||"?"}] ${tk.name}` +
            ` | Due: ${tk.due_date ? new Date(parseInt(tk.due_date)).toLocaleDateString() : "no date"}` +
            ` | ${tk.assignees?.[0]?.username || 'unassigned'}`
          ).join("
")
        ).join("

");

        const content = [
          `Lists: ${listsInfo.map(l=>l.name).join(", ") || "1 list"}`,
          `Total: ${tasks.length} tasks`,
          `Overdue: ${tasks.filter(tk => tk.due_date && parseInt(tk.due_date) < Date.now() && !["complete","closed"].includes(tk.status?.status)).length}`,
          `In progress: ${tasks.filter(tk => tk.status?.status === "in progress").length}`,
          `Open: ${tasks.filter(tk => tk.status?.status === "open").length}`,
          "",
          tasksSummary,
        ].join("
");

        await injectIntegrationDoc(pid, "clickup", "ClickUp Auto-Sync", content, setProjects);
      }

      // ── AUTO-SYNC SLACK ───────────────────────────────────────
      // Slack se sincroniza via SlackConnector component (ya implementado)
      // Para auto-sync de Slack, el token se guarda en localStorage

      // ── AGREGAR OTRAS INTEGRACIONES ACÁ ──────────────────────
      // Ejemplo Notion (cuando tengas el token):
      //   const notionToken = await dbLoadConfig("notion_token");
      //   const notionDbId  = await dbLoadConfig("notion_db_id");
      //   if (notionToken && notionDbId) {
      //     const pages = await fetchNotion(notionToken, notionDbId);
      //     const text  = pages.map(p => p.title + ": " + p.content).join("
");
      //     await injectIntegrationDoc(pid, "notion", "Notion Pages", text, setProjects);
      //   }

    } catch (err) {
      console.warn("Auto-sync error (non-critical):", err.message);
      // Auto-sync falla silenciosamente — no interrumpe al usuario
    }
  }, [cuToken, cuFolderId, cuListId, pid]);

  // Ejecutar auto-sync cada vez que el usuario navega al chat
  useEffect(() => {
    if (view === "chat" && user && groqKey) {
      autoSyncIntegrations();
    }
  }, [view, user?.id, pid]); // Se re-ejecuta al cambiar de proyecto o usuario

  // ════════════════════════════════════════════════════════════════════════
  // BUILD SYSTEM — El cerebro de Sentinel
  // ════════════════════════════════════════════════════════════════════════
  // Esta función arma el "system prompt" que recibe la AI antes de responder.
  // Todo lo que Sentinel "sabe" viene de acá:
  //   - Estado del proyecto activo (health, status, tickets)
  //   - Documentos subidos (PDFs, CSVs, notas manuales)
  //   - Datos de integraciones (ClickUp tasks, Slack messages)
  //   - Historial de sesiones previas (memoria del usuario)
  //
  // Para que la AI sepa algo nuevo → agregalo acá como string al contextParts array.
  // ════════════════════════════════════════════════════════════════════════
  const buildSystem=useCallback(()=>{
    const proj=projects[pid];
    const today=new Date().toLocaleString();

    // ── DOCS DEL PROYECTO ACTIVO ──────────────────────────────
    const projDocs=proj?.docs?.length
      ? proj.docs.map(d=>`=== ${d.name} [${d.source||d.type}] ===\n${d.content.slice(0,2500)}`).join("\n\n")
      : null;

    // ── DOCS DE OTROS PROYECTOS (admin) ───────────────────────
    const allProjectsDocs=user?.role==="admin"
      ? Object.values(projects)
          .filter(p=>p.id!==pid)
          .flatMap(p=>(p.docs||[]).map(d=>`[${p.name}] ${d.name} (${d.source||d.type}): ${d.content.slice(0,500)}`))
          .join("\n")
      : null;

    // ── INTEGRACIONES CONECTADAS ──────────────────────────────
    // Busca todos los docs que vienen de integraciones (source != "upload" y != "manual")
    // Cada integración agrega su doc via injectIntegrationDoc()
    // La AI ve TODOS los datos de todas las integraciones conectadas
    const integrationSources = ["clickup", "slack", "notion", "gsheets", "github", "gitlab"];
    const integrations = integrationSources
      .map(source => {
        const doc = proj?.docs?.find(d => d.source === source);
        if (!doc) return null;
        return `=== ${source.toUpperCase()} DATA ===
${doc.content.slice(0, 2000)}`;
      })
      .filter(Boolean);

    // Fallback: si hay tareas en memoria de React pero no hay doc guardado
    if (integrations.length === 0 && cuTasks.length > 0) {
      const tasksSummary = cuTasks.slice(0, 30).map(tk =>
        `[${tk.status?.status?.toUpperCase()}] ${tk.name} | Due: ${tk.due_date ? new Date(parseInt(tk.due_date)).toLocaleDateString() : "?"} | ${tk.assignees?.[0]?.username || "?"}`
      ).join("\n");
      integrations.push(`=== CLICKUP TASKS (in memory) ===\n${tasksSummary}`);
    }

    // ── HISTORIAL DE SESIONES PREVIAS (contexto invisible para la AI) ──
    // Lee del localStorage que saveChatHistory mantiene actualizado.
    // Este historial NO se muestra en pantalla — solo lo ve la AI.
    let sessionMemory=null;
    try{
      const savedRaw=localStorage.getItem(`sentinel_chat_${pid}_${user?.id}`);
      if(savedRaw){
        const savedMsgs=JSON.parse(savedRaw);
        if(Array.isArray(savedMsgs)&&savedMsgs.length>0){
          const historyText=savedMsgs.slice(-15).map(m=>`${m.role==="user"?"USER":"SENTINEL"}: ${m.content.slice(0,300)}`).join("\n");
          sessionMemory=`=== PREVIOUS SESSION HISTORY ===\n${historyText}\n=== END HISTORY ===`;
        }
      }
    }catch{}

    // ── ESTADO DEL PROYECTO ───────────────────────────────────
    const projStatus=proj?`Proyecto activo: ${proj.name} | Cliente: ${proj.client} | Salud: ${proj.health}% | Estado: ${proj.status} | Tickets abiertos: ${(proj.tickets||[]).filter(tk=>tk.status==="open").length}`:null;

    // ── ENSAMBLAR CONTEXTO COMPLETO ───────────────────────────
    const contextParts=[
      projStatus,
      projDocs,
      allProjectsDocs&&`=== OTROS PROYECTOS ===\n${allProjectsDocs}`,
      integrations.length>0&&`=== INTEGRACIONES CONECTADAS ===\n${integrations.join("\n\n")}`,
      sessionMemory,
    ].filter(Boolean).join("\n\n") || null;

    // ── INSTRUCCIONES BASE + IDIOMA ──────────────────────────────
    // El idioma sigue el setting de la UI. Si está en EN → responde en inglés.
    // Agregá más integraciones al contexto acá abajo (Notion, Google Drive, etc.)
    const uiLanguage = lang === "es"
      ? "SIEMPRE respondé en español. Nunca uses inglés."
      : "ALWAYS respond in English only. Never use Spanish or any other language.";
    const metaInstructions=`\nToday: ${today}.\n${uiLanguage}\n` +
    `You are Sentinel — a 360 management brain, NOT a chatbot.\n` +
    `CRITICAL RULES:\n` +
    `1. ALWAYS use the integration data above (ClickUp, Slack, etc.) to answer questions about tasks, tickets, or project status. The data is LIVE and FRESH.\n` +
    `2. If asked "any new tickets?" or "what changed?", look at the ClickUp data above and list specific tasks by name, status, and due date.\n` +
    `3. If ClickUp data shows overdue tasks, proactively alert the user even if not asked.\n` +
    `4. Reference previous conversation history when relevant.\n` +
    `5. Never say "I don't have access" — you have all the data above.\n` +
    `6. Be executive and direct. No filler sentences.`;

    if(!user)return"You are Sentinel AI.";
    if(user.role==="client")return t.sysClient(proj?.name,user.name,contextParts)+metaInstructions;
    if(user.role==="admin"){
      const allP=Object.values(projects).map(p=>`- ${p.name} (${p.client}): health ${p.health}%, status ${p.status}, docs: ${p.docs?.length||0}, tickets abiertos: ${(p.tickets||[]).filter(tk=>tk.status==="open").length}`).join("\n");
      return t.sysAdmin(allP,contextParts)+metaInstructions;
    }
    return(t.sysInternal[user.area]||"You are Sentinel AI.")+(contextParts?`\nCONTEXT:\n${contextParts}`:"")+metaInstructions;
  },[projects,pid,user,t,cuTasks]);

  const send=async()=>{
    if(!input.trim()||loading||escalated)return;
    const msg=input.trim();setInput("");
    const newMsgs=[...messages,{role:"user",content:msg}];
    setMessages(newMsgs);setLoading(true);
    try{
      const reply=await callGroq({apiKey:groqKey,system:buildSystem(),messages:newMsgs.map(m=>({role:m.role,content:m.content}))});
      if(reply.startsWith("ESCALAR_N2")){
        const summary=reply.replace("ESCALAR_N2","").trim();
        const tkt=makeTicket(summary,newMsgs);
        setMessages(p=>[...p,{role:"assistant",content:`⚠️ **${lang==="es"?"Caso escalado al equipo N2":"Case escalated to N2"}**\n\n${summary}\n\nTicket: **${tkt.id}**`,escalated:true}]);
        setEscalated(true);
      } else {
        // Auto-detect ticket creation from chat and save it
        const ticketMatch = reply.match(/Ticket ID[:\s]+([A-Z0-9\-]+)/i);
        if(ticketMatch && /create.*ticket|ticket.*create|nuevo ticket/i.test(msg)){
          const tkt=makeTicket(msg, newMsgs);
          setMessages(p=>[...p,{role:"assistant",content:reply+`\n\n✅ Ticket **${tkt.id}** saved to project.`}]);
        } else {
          setMessages(p=>[...p,{role:"assistant",content:reply}]);
        }
      }
      // ── Guardar historial privado por usuario+proyecto ──────────
      // saveChatHistory guarda en Supabase chat_sessions + localStorage
      const convToSave=[...newMsgs,{role:"assistant",content:reply}].slice(-30);
      saveChatHistory(pid, user?.id, convToSave).catch(console.error);
    }catch(err){setMessages(p=>[...p,{role:"assistant",content:`❌ Error: ${err.message}`,error:true}]);}
    finally{setLoading(false);inputRef.current?.focus();}
  };

  const makeTicket=(summary,conv)=>{
    const tkt={id:"TKT-"+String(Date.now()).slice(-4),projectId:pid,summary,conversation:[...conv],status:"open",severity:"high",createdAt:new Date().toISOString()};
    const updated={...projects[pid],tickets:[...(projects[pid]?.tickets||[]),tkt]};
    setProjects(p=>({...p,[pid]:updated}));
    if(DB_ENABLED) dbSaveProject(updated).catch(console.error);
    return tkt;
  };

  const createTicketFromAnomaly=(anomaly)=>{
    const tkt={id:"TKT-"+String(Date.now()).slice(-4),projectId:pid,summary:`[${anomaly.type?.toUpperCase()}] ${anomaly.title}: ${anomaly.detail}`,conversation:[{role:"user",content:anomaly.detail},{role:"assistant",content:`Suggested action: ${anomaly.action}`}],status:"open",severity:anomaly.severity,createdAt:new Date().toISOString()};
    setProjects(p=>({...p,[pid]:{...p[pid],tickets:[...(p[pid]?.tickets||[]),tkt]}}));
    setView("tickets");
  };

  const resolveTicket=(tId,res)=>{
    const updatedTickets=projects[pid].tickets.map(tk=>tk.id===tId?{...tk,status:"resolved",resolution:res,resolvedAt:new Date().toISOString()}:tk);
    const updated={...projects[pid],tickets:updatedTickets};
    setProjects(p=>({...p,[pid]:updated}));
    if(DB_ENABLED) dbSaveProject(updated).catch(console.error);
    setSelectedTkt(null);
  };
  const suggestReply=async(tkt)=>{
    setLoading(true);
    try{const conv=tkt.conversation.map(m=>`${m.role==="user"?"CLIENT":"AI"}: ${m.content}`).join("\n");const r=await callGroq({apiKey:groqKey,system:"Senior tech agent. Reply concisely.",messages:[{role:"user",content:`Reply for ticket.\nISSUE: ${tkt.summary}\nCONV:\n${conv}`}],maxTokens:400});setTktReply(r);}
    finally{setLoading(false);}
  };
  const uploadFiles=async(files)=>{
    for(const file of Array.from(files)){
      const parsed=await parseFile(file);
      const doc={id:String(Date.now()+Math.random()),...parsed,source:"upload",uploadedAt:new Date().toISOString().split("T")[0]};
      setProjects(p=>({...p,[pid]:{...p[pid],docs:[...(p[pid]?.docs||[]),doc]}}));
      if(DB_ENABLED) dbSaveDoc(doc,pid).catch(console.error);
    }
  };
  const addUrl=()=>{
    if(!urlInput.trim())return;
    const doc={id:String(Date.now()),name:urlInput,type:"url",source:"url",content:`[URL: ${urlInput}]\nThis is a linked resource. When asked about this URL, refer to it by name and suggest the user check it directly.`,uploadedAt:new Date().toISOString().split("T")[0]};
    setProjects(p=>({...p,[pid]:{...p[pid],docs:[...(p[pid]?.docs||[]),doc]}}));
    if(DB_ENABLED) dbSaveDoc(doc,pid).catch(console.error);
    setUrlInput("");
  };
  const addScript=()=>{if(!scriptTxt.trim())return;const doc={id:String(Date.now()),name:lang==="es"?"Entrada Manual":"Manual Entry",type:"text",source:"manual",content:scriptTxt,uploadedAt:new Date().toISOString().split("T")[0]};setProjects(p=>({...p,[pid]:{...p[pid],docs:[...(p[pid]?.docs||[]),doc]}}));if(DB_ENABLED)dbSaveDoc(doc,pid).catch(console.error);setScriptTxt("");};
  // DB-aware project updater
  const saveProject = (proj) => {
    setProjects(p=>({...p,[proj.id]:proj}));
    if(DB_ENABLED) dbSaveProject(proj).catch(console.error);
  };

  const createProject=(proj)=>{
    setProjects(p=>({...p,[proj.id]:proj}));
    setActive(proj.id);setView("data");
    if(DB_ENABLED) dbSaveProject(proj).catch(console.error);
  };
  const deleteProject=(projId)=>{
    if(!window.confirm(t.deleteConfirm)) return;
    setProjects(p=>{const n={...p};delete n[projId];return n;});
    if(DB_ENABLED) dbDeleteProject(projId).catch(console.error);
    // Recordar demos borrados para no re-insertarlos al recargar
    try{
      const deleted=JSON.parse(localStorage.getItem("sentinel_deleted_demos")||"[]");
      if(!deleted.includes(projId)) deleted.push(projId);
      localStorage.setItem("sentinel_deleted_demos",JSON.stringify(deleted));
    }catch{}
    const remaining=Object.keys(projects).filter(k=>k!==projId);
    if(remaining.length>0) setActive(remaining[0]);
    else setActive("");
  };

  const allTickets=Object.values(projects).flatMap(p=>(p.tickets||[]).map(tk=>({...tk,projectName:p.name})));
  const visibleProjects=user?.role==="client"?[projects[user.projectId]].filter(Boolean):Object.values(projects);

  // ── SCREENS ───────────────────────────────────────────────
  if(!groqKey) return (
    <div style={S.bg}>
      <div style={S.authCard}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:22}}>
          <div style={{display:"flex",alignItems:"center",gap:12}}><div style={S.logoBox}>S</div><div><div style={S.logoTitle}>SENTINEL</div><div style={{fontSize:11,color:"#475569"}}>{t.platform}</div></div></div>
          <LangToggle lang={lang} setLang={setLangState}/>
        </div>
        <div style={{background:"#1a1205",border:"1px solid #78350f",borderRadius:10,padding:"12px 14px",marginBottom:18}}>
          <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:4}}><I.Zap/><strong style={{color:"#fbbf24",fontSize:13}}>{t.groqFree}</strong></div>
          <div style={{fontSize:12,color:"#94a3b8"}}>{t.groqDesc}</div>
        </div>
        <div style={{display:"flex",flexDirection:"column",gap:8}}>
          <label style={S.label}><I.Key/> &nbsp;{t.apiKeyLabel}</label>
          <input style={S.input} placeholder="gsk_xxxxxxxxxxxxxxxxxxxx" value={keyInput} onChange={e=>setKeyInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&testKey()} type="password"/>
          {keyError&&<div style={S.err}>{keyError}</div>}
          <button onClick={testKey} disabled={keyTesting||!keyInput.trim()} style={S.bigBtn}>{keyTesting?t.connecting:t.connectBtn}</button>
        </div>
        <div style={{background:"#1e293b",borderRadius:10,padding:14,marginTop:16}}>
          <div style={S.label}>{t.howToKey}</div>
          {t.keySteps.map(([n,...rest],i)=>(
            <div key={i} style={{display:"flex",gap:8,alignItems:"flex-start",marginBottom:8}}>
              <div style={{width:18,height:18,borderRadius:"50%",background:"#4f46e5",color:"white",fontSize:10,fontWeight:800,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>{i+1}</div>
              <div style={{fontSize:12,color:"#94a3b8"}}>{n} {rest[1]&&<a href={rest[1]} target="_blank" rel="noreferrer" style={{color:"#818cf8"}}>{rest[0]}</a>}</div>
            </div>
          ))}
        </div>
        <div style={{fontSize:10,color:"#475569",textAlign:"center",marginTop:10}}>{t.keyNote}</div>
      </div>
    </div>
  );

  if(!user) return (
    <div style={S.bg}>
      <div style={{...S.authCard,maxWidth:400}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
          <div style={{display:"flex",alignItems:"center",gap:12}}><div style={S.logoBox}>S</div><div><div style={S.logoTitle}>SENTINEL</div><div style={{fontSize:11,color:"#10b981"}}>● {t.groqConnected}</div></div></div>
          <LangToggle lang={lang} setLang={setLangState}/>
        </div>
        <form onSubmit={login} style={{display:"flex",flexDirection:"column",gap:10}}>
          <div><label style={S.label}>{t.usernameLabel}</label><input style={S.input} placeholder={t.userPlaceholder} value={loginForm.u} onChange={e=>setLoginForm(f=>({...f,u:e.target.value}))}/></div>
          <div><label style={S.label}>{t.passwordLabel}</label><input style={S.input} type="password" placeholder="••••••••" value={loginForm.p} onChange={e=>setLoginForm(f=>({...f,p:e.target.value}))}/></div>
          {loginErr&&<div style={S.err}>{loginErr}</div>}
          <button type="submit" style={S.bigBtn}>{t.signIn}</button>
        </form>
        <div style={{background:"#1e293b",borderRadius:10,padding:14,marginTop:14}}>
          <div style={{...S.label,marginBottom:10}}>{t.demoAccounts}</div>
          {t.demoList.map(([c,u,p,desc])=>(
            <div key={u} style={{display:"flex",gap:8,alignItems:"center",marginBottom:5,cursor:"pointer"}} onClick={()=>setLoginForm({u,p})}>
              <span style={{background:c,color:"white",fontSize:9,fontWeight:800,padding:"1px 6px",borderRadius:3,minWidth:52,textAlign:"center"}}>{u}</span>
              <span style={{fontSize:11,color:"#64748b"}}>{p} — {desc}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );

  const navItems=[
    {key:"dashboard",label:t.dashboard,   Icon:I.Home},
    {key:"chat",     label:t.aiChat,      Icon:I.Bot},
    {key:"monitor",  label:t.monitorNav,  Icon:I.Eye},
    ...(user.role!=="client"?[{key:"data",label:t.dataSources,Icon:I.Upload}]:[]),
    ...(user.role!=="client"?[{key:"tickets",label:t.tickets,Icon:I.Ticket}]:[]),
    ...(user.role==="admin"?[{key:"admin",label:t.adminNav,Icon:I.Settings}]:[]),
  ];

  return (
    <div style={S.app}>
      {showNewProj&&<NewProjectModal t={t} lang={lang} onClose={()=>setShowNewProj(false)} onCreate={createProject}/>}

      <aside style={S.sidebar}>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:16,paddingBottom:14,borderBottom:"1px solid #1e293b"}}>
          <div style={S.logoBox}>S</div>
          <div><div style={{fontWeight:800,fontSize:13,color:"#f1f5f9",letterSpacing:1}}>SENTINEL</div><div style={{fontSize:9,color:"#10b981"}}>● Groq · llama-3.3-70b</div></div>
        </div>
        <div style={{background:"#1e293b",borderRadius:8,padding:"8px 10px",marginBottom:12,fontSize:11}}>
          {user.role==="admin"&&<div style={{color:"#818cf8",fontWeight:700}}>⚡ {t.adminRole}</div>}
          {user.role==="internal"&&<div style={{color:AREA_CONFIG[user.area]?.color,fontWeight:700}}>{AREA_CONFIG[user.area]?.icon} {getAreaLabel(user.area)}</div>}
          {user.role==="client"&&<div style={{color:"#10b981",fontWeight:700}}>🏢 {t.clientPortal}</div>}
          <div style={{color:"#475569",marginTop:2}}>{user.name}</div>
        </div>
        {user.role!=="client"&&(
          <div style={{marginBottom:12}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",...S.label}}>
              <span>{t.activeProject}</span>
              {user.role==="admin"&&<button onClick={()=>setShowNewProj(true)} style={{...S.iconBtn,color:"#818cf8"}}><I.Plus/></button>}
            </div>
            <select value={activeProject} onChange={e=>{setActive(e.target.value);localStorage.setItem("sentinel_last_pid",e.target.value);}} style={S.select}>
              {Object.values(projects).map(p=><option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
        )}
        {/* ClickUp quick sync badge */}
        {cuToken&&(
          <div style={{background:"#1a1205",border:"1px solid #78350f",borderRadius:7,padding:"6px 10px",marginBottom:10,display:"flex",alignItems:"center",gap:6}}>
            <span style={{fontSize:10}}>🎯</span>
            <div style={{flex:1}}>
              <div style={{fontSize:10,fontWeight:700,color:"#fbbf24"}}>ClickUp</div>
              <div style={{fontSize:9,color:"#78350f"}}>{cuTasks.length} tasks · {cuLastSync?cuLastSync.toLocaleTimeString():"not synced"}</div>
            </div>
            <button onClick={syncClickUp} disabled={cuSyncing} style={{...S.iconBtn,color:"#f59e0b"}}>{cuSyncing?<Dots/>:<I.Refresh/>}</button>
          </div>
        )}
        <nav style={{flex:1,display:"flex",flexDirection:"column",gap:2}}>
          {navItems.map(({key,label,Icon})=>(
            <button key={key} onClick={()=>setView(key)} style={{...S.navBtn,...(view===key?S.navActive:{})}}>
              <Icon/><span>{label}</span>
            </button>
          ))}
        </nav>
        <div style={{paddingBottom:4}}>
          {DB_ENABLED && (
            <div style={{fontSize:9,color:dbSyncing?"#f59e0b":"#10b981",marginBottom:6,textAlign:"center"}}>
              {dbSyncing?"⟳ syncing...":"● storage ready"}
            </div>
          )}
          <LangToggle lang={lang} setLang={setLang}/>
        </div>
        <div style={{borderTop:"1px solid #1e293b",paddingTop:12,display:"flex",alignItems:"center",gap:8}}>
          <Avatar user={user}/>
          <div style={{flex:1}}><div style={{fontSize:12,fontWeight:600,color:"#e2e8f0"}}>{user.name}</div><div style={{fontSize:10,color:"#64748b",textTransform:"capitalize"}}>{user.role}{user.area?` · ${user.area}`:""}</div></div>
          <button onClick={()=>{setUser(null);setMessages([]);}} style={S.iconBtn}><I.Logout/></button>
        </div>
      </aside>

      <main style={S.main}>
        {/* DASHBOARD */}
        {view==="dashboard"&&(
          <div style={S.panel}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:22}}>
              <div>
                <h2 style={S.panelH}>{user.role==="admin"?t.agencyOverview:user.role==="client"?project?.name:getAreaLabel(user.area)}</h2>
                <p style={S.panelSub}>{user.role==="admin"?`${Object.keys(projects).length} ${t.activeProjectsSub}`:user.role==="client"?user.name:""}</p>
              </div>
              {user.role==="admin"&&<button onClick={()=>setShowNewProj(true)} style={{...S.smBtn,borderColor:"#4f46e5",color:"#818cf8"}}><I.Plus/> {t.newProject}</button>}
            </div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10,marginBottom:20}}>
              {user.role==="admin"&&<><MetricCard label={t.activeProjects} value={Object.keys(projects).length} sub={t.acrossClients}/><MetricCard label={t.avgHealth} value={`${Math.round(Object.values(projects).reduce((s,p)=>s+p.health,0)/Object.keys(projects).length)}%`} sub={t.portfolioScore} color="#10b981"/><MetricCard label={t.openTickets} value={allTickets.filter(tk=>tk.status==="open").length} sub={t.awaitingRes} color="#ef4444"/><MetricCard label={t.totalBudget} value={`$${(Object.values(projects).reduce((s,p)=>s+p.budget,0)/1000).toFixed(0)}k`} sub={t.underMgmt} color="#f59e0b"/></>}
              {user.role==="client"&&<><MetricCard label={t.projectHealth} value={`${project?.health}%`} sub={t.overallScore} color={project?.health>=80?"#10b981":"#f59e0b"}/><MetricCard label={t.milestonesDone} value={`${project?.milestones?.filter(m=>m.status==="done").length}/${project?.milestones?.length}`} sub={t.completed} color="#818cf8"/><MetricCard label={t.openTickets} value={project?.tickets?.filter(tk=>tk.status==="open").length||0} sub={t.awaitingRes} color="#ef4444"/><MetricCard label={t.budgetUsed} value={`${Math.round((project?.spent/project?.budget)*100)||0}%`} sub={`$${(project?.spent/1000).toFixed(0)}k / $${(project?.budget/1000).toFixed(0)}k`} color="#f59e0b"/></>}
              {user.role==="internal"&&user.area==="pm"&&<><MetricCard label={t.projectsTracked} value={visibleProjects.length} sub={t.allClients}/><MetricCard label={t.atRisk} value={visibleProjects.filter(p=>p.status==="at-risk").length} sub={t.needAttention} color="#ef4444"/><MetricCard label={t.milestonesDue} value={visibleProjects.flatMap(p=>p.milestones||[]).filter(m=>m.status==="in-progress").length} sub={t.thisMonth} color="#f59e0b"/><MetricCard label={t.teamMembers} value={[...new Set(visibleProjects.flatMap(p=>p.team||[]))].length} sub={t.activeDevs} color="#818cf8"/></>}
              {user.role==="internal"&&user.area==="finance"&&<><MetricCard label={t.totalBudgetLbl} value={`$${(visibleProjects.reduce((s,p)=>s+p.budget,0)/1000).toFixed(0)}k`} sub={t.contracted} color="#10b981"/><MetricCard label={t.totalSpent} value={`$${(visibleProjects.reduce((s,p)=>s+p.spent,0)/1000).toFixed(0)}k`} sub={t.toDate} color="#f59e0b"/><MetricCard label={t.remaining} value={`$${((visibleProjects.reduce((s,p)=>s+p.budget,0)-visibleProjects.reduce((s,p)=>s+p.spent,0))/1000).toFixed(0)}k`} sub={t.available} color="#818cf8"/><MetricCard label={t.avgBurnRate} value={`${Math.round(visibleProjects.reduce((s,p)=>s+(p.spent/p.budget*100)||0,0)/visibleProjects.length)}%`} sub={t.budgetConsumed} color="#ef4444"/></>}
              {user.role==="internal"&&(user.area==="hr"||user.area==="support")&&<><MetricCard label={t.teamSize} value={[...new Set(visibleProjects.flatMap(p=>p.team||[]))].length} sub={t.activeMembers}/><MetricCard label={t.openTickets} value={allTickets.filter(tk=>tk.status==="open").length} sub={t.awaitingRes} color="#ef4444"/><MetricCard label={t.projectsMonitored} value={visibleProjects.length} sub={t.monitored} color="#818cf8"/><MetricCard label={t.resolved} value={allTickets.filter(tk=>tk.status==="resolved").length} sub={t.thisPeriod} color="#10b981"/></>}
            </div>
            <div style={{display:"grid",gridTemplateColumns:user.role==="client"?"1fr":"repeat(auto-fill,minmax(290px,1fr))",gap:12}}>
              {visibleProjects.map(proj=>(
                <div key={proj.id} style={{...S.card,cursor:"pointer"}} onClick={()=>{setActive(proj.id);setView("chat");}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10}}>
                    <div><div style={{display:"flex",alignItems:"center",gap:8}}><div style={{width:10,height:10,borderRadius:"50%",background:proj.color}}/><span style={{fontWeight:700,fontSize:14,color:"#f1f5f9"}}>{proj.name}</span></div><div style={{fontSize:11,color:"#64748b",marginTop:2}}>{proj.client}</div></div>
                    <div style={{display:"flex",gap:4,alignItems:"center"}}>{proj.type&&<span style={{fontSize:9,color:"#475569"}}>{PROJECT_TEMPLATES[proj.type]?.icon}</span>}<StatusBadge status={proj.status} t={t}/></div>
                  </div>
                  <HealthBar value={proj.health} width={120}/>
                  <div style={{marginTop:10,display:"flex",gap:12,fontSize:11,color:"#64748b"}}>
                    <span>📋 {proj.milestones?.filter(m=>m.status==="done").length}/{proj.milestones?.length} {t.milestones}</span>
                    <span>👥 {proj.team?.length} {t.members}</span>
                    {proj.tickets?.filter(tk=>tk.status==="open").length>0&&<span style={{color:"#ef4444"}}>🎫 {proj.tickets.filter(tk=>tk.status==="open").length} {t.open}</span>}
                  </div>
                  <div style={{marginTop:10,display:"flex",flexDirection:"column",gap:4}}>{proj.milestones?.slice(0,3).map(m=><div key={m.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",fontSize:11}}><span style={{color:"#94a3b8"}}>{m.name}</span><StatusBadge status={m.status} t={t}/></div>)}</div>
                  {proj.activity?.length>0&&<div style={{marginTop:10,paddingTop:8,borderTop:"1px solid #1e293b"}}><div style={{fontSize:11,color:"#475569",marginBottom:4}}>{t.recentActivity}</div>{proj.activity.slice(0,2).map((a,i)=><div key={i} style={{fontSize:11,color:"#64748b",marginBottom:2}}><span style={{color:"#94a3b8"}}>{a.user}</span> · {a.text} · <span style={{color:"#475569"}}>{a.time}</span></div>)}</div>}
                  <div style={{marginTop:8,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                    <span style={{fontSize:11,color:"#4f46e5"}}>{t.askAI}</span>
                    {user.role==="admin"&&(
                      <div style={{display:"flex",gap:4,alignItems:"center"}}>
                        {proj.isDemo&&<span style={{fontSize:9,background:"#1e293b",color:"#475569",padding:"1px 5px",borderRadius:3,fontWeight:700}}>{t.demoTag}</span>}
                        <button onClick={e=>{e.stopPropagation();deleteProject(proj.id);}} style={{...S.iconBtn,color:"#ef4444",fontSize:10}} title={t.deleteProject}>✕</button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* MONITOR */}
        {view==="monitor"&&<MonitorView t={t} groqKey={groqKey} clickupTasks={cuTasks} projects={projects} allDocs={allDocs} onCreateTicket={createTicketFromAnomaly} lang={lang}/>}

        {/* CHAT */}
        {view==="chat"&&(
          <div style={{display:"flex",flexDirection:"column",height:"100%",overflow:"hidden"}}>
            <div style={{padding:"12px 20px",borderBottom:"1px solid #1e293b",background:"#0d1526",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <div><div style={{fontWeight:700,fontSize:14,color:"#f1f5f9"}}>{user.role==="internal"?getAreaLabel(user.area):project?.name}</div><div style={{fontSize:11,color:"#64748b",marginTop:1}}>{project?.docs?.length||0} {t.docsIndexed} · {messages.length} {t.turns}{cuTasks.length>0?` · ${cuTasks.length} ClickUp tasks`:""}</div></div>
              <button onClick={()=>{setMessages([{role:"assistant",content:t.chatRestart}]);setEscalated(false);}} style={S.smBtn}>{t.newChat}</button>
            </div>
            <div style={{flex:1,overflowY:"auto",padding:"18px 20px",display:"flex",flexDirection:"column",gap:10}}>
              {messages.map((m,i)=>(
                <div key={i} style={{display:"flex",justifyContent:m.role==="user"?"flex-end":"flex-start",gap:6,alignItems:"flex-end"}}>
                  {m.role==="assistant"&&<div style={{width:26,height:26,borderRadius:"50%",background:m.escalated?"#7f1d1d":"#312e81",display:"flex",alignItems:"center",justifyContent:"center",color:"white",flexShrink:0}}>{m.escalated?<I.Alert/>:<I.Bot/>}</div>}
                  <div style={{maxWidth:"72%",padding:"9px 13px",borderRadius:12,fontSize:13,lineHeight:1.65,...(m.role==="user"?{background:"#4f46e5",color:"white",borderBottomRightRadius:3}:{background:"#1e293b",color:"#e2e8f0",border:"1px solid #334155",borderBottomLeftRadius:3}),...(m.escalated?{borderColor:"#dc2626"}:{}),...(m.error?{color:"#fca5a5"}:{})}}><MD text={m.content} color={m.role==="user"?"white":m.error?"#fca5a5":"#e2e8f0"}/></div>
                  {m.role==="user"&&<div style={{width:26,height:26,borderRadius:"50%",background:"#1e3a5f",display:"flex",alignItems:"center",justifyContent:"center",color:"white",flexShrink:0}}><I.User/></div>}
                </div>
              ))}
              {loading&&<div style={{display:"flex",gap:6,alignItems:"flex-end"}}><div style={{width:26,height:26,borderRadius:"50%",background:"#312e81",display:"flex",alignItems:"center",justifyContent:"center",color:"white"}}><I.Bot/></div><div style={{background:"#1e293b",border:"1px solid #334155",borderRadius:12,borderBottomLeftRadius:3,padding:"9px 13px"}}><Dots/></div></div>}
              <div ref={bottomRef}/>
            </div>
            <div style={{padding:"12px 20px",borderTop:"1px solid #1e293b",background:"#0d1526",display:"flex",gap:8}}>
              {escalated?<div style={{flex:1,textAlign:"center",color:"#f87171",fontSize:13,fontWeight:600}}>⚠️ {t.escalatedWarning}</div>:<>
                <textarea ref={inputRef} rows={2} style={{flex:1,background:"#1e293b",border:"1px solid #334155",borderRadius:10,padding:"9px 12px",color:"#f1f5f9",fontSize:13,resize:"none",fontFamily:"inherit",outline:"none"}} value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();send();}}} placeholder={t.chatPlaceholder(user.role==="client"?project?.name:user.role==="admin"?(lang==="es"?"todos los proyectos":"all projects"):getAreaLabel(user.area))}/>
                <button onClick={send} disabled={loading||!input.trim()} style={{background:"#4f46e5",border:"none",borderRadius:10,padding:"9px 14px",color:"white",cursor:"pointer",display:"flex",alignItems:"center"}}><I.Send/></button>
              </>}
            </div>
          </div>
        )}

        {/* DATA SOURCES */}
        {view==="data"&&user.role!=="client"&&(
          <div style={S.panel}>
            <div style={{marginBottom:18}}><h2 style={S.panelH}>{t.dataSourcesTitle}</h2><p style={S.panelSub}>{t.dataSourcesSub}</p></div>
            {user.role==="admin"&&<div style={{display:"flex",gap:8,alignItems:"center",marginBottom:16}}><span style={S.label}>{t.projectLabel}</span><select value={activeProject} onChange={e=>{setActive(e.target.value);localStorage.setItem("sentinel_last_pid",e.target.value);}} style={S.select}>{Object.values(projects).map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></div>}

            {/* ClickUp real connector */}
            <div style={{...S.card,marginBottom:16,borderColor:cuTasks.length>0?"#166534":cuToken?"#1e3a5f":"#334155"}}>
              <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12}}>
                <span style={{fontSize:20}}>🎯</span>
                <div>
                  <div style={{fontSize:13,fontWeight:700,color:"#e2e8f0"}}>ClickUp — Live Connection</div>
                  <div style={{fontSize:11,color:"#64748b"}}>
                    {cuTasks.length>0
                      ? `${cuTasks.length} tasks synced from ${cuSyncedLists.length||1} list(s)`
                      : "Connect to sync all your ClickUp tasks"}
                  </div>
                </div>
                {cuTasks.length>0&&<div style={{marginLeft:"auto",width:8,height:8,borderRadius:"50%",background:"#10b981"}}/>}
              </div>
              <div style={{display:"flex",flexDirection:"column",gap:8}}>
                <div>
                  <label style={S.label}>API Token (pk_...)</label>
                  <input style={S.input} type="password" placeholder="pk_72869169_..." value={cuToken}
                    onChange={e=>{const v=e.target.value;setCuToken(v);localStorage.setItem("sentinel_cu_token",v);if(DB_ENABLED)dbSaveConfig("cu_token",v).catch(console.error);}}/>
                </div>
                <div>
                  <label style={S.label}>Folder ID — sync all lists at once</label>
                  <input style={S.input} placeholder="901317793533 (from ClickUp folder URL)"
                    value={cuFolderId}
                    onChange={e=>{const v=e.target.value;setCuFolderId(v);localStorage.setItem("sentinel_cu_folder",v);}}/>
                  <div style={{fontSize:10,color:"#475569",marginTop:3}}>
                    Find it in the URL when you click a folder: app.clickup.com/.../f/FOLDER_ID
                  </div>
                </div>
                <div style={{display:"flex",gap:8,alignItems:"center"}}>
                  <button onClick={syncClickUp} disabled={cuSyncing||!cuToken} style={{...S.smBtn,borderColor:"#7c3aed",color:"#a78bfa",flex:1,justifyContent:"center"}}>
                    {cuSyncing?<><Dots/> Syncing all lists...</>:<><I.Refresh/> Sync All Lists</>}
                  </button>
                </div>
                {cuLastSync&&(
                  <div style={{fontSize:11,color:"#10b981"}}>
                    ✓ Synced {cuLastSync.toLocaleString()} · {cuTasks.length} tasks
                    {cuSyncedLists.length>0&&<span style={{color:"#64748b"}}> from: {cuSyncedLists.map(l=>l.name).join(", ")}</span>}
                  </div>
                )}
              </div>
            </div>

            {/* Slack Integration */}
            <SlackConnector pid={pid} projects={projects} setProjects={setProjects} groqKey={groqKey} lang={lang} t={t} dbSaveDoc={dbSaveDoc} DB_ENABLED={DB_ENABLED} S={S} I={I} />

            {/* Other integrations */}
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(150px,1fr))",gap:8,marginBottom:20}}>
              {[{name:"GitLab",icon:"🦊",color:"#fc6d26",desc:"Repos & issues"},{name:"GitHub",icon:"⚫",color:"#6e40c9",desc:"Code & PRs"},{name:"Notion",icon:"📖",color:"#1976d2",desc:"Docs & wikis"},{name:"Jira",icon:"🔵",status:"soon",color:"#0052cc",desc:"Coming soon"}].map(tool=>(
                <div key={tool.name} style={{background:"#1e293b",border:"1px solid #334155",borderRadius:10,padding:"12px",textAlign:"center"}}>
                  <div style={{fontSize:22,marginBottom:4}}>{tool.icon}</div>
                  <div style={{fontSize:12,fontWeight:700,color:"#e2e8f0"}}>{tool.name}</div>
                  <div style={{fontSize:10,color:"#64748b",marginBottom:8}}>{tool.desc}</div>
                  {tool.status==="soon"?<span style={{fontSize:10,color:"#475569"}}>{t.comingSoon}</span>:<button style={{...S.smBtn,fontSize:10,padding:"3px 10px",borderColor:tool.color,color:tool.color}} onClick={()=>alert(`${tool.name}: paste your workspace URL and API token.`)}>{t.connectBtn2}</button>}
                </div>
              ))}
            </div>

            <div style={{display:"flex",gap:4,marginBottom:12}}>
              {[["manual",t.fileUpload],["url",t.urlTab],["text",t.textTab]].map(([k,l])=>(
                <button key={k} onClick={()=>setDocTab(k)} style={{...S.smBtn,...(docTab===k?{background:"#1e293b",color:"#818cf8",borderColor:"#4f46e5"}:{})}}>{l}</button>
              ))}
            </div>
            {docTab==="manual"&&<div style={{border:"2px dashed #334155",borderRadius:12,padding:26,textAlign:"center",cursor:"pointer",marginBottom:16}} onClick={()=>fileRef.current?.click()} onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();uploadFiles(e.dataTransfer.files);}}><I.Upload/><div style={{marginTop:8,fontWeight:600,color:"#94a3b8",fontSize:13}}>{t.dropzone}</div><div style={{fontSize:11,color:"#475569",marginTop:3}}>{t.dropzoneSub}</div><input ref={fileRef} type="file" multiple style={{display:"none"}} onChange={e=>uploadFiles(e.target.files)}/></div>}
            {docTab==="url"&&<div style={{display:"flex",gap:8,marginBottom:16,background:"#1e293b",border:"1px solid #334155",borderRadius:10,padding:"8px 12px",alignItems:"center"}}><I.Link/><input style={{...S.input,flex:1,margin:0,background:"transparent",border:"none",padding:"4px 0"}} placeholder={t.urlPlaceholder} value={urlInput} onChange={e=>setUrlInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&addUrl()}/><button onClick={addUrl} style={S.smBtn}>{t.addUrl}</button></div>}
            {docTab==="text"&&<div style={{display:"flex",flexDirection:"column",gap:8,marginBottom:16}}><textarea style={{background:"#1e293b",border:"1px solid #334155",borderRadius:10,padding:"10px 12px",color:"#f1f5f9",fontSize:13,resize:"none",fontFamily:"inherit",outline:"none",minHeight:110}} placeholder={t.textPlaceholder} value={scriptTxt} onChange={e=>setScriptTxt(e.target.value)}/><button onClick={addScript} style={S.smBtn}>{t.addToKb}</button></div>}

            <div style={S.card}>
              <div style={{fontSize:11,fontWeight:700,color:"#475569",textTransform:"uppercase",letterSpacing:1,marginBottom:10}}>{t.indexedDocs} — {(project?.docs||[]).length}</div>
              {(project?.docs||[]).map(doc=>(
                <div key={doc.id} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 0",borderBottom:"1px solid #1e293b"}}>
                  <span style={{background:{pdf:"#ef4444",csv:"#10b981",text:"#6366f1",url:"#f59e0b",clickup:"#7c3aed"}[doc.source]||{pdf:"#ef4444",csv:"#10b981",text:"#6366f1",url:"#f59e0b"}[doc.type]||"#8b5cf6",color:"white",fontSize:9,fontWeight:800,padding:"2px 5px",borderRadius:3}}>{doc.source==="clickup"?"CU":doc.type?.toUpperCase()}</span>
                  <div style={{flex:1}}><div style={{fontSize:12,fontWeight:600,color:"#e2e8f0"}}>{doc.name}</div><div style={{fontSize:10,color:"#475569"}}>{doc.source} · {doc.uploadedAt} · {doc.content?.length?.toLocaleString()} chars</div></div>
                  <button onClick={()=>{setProjects(p=>({...p,[pid]:{...p[pid],docs:p[pid].docs.filter(d=>d.id!==doc.id)}}));if(DB_ENABLED)dbDeleteDoc(String(doc.id)).catch(console.error);}} style={S.iconBtn}><I.Trash/></button>
                </div>
              ))}
              {!(project?.docs?.length)&&<div style={{padding:"20px 0",textAlign:"center",color:"#475569",fontSize:12}}>{t.noDocsYet}</div>}
            </div>
          </div>
        )}

        {/* TICKETS */}
        {view==="tickets"&&user.role!=="client"&&(
          <div style={S.panel}>
            <div style={{marginBottom:18}}><h2 style={S.panelH}>{t.ticketsTitle}</h2><p style={S.panelSub}>{t.ticketsSub}</p></div>
            {selectedTkt?(
              <div>
                <button onClick={()=>{setSelectedTkt(null);setTktReply("");}} style={S.smBtn}>{t.backBtn}</button>
                <div style={{...S.card,marginTop:12}}>
                  <div style={{display:"flex",justifyContent:"space-between",marginBottom:8}}><span style={{fontWeight:700,color:"#818cf8"}}>{selectedTkt.id}</span><StatusBadge status={selectedTkt.status} t={t}/></div>
                  <div style={{fontSize:14,color:"#e2e8f0",marginBottom:6}}>{selectedTkt.summary}</div>
                  <div style={{fontSize:11,color:"#475569"}}>{new Date(selectedTkt.createdAt).toLocaleString()} · {selectedTkt.projectName}</div>
                  <div style={{display:"flex",gap:8,marginTop:12}}>
                    <button onClick={()=>{const waNum=localStorage.getItem("sentinel_wa");if(waNum){const msg=encodeURIComponent(`🚨 Ticket ${selectedTkt.id}\nProject: ${selectedTkt.projectName}\nIssue: ${selectedTkt.summary}`);window.open(`https://wa.me/${waNum.replace(/\D/g,"")}?text=${msg}`,"_blank");}else alert(t.configureWhatsapp);}} style={{...S.smBtn,borderColor:"#25d366",color:"#25d366"}}>{t.notifyWhatsapp}</button>
                    <button onClick={()=>alert(t.configureEmail)} style={{...S.smBtn,borderColor:"#818cf8",color:"#818cf8"}}>{t.notifyEmail}</button>
                  </div>
                </div>
                <div style={{...S.card,marginTop:10}}>
                  <div style={{fontSize:11,fontWeight:700,color:"#475569",textTransform:"uppercase",marginBottom:8}}>{t.conversation}</div>
                  {selectedTkt.conversation?.map((m,i)=>(
                    <div key={i} style={{padding:"8px 0",borderBottom:"1px solid #1e293b"}}>
                      <div style={{fontSize:10,fontWeight:700,color:m.role==="user"?"#818cf8":"#34d399",textTransform:"uppercase",marginBottom:2}}>{m.role==="user"?t.clientLabel:t.aiLabel}</div>
                      <div style={{fontSize:12,color:"#cbd5e1"}}>{m.content}</div>
                    </div>
                  ))}
                </div>
                {selectedTkt.status==="open"&&(
                  <div style={{marginTop:12,display:"flex",flexDirection:"column",gap:8}}>
                    <button onClick={()=>suggestReply(selectedTkt)} disabled={loading} style={S.smBtn}>{loading?t.generating:t.suggestReply}</button>
                    {tktReply&&<textarea style={{background:"#1e293b",border:"1px solid #334155",borderRadius:10,padding:"10px 12px",color:"#f1f5f9",fontSize:13,resize:"none",fontFamily:"inherit",outline:"none",minHeight:80}} value={tktReply} onChange={e=>setTktReply(e.target.value)}/>}
                    <button onClick={()=>resolveTicket(selectedTkt.id,tktReply||"Resolved")} style={{...S.smBtn,background:"#052e16",borderColor:"#10b981",color:"#10b981"}}><I.Check/> {t.closeResolved}</button>
                  </div>
                )}
                {selectedTkt.status==="resolved"&&<div style={{marginTop:12,padding:12,background:"#052e16",border:"1px solid #166534",borderRadius:10,fontSize:12,color:"#86efac"}}>✅ {selectedTkt.resolution}</div>}
              </div>
            ):(
              <div style={{display:"flex",flexDirection:"column",gap:8}}>
                {allTickets.sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)).map(tkt=>(
                  <div key={tkt.id} style={{...S.card,cursor:"pointer"}} onClick={()=>{setSelectedTkt(tkt);setTktReply("");}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}><div style={{display:"flex",gap:8,alignItems:"center"}}><StatusBadge status={tkt.status} t={t}/><span style={{fontSize:12,fontWeight:700,color:"#818cf8"}}>{tkt.id}</span></div><span style={{fontSize:11,color:"#475569"}}>{tkt.projectName}</span></div>
                    <div style={{fontSize:13,color:"#cbd5e1"}}>{tkt.summary.slice(0,100)}{tkt.summary.length>100?"...":""}</div>
                    <div style={{fontSize:11,color:"#475569",marginTop:4}}>{new Date(tkt.createdAt).toLocaleString()}</div>
                  </div>
                ))}
                {!allTickets.length&&<div style={{padding:48,textAlign:"center",color:"#475569",fontSize:13}}>{t.noTickets}</div>}
              </div>
            )}
          </div>
        )}

        {/* ADMIN */}
        {view==="admin"&&user.role==="admin"&&(
          <div style={S.panel}>
            <div style={{marginBottom:18}}><h2 style={S.panelH}>{t.adminTitle}</h2><p style={S.panelSub}>{t.adminSub}</p></div>
            <div style={{display:"flex",gap:4,marginBottom:18}}>
              {[["projects",lang==="es"?"Proyectos":"Projects",I.Grid],["integrations",lang==="es"?"Integraciones":"Integrations",I.Phone],["team",lang==="es"?"Equipo":"Team",I.User]].map(([k,l,Icon])=>(
                <button key={k} onClick={()=>setAdminTab(k)} style={{...S.smBtn,...(adminTab===k?{background:"#1e293b",color:"#818cf8",borderColor:"#4f46e5"}:{})}}><Icon/> {l}</button>
              ))}
            </div>
            {adminTab==="projects"&&(
              <div style={S.card}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
                  <div style={S.sectionTitle}>{t.projectsTitle} ({Object.keys(projects).length})</div>
                  <button onClick={()=>setShowNewProj(true)} style={{...S.smBtn,borderColor:"#4f46e5",color:"#818cf8"}}><I.Plus/> {t.newProject}</button>
                </div>
                {Object.values(projects).map(p=>(
                  <div key={p.id} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 0",borderBottom:"1px solid #1e293b"}}>
                    <span style={{fontSize:16}}>{PROJECT_TEMPLATES[p.type]?.icon||"📁"}</span>
                    <div style={{flex:1}}><div style={{fontSize:13,fontWeight:600,color:"#e2e8f0"}}>{p.name}</div><div style={{fontSize:11,color:"#475569"}}>{p.client} · {p.docs?.length||0} docs · <span style={{color:p.health>=80?"#10b981":p.health>=60?"#f59e0b":"#ef4444"}}>{p.health}%</span></div></div>
                    <StatusBadge status={p.status} t={t}/>
                    <button onClick={()=>{setActive(p.id);setView("data");}} style={S.smBtn}>{t.manageBtn}</button>
                    <button onClick={()=>deleteProject(p.id)} style={{...S.iconBtn,color:"#ef4444"}} title={t.deleteProject}><I.Trash/></button>
                  </div>
                ))}
              </div>
            )}
            {adminTab==="integrations"&&(
              <div>
                <div style={{fontWeight:700,fontSize:14,color:"#f1f5f9",marginBottom:4}}>{t.integrationsTitle}</div>
                <div style={{fontSize:12,color:"#475569",marginBottom:14}}>{t.integrationsSub}</div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                  {[{key:"sentinel_wa",icon:"💬",title:"WhatsApp",ph:"+54911...",label:t.whatsappConfig},{key:"sentinel_em",icon:"📧",title:"EmailJS",ph:"service_xxxxxxx",label:t.emailConfig}].map(cfg=>{
                    const [val,setVal]=useState(localStorage.getItem(cfg.key)||"");
                    const [saved,setSaved]=useState(false);
                    const save=()=>{localStorage.setItem(cfg.key,val);setSaved(true);setTimeout(()=>setSaved(false),2000);};
                    return(
                      <div key={cfg.key} style={S.card}>
                        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}><span style={{fontSize:20}}>{cfg.icon}</span><div style={{fontSize:13,fontWeight:700,color:"#e2e8f0"}}>{cfg.title}</div></div>
                        <label style={S.label}>{cfg.label}</label>
                        <div style={{display:"flex",gap:6}}><input style={{...S.input,flex:1}} placeholder={cfg.ph} value={val} onChange={e=>setVal(e.target.value)}/><button onClick={save} style={S.smBtn}>{saved?t.configSaved:t.saveConfig}</button></div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            {adminTab==="team"&&(
              <div style={S.card}>
                <div style={S.sectionTitle}>{t.teamAccounts}</div>
                {Object.values(USERS).map(u=>(
                  <div key={u.id} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 0",borderBottom:"1px solid #1e293b"}}>
                    <Avatar user={u} size={26}/>
                    <div style={{flex:1}}><div style={{fontSize:12,fontWeight:600,color:"#e2e8f0"}}>{u.name}</div><div style={{fontSize:10,color:"#475569",textTransform:"capitalize"}}>{u.role}{u.area?` · ${u.area}`:""}{u.projectId?` · ${projects[u.projectId]?.name}`:""}</div></div>
                    <span style={{fontSize:10,background:"#1e293b",color:"#64748b",padding:"2px 8px",borderRadius:4}}>{u.id}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

const S={
  bg:{minHeight:"100vh",background:"#060b18",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"'IBM Plex Mono','Fira Code',monospace"},
  authCard:{background:"#0d1526",border:"1px solid #1e293b",borderRadius:16,padding:"28px 32px",width:440,maxWidth:"95vw",boxShadow:"0 0 60px rgba(99,102,241,0.1)"},
  logoBox:{width:36,height:36,background:"linear-gradient(135deg,#4f46e5,#7c3aed)",borderRadius:8,display:"flex",alignItems:"center",justifyContent:"center",fontWeight:900,fontSize:18,color:"white"},
  logoTitle:{fontWeight:800,fontSize:16,color:"#f1f5f9",letterSpacing:3},
  label:{fontSize:10,color:"#64748b",fontWeight:700,textTransform:"uppercase",letterSpacing:1,display:"flex",alignItems:"center",gap:4,marginBottom:5},
  input:{width:"100%",background:"#1e293b",border:"1px solid #334155",borderRadius:8,padding:"9px 12px",color:"#f1f5f9",fontSize:13,outline:"none",fontFamily:"inherit",boxSizing:"border-box"},
  err:{color:"#f87171",fontSize:11,background:"rgba(248,113,113,0.08)",padding:"7px 10px",borderRadius:6},
  bigBtn:{background:"linear-gradient(135deg,#4f46e5,#7c3aed)",border:"none",borderRadius:8,padding:"11px",color:"white",fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:"inherit",width:"100%"},
  app:{display:"flex",height:"100vh",background:"#060b18",fontFamily:"'IBM Plex Mono','Fira Code',monospace",overflow:"hidden"},
  sidebar:{width:220,background:"#0d1526",borderRight:"1px solid #1e293b",display:"flex",flexDirection:"column",padding:"16px 10px",overflow:"hidden"},
  navBtn:{display:"flex",alignItems:"center",gap:8,padding:"8px 10px",borderRadius:7,border:"none",background:"transparent",color:"#64748b",cursor:"pointer",fontSize:12,fontFamily:"inherit",fontWeight:500,width:"100%"},
  navActive:{background:"#1e3a5f",color:"#818cf8"},
  iconBtn:{background:"none",border:"none",color:"#475569",cursor:"pointer",padding:5,display:"flex",alignItems:"center"},
  smBtn:{background:"#1e293b",border:"1px solid #334155",borderRadius:7,padding:"6px 12px",color:"#94a3b8",cursor:"pointer",fontSize:12,fontFamily:"inherit",display:"flex",alignItems:"center",gap:4,whiteSpace:"nowrap"},
  select:{background:"#1e293b",border:"1px solid #334155",borderRadius:7,padding:"6px 10px",color:"#f1f5f9",fontSize:12,fontFamily:"inherit",width:"100%"},
  main:{flex:1,overflow:"hidden",display:"flex",flexDirection:"column"},
  panel:{flex:1,overflowY:"auto",padding:24},
  panelH:{fontSize:20,fontWeight:800,color:"#f1f5f9",margin:0},
  panelSub:{fontSize:12,color:"#475569",marginTop:3},
  card:{background:"#0d1526",border:"1px solid #1e293b",borderRadius:12,padding:"14px 16px"},
  sectionTitle:{fontSize:10,fontWeight:700,color:"#475569",textTransform:"uppercase",letterSpacing:1,marginBottom:12},
};
