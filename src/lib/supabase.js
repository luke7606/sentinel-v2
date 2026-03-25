// ══════════════════════════════════════════════════════
// sentinel/src/lib/supabase.js
// Reemplaza las funciones dbLoad/dbSave del App.jsx
// Instalá: npm install @supabase/supabase-js
// ══════════════════════════════════════════════════════

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL  = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON);

// ── PROYECTOS ─────────────────────────────────────────

export async function dbLoad() {
  const { data, error } = await supabase
    .from('projects')
    .select('*, documents(*)');
  if (error) { console.error('dbLoad error', error); return null; }
  // Convertir array a objeto keyed por id (igual que antes)
  const result = {};
  for (const p of data) {
    result[p.id] = { ...p, docs: p.documents || [] };
  }
  return Object.keys(result).length > 0 ? result : null;
}

export async function dbSaveProject(proj) {
  const { docs, documents, ...projData } = proj;
  const { error } = await supabase
    .from('projects')
    .upsert({
      id:         projData.id,
      name:       projData.name,
      client:     projData.client,
      type:       projData.type,
      status:     projData.status,
      health:     projData.health,
      budget:     projData.budget,
      spent:      projData.spent,
      start_date: projData.startDate,
      due_date:   projData.dueDate,
      color:      projData.color,
      milestones: projData.milestones,
      team:       projData.team,
      tickets:    projData.tickets,
      activity:   projData.activity,
    });
  if (error) console.error('dbSaveProject error', error);
}

export async function dbDeleteProject(id) {
  const { error } = await supabase.from('projects').delete().eq('id', id);
  if (error) console.error('dbDeleteProject error', error);
}

// ── DOCUMENTOS ────────────────────────────────────────

export async function dbSaveDoc(doc, projectId) {
  const { error } = await supabase
    .from('documents')
    .upsert({
      id:          doc.id,
      project_id:  projectId,
      name:        doc.name,
      type:        doc.type,
      source:      doc.source || 'upload',
      content:     doc.content,
      uploaded_at: doc.uploadedAt,
    });
  if (error) console.error('dbSaveDoc error', error);
}

export async function dbDeleteDoc(id) {
  const { error } = await supabase.from('documents').delete().eq('id', id);
  if (error) console.error('dbDeleteDoc error', error);
}

// ── CHAT / MEMORIA ────────────────────────────────────

export async function dbSaveChatSession(projectId, userId, messages) {
  // Buscar sesión existente del día o crear nueva
  const today = new Date().toISOString().split('T')[0];
  const { data: existing } = await supabase
    .from('chat_sessions')
    .select('id')
    .eq('project_id', projectId)
    .eq('user_id', userId)
    .gte('created_at', today)
    .single();

  const sessionData = {
    project_id: projectId,
    user_id:    userId,
    messages:   messages.slice(-30),  // últimos 30 mensajes
    updated_at: new Date().toISOString(),
  };

  if (existing?.id) {
    await supabase.from('chat_sessions').update(sessionData).eq('id', existing.id);
  } else {
    await supabase.from('chat_sessions').insert(sessionData);
  }
}

export async function dbLoadChatHistory(projectId, userId, limit = 20) {
  const { data, error } = await supabase
    .from('chat_sessions')
    .select('messages, summary, created_at')
    .eq('project_id', projectId)
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(5);  // últimas 5 sesiones

  if (error || !data?.length) return [];

  // Aplanar mensajes de las sesiones más recientes
  const allMessages = data
    .reverse()
    .flatMap(s => s.messages || []);
  return allMessages.slice(-limit);
}

export async function dbSaveChatSummary(projectId, userId, summary) {
  const today = new Date().toISOString().split('T')[0];
  const { data: session } = await supabase
    .from('chat_sessions')
    .select('id')
    .eq('project_id', projectId)
    .eq('user_id', userId)
    .gte('created_at', today)
    .single();

  if (session?.id) {
    await supabase.from('chat_sessions').update({ summary }).eq('id', session.id);
  }
}

// ── CONFIG ────────────────────────────────────────────

export async function dbSaveConfig(key, value) {
  const { error } = await supabase
    .from('config')
    .upsert({ key, value, updated_at: new Date().toISOString() });
  if (error) console.error('dbSaveConfig error', error);
}

export async function dbLoadConfig(key) {
  const { data, error } = await supabase
    .from('config')
    .select('value')
    .eq('key', key)
    .single();
  if (error) return null;
  return data?.value || null;
}

// ── EVENTOS DE INTEGRACIONES ──────────────────────────

export async function dbSaveIntegrationEvent({ projectId, source, eventType, payload, summary }) {
  const { error } = await supabase
    .from('integration_events')
    .insert({
      project_id: projectId,
      source,
      event_type: eventType,
      payload,
      summary,
    });
  if (error) console.error('dbSaveIntegrationEvent error', error);
}

export async function dbLoadUnreadEvents(projectId, limit = 20) {
  const { data, error } = await supabase
    .from('integration_events')
    .select('*')
    .eq('project_id', projectId)
    .eq('read', false)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) return [];
  return data || [];
}

export async function dbMarkEventsRead(projectId) {
  await supabase
    .from('integration_events')
    .update({ read: true })
    .eq('project_id', projectId)
    .eq('read', false);
}

// ── MEMORIA DEL PROYECTO ──────────────────────────────

export async function dbSaveProjectMemory(projectId, { keyFacts, lastRisks, decisions }) {
  const { error } = await supabase
    .from('project_memory')
    .upsert({
      project_id: projectId,
      key_facts:  keyFacts,
      last_risks: lastRisks,
      decisions,
      updated_at: new Date().toISOString(),
    });
  if (error) console.error('dbSaveProjectMemory error', error);
}

export async function dbLoadProjectMemory(projectId) {
  const { data, error } = await supabase
    .from('project_memory')
    .select('*')
    .eq('project_id', projectId)
    .single();
  if (error) return null;
  return data;
}

// ── REALTIME: escuchar eventos nuevos ─────────────────
// Llama a esto en un useEffect para recibir webhooks en tiempo real

export function subscribeToIntegrationEvents(projectId, onNewEvent) {
  return supabase
    .channel(`integration_events:${projectId}`)
    .on(
      'postgres_changes',
      {
        event:  'INSERT',
        schema: 'public',
        table:  'integration_events',
        filter: `project_id=eq.${projectId}`,
      },
      (payload) => onNewEvent(payload.new)
    )
    .subscribe();
}
