import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgencyConfig } from './config.js';
import { readSessionDetail, listSessions } from './session-store.js';
import { AgencyRuntime, type ConversationHandle } from './runtime.js';
import { ApprovalManager } from './approvals.js';
import { RuntimeEventBus, type RuntimeEvent } from './events.js';

interface TaskRecord {
  sessionId: string;
  mode: 'task' | 'chat';
  status: 'running' | 'completed' | 'failed';
  error?: string;
}

function resolveDisplayStatus(task: TaskRecord | undefined, persistedStatus: string): string {
  if (!task) {
    return persistedStatus;
  }
  if (task.status === 'running' || task.status === 'failed') {
    return task.status;
  }
  return persistedStatus;
}

function sendJson(response: http.ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store, no-cache, must-revalidate',
    pragma: 'no-cache',
  });
  response.end(JSON.stringify(payload));
}

function sendHtml(response: http.ServerResponse, html: string): void {
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store, no-cache, must-revalidate',
    pragma: 'no-cache',
  });
  response.end(html);
}

function readBody<T>(request: http.IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve((raw ? JSON.parse(raw) : {}) as T);
      } catch (error) {
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

function uiHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Agency Console</title>
    <style>
      :root { --bg:#f5f0e8; --panel:#fffaf3; --ink:#1f1a17; --muted:#6a6159; --accent:#a14a22; --line:#d9cbb7; --good:#2f6b3d; --bad:#8e2f24; }
      * { box-sizing:border-box; }
      body { margin:0; font-family: "Iowan Old Style", "Palatino Linotype", serif; background:linear-gradient(160deg,#efe4d3, #f9f6f0 45%, #e8dcc6); color:var(--ink); }
      .shell { display:grid; grid-template-columns: 380px 1fr; min-height:100vh; }
      .sidebar, .main { padding:24px; }
      .sidebar { border-right:1px solid var(--line); background:rgba(255,250,243,0.8); backdrop-filter: blur(14px); }
      h1,h2,h3 { margin:0 0 12px; font-weight:600; }
      p { margin:0 0 12px; color:var(--muted); }
      textarea, input, button, select { font:inherit; }
      textarea, input { width:100%; border:1px solid var(--line); background:#fffdf9; padding:14px; }
      textarea { min-height:100px; resize:vertical; }
      button { border:0; background:var(--accent); color:white; padding:12px 16px; cursor:pointer; }
      button.secondary { background:#eadcc6; color:var(--ink); }
      button.approve { background:var(--good); }
      button.deny { background:var(--bad); }
      .row { display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
      .card { border:1px solid var(--line); background:rgba(255,253,249,0.92); padding:16px; margin-top:16px; }
      .session, .approval { padding:12px 0; border-top:1px solid var(--line); cursor:pointer; }
      .session:first-child, .approval:first-child { border-top:0; }
      .session strong, .approval strong { display:block; margin-bottom:6px; }
      .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; overflow-wrap:anywhere; }
      .columns { display:grid; grid-template-columns: 1fr 1fr; gap:16px; }
      .badge { display:inline-block; border:1px solid var(--line); padding:2px 8px; color:var(--muted); }
      .badge.running { color:var(--accent); }
      .badge.completed { color:var(--good); }
      .badge.failed, .badge.FAIL, .badge.BLOCKED { color:var(--bad); }
      .badge.PASS { color:var(--good); }
      .toolbar { display:flex; gap:8px; margin-top:12px; }
      @media (max-width: 900px) { .shell { grid-template-columns: 1fr; } .sidebar { border-right:0; border-bottom:1px solid var(--line);} .columns { grid-template-columns:1fr; } }
    </style>
  </head>
  <body>
    <div class="shell">
      <aside class="sidebar">
        <h1>Agency Console</h1>
        <p>Run tasks, keep a real chat session open, and approve write or shell actions from the browser.</p>
        <div class="card">
          <h2>New Task</h2>
          <textarea id="task-prompt" placeholder="Explain the indexer architecture"></textarea>
          <div class="toolbar">
            <button id="run-task">Run Task</button>
            <button class="secondary" id="refresh-all">Refresh</button>
          </div>
          <p id="task-status" style="margin-top:12px;"></p>
        </div>
        <div class="card">
          <h2>Chat</h2>
          <div class="row">
            <button id="start-chat">Start Chat Session</button>
            <span class="badge" id="chat-id">idle</span>
          </div>
          <textarea id="chat-prompt" placeholder="Ask a follow-up question in the active chat"></textarea>
          <div class="toolbar">
            <button id="send-chat">Send Message</button>
          </div>
          <p id="chat-status" style="margin-top:12px;"></p>
        </div>
        <div class="card">
          <h2>Pending Approvals</h2>
          <div id="approvals"></div>
        </div>
        <div class="card">
          <h2>Sessions</h2>
          <div id="sessions"></div>
        </div>
      </aside>
      <main class="main">
        <div class="card">
          <div class="row" style="justify-content:space-between;">
            <div>
              <h2 id="detail-title">No session selected</h2>
              <p id="detail-meta"></p>
            </div>
            <span class="badge" id="detail-mode">idle</span>
          </div>
          <div class="row" style="margin-top:12px;">
            <span class="badge" id="detail-status">unknown</span>
            <span class="badge" id="detail-phase">phase: idle</span>
            <span class="badge" id="detail-backend">backend: local</span>
          </div>
        </div>
        <div class="columns">
          <div class="card">
            <h3>Plan</h3>
            <div class="mono" id="plan"></div>
          </div>
          <div class="card">
            <h3>Final</h3>
            <div class="mono" id="final"></div>
          </div>
        </div>
        <div class="columns">
          <div class="card">
            <h3>Verification</h3>
            <div class="mono" id="verification"></div>
          </div>
          <div class="card">
            <h3>Diff Preview</h3>
            <div class="mono" id="diff"></div>
          </div>
        </div>
        <div class="columns">
          <div class="card">
            <h3>Artifacts</h3>
            <div class="mono" id="artifacts"></div>
          </div>
          <div class="card">
            <h3>Verifier / Context</h3>
            <div class="mono" id="verifier"></div>
          </div>
        </div>
        <div class="card">
          <h3>Events</h3>
          <div class="mono" id="events"></div>
        </div>
      </main>
    </div>
    <script>
      let selectedSessionId = null;
      let activeChatSessionId = null;
      let streamSource = null;
      let detailReloadTimer = null;

      async function api(url, options) {
        const response = await fetch(url, options);
        const contentType = response.headers.get('content-type') || '';
        const payload = contentType.includes('application/json')
          ? await response.json()
          : await response.text();
        if (!response.ok) {
          const message = typeof payload === 'object' && payload && 'error' in payload
            ? payload.error
            : String(payload || response.statusText || 'Request failed');
          throw new Error(message);
        }
        return payload;
      }

      function setStatus(nodeId, message) {
        document.getElementById(nodeId).textContent = message || '';
      }

      function escapeHtml(value) {
        return String(value).replace(/[&<>]/g, (ch) => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[ch]));
      }

      function approvalPreview(approval) {
        if (approval.toolName === 'apply_unified_patch') {
          if (Array.isArray(approval.args.patches)) {
            return approval.args.patches.map((entry) => '# ' + entry.path + '\\n' + entry.patch).join('\\n\\n');
          }
          return approval.args.patch || '';
        }
        if (approval.toolName === 'replace_exact_text' || approval.toolName === 'write_patch') {
          return JSON.stringify(approval.args, null, 2);
        }
        if (approval.toolName === 'run_shell' || approval.toolName === 'run_python_script') {
          return '$ ' + (approval.args.command || approval.args.script_path || 'structured execution');
        }
        return JSON.stringify(approval.args, null, 2);
      }

      function scheduleDetailReload() {
        if (!selectedSessionId) return;
        clearTimeout(detailReloadTimer);
        detailReloadTimer = setTimeout(() => {
          loadDetail(selectedSessionId);
        }, 120);
      }

      function connectStream(sessionId) {
        if (streamSource) {
          streamSource.close();
          streamSource = null;
        }
        if (!sessionId) {
          return;
        }
        streamSource = new EventSource('/api/sessions/' + encodeURIComponent(sessionId) + '/stream');
        streamSource.onmessage = (message) => {
          const event = JSON.parse(message.data);
          handleStreamEvent(event);
        };
        streamSource.onerror = () => {
          document.getElementById('task-status').textContent = 'Stream disconnected; fallback refresh is still active.';
        };
      }

      function handleStreamEvent(event) {
        if (event.sessionId !== selectedSessionId) {
          return;
        }
        const statusNode = document.getElementById('detail-status');
        const phaseNode = document.getElementById('detail-phase');
        const backendNode = document.getElementById('detail-backend');
        const finalNode = document.getElementById('final');
        const eventsNode = document.getElementById('events');
        if (event.backend) {
          backendNode.textContent = 'backend: ' + event.backend;
        }
        if (event.phase) {
          phaseNode.textContent = 'phase: ' + event.phase;
        }
        if (event.type === 'model_text_delta') {
          finalNode.textContent += event.data?.delta || '';
        }
        if (event.type === 'verifier_result' && event.data?.verifierResult?.status) {
          statusNode.textContent = event.data.verifierResult.status;
          statusNode.className = 'badge ' + event.data.verifierResult.status;
        }
        if (event.type === 'final_result') {
          statusNode.textContent = event.data?.status || 'completed';
          statusNode.className = 'badge ' + (event.data?.status || 'completed');
        }
        eventsNode.textContent = JSON.stringify(event, null, 2) + '\\n\\n' + eventsNode.textContent;
        if (event.type !== 'model_text_delta') {
          scheduleDetailReload();
        }
      }

      async function loadApprovals() {
        const approvals = await api('/api/approvals');
        const container = document.getElementById('approvals');
        container.innerHTML = approvals.length === 0
          ? '<p>No pending approvals.</p>'
          : approvals.map((approval) =>
              '<div class="approval" data-id="' + approval.id + '">'
              + '<strong>' + approval.toolName + '</strong>'
              + '<div>' + approval.sessionId + '</div>'
              + '<div class="mono">' + escapeHtml(approvalPreview(approval)) + '</div>'
              + '<div class="toolbar">'
              + '<button class="approve" data-action="approve" data-id="' + approval.id + '">Approve</button>'
              + '<button class="deny" data-action="deny" data-id="' + approval.id + '">Deny</button>'
              + '</div>'
              + '</div>'
            ).join('');
        for (const button of container.querySelectorAll('button[data-action]')) {
          button.addEventListener('click', async () => {
            const decision = button.dataset.action === 'approve';
            await api('/api/approvals/' + encodeURIComponent(button.dataset.id), {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ decision }),
            });
            await Promise.all([loadApprovals(), loadSessions(selectedSessionId)]);
          });
        }
      }

      async function loadSessions(preferredId) {
        const sessions = await api('/api/sessions');
        const container = document.getElementById('sessions');
        container.innerHTML = sessions.map((session) =>
          '<div class="session" data-id="' + session.id + '">'
          + '<strong>' + escapeHtml(session.prompt || '(empty prompt)') + '</strong>'
          + '<div>' + session.id + '</div>'
          + '<div>' + session.mode + ' | ' + (session.taskStatus || session.status) + '</div>'
          + '</div>'
        ).join('');
        for (const node of container.querySelectorAll('.session')) {
          node.addEventListener('click', () => loadDetail(node.dataset.id));
        }
        const nextId = preferredId || selectedSessionId || sessions[0]?.id;
        if (nextId) {
          await loadDetail(nextId);
        }
      }

      async function loadDetail(id) {
        const detail = await api('/api/sessions/' + encodeURIComponent(id));
        selectedSessionId = detail.id;
        connectStream(detail.id);
        document.getElementById('detail-title').textContent = detail.prompt || '(empty prompt)';
        document.getElementById('detail-meta').textContent = detail.id + ' | rounds=' + (detail.rounds || 0);
        document.getElementById('detail-mode').textContent = detail.mode;
        const displayStatus = detail.displayStatus || detail.status || 'unknown';
        document.getElementById('detail-status').textContent = displayStatus;
        document.getElementById('detail-status').className = 'badge ' + displayStatus;
        document.getElementById('detail-phase').textContent = 'phase: ' + (detail.phase || 'idle');
        document.getElementById('detail-backend').textContent = 'backend: ' + (detail.backend || 'local');
        document.getElementById('plan').textContent = detail.plan || '';
        document.getElementById('final').textContent = detail.finalMessage || '';
        document.getElementById('verification').textContent = detail.verification || '';
        document.getElementById('diff').textContent = detail.diff || '';
        document.getElementById('artifacts').textContent = (detail.artifacts || []).join('\\n');
        document.getElementById('verifier').textContent = JSON.stringify({
          verifierResult: detail.verifierResult || null,
          acceptanceChecks: detail.acceptanceChecks || [],
          evidenceArtifacts: detail.evidenceArtifacts || [],
          contextSummaryArtifact: detail.contextSummaryArtifact || null,
          contextBudgetSnapshot: detail.contextBudgetSnapshot || null,
          streamArtifacts: detail.streamArtifacts || [],
        }, null, 2);
        document.getElementById('events').textContent = (detail.events || []).map((event) => JSON.stringify(event, null, 2)).join('\\n\\n');
      }

      async function refreshAll() {
        try {
          await Promise.all([loadApprovals(), loadSessions(selectedSessionId)]);
        } catch (error) {
          setStatus('task-status', error instanceof Error ? error.message : String(error));
        }
      }

      document.getElementById('refresh-all').addEventListener('click', refreshAll);
      document.getElementById('run-task').addEventListener('click', async () => {
        const prompt = document.getElementById('task-prompt').value.trim();
        if (!prompt) {
          setStatus('task-status', 'Enter a task prompt first.');
          return;
        }
        setStatus('task-status', 'Running...');
        try {
          const result = await api('/api/task', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ prompt }),
          });
          setStatus('task-status', 'Task started');
          await refreshAll();
          if (result.sessionId) {
            await loadDetail(result.sessionId);
          }
        } catch (error) {
          setStatus('task-status', error instanceof Error ? error.message : String(error));
        }
      });

      document.getElementById('start-chat').addEventListener('click', async () => {
        try {
          const result = await api('/api/chat/start', { method: 'POST' });
          activeChatSessionId = result.sessionId;
          document.getElementById('chat-id').textContent = result.sessionId || 'idle';
          setStatus('chat-status', 'Chat session ready');
          await refreshAll();
          if (result.sessionId) {
            await loadDetail(result.sessionId);
          }
        } catch (error) {
          setStatus('chat-status', error instanceof Error ? error.message : String(error));
        }
      });

      document.getElementById('send-chat').addEventListener('click', async () => {
        const prompt = document.getElementById('chat-prompt').value.trim();
        if (!activeChatSessionId) {
          setStatus('chat-status', 'Start a chat session first.');
          return;
        }
        if (!prompt) {
          setStatus('chat-status', 'Enter a message first.');
          return;
        }
        setStatus('chat-status', 'Sending...');
        try {
          await api('/api/chat/' + encodeURIComponent(activeChatSessionId), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ prompt }),
          });
          setStatus('chat-status', 'Message sent');
          document.getElementById('chat-prompt').value = '';
          await refreshAll();
          await loadDetail(activeChatSessionId);
        } catch (error) {
          setStatus('chat-status', error instanceof Error ? error.message : String(error));
        }
      });

      setInterval(refreshAll, 10000);
      refreshAll();
    </script>
  </body>
</html>`;
}

export async function startConsoleServer(_runtime: AgencyRuntime, config: AgencyConfig, port = 3000): Promise<http.Server> {
  const approvalManager = new ApprovalManager();
  const eventBus = new RuntimeEventBus();
  const approvalRuntime = new AgencyRuntime(config, approvalManager.createHandler(), {
    onEvent: async (event) => {
      await eventBus.emit({
        sessionId: event.sessionId,
        mode: event.mode,
        type: event.type,
        phase: event.phase,
        round: event.round,
        backend: event.backend,
        data: event.data,
      });
    },
  });
  const tasks = new Map<string, TaskRecord>();
  const chats = new Map<string, ConversationHandle>();

  async function markTask<T>(sessionId: string, mode: 'task' | 'chat', runner: () => Promise<T>): Promise<void> {
    tasks.set(sessionId, { sessionId, mode, status: 'running' });
    try {
      await runner();
      tasks.set(sessionId, { sessionId, mode, status: 'completed' });
    } catch (error) {
      tasks.set(sessionId, {
        sessionId,
        mode,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (request.method === 'GET' && url.pathname === '/') {
        sendHtml(response, uiHtml());
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/sessions') {
        const sessions = await listSessions(config.sessionDir);
        sendJson(response, 200, sessions.map((session) => ({
          ...session,
          taskStatus: tasks.get(session.id)?.status ?? session.status,
          displayStatus: resolveDisplayStatus(tasks.get(session.id), session.status),
        })));
        return;
      }

      if (request.method === 'GET' && url.pathname.startsWith('/api/sessions/') && url.pathname.endsWith('/stream')) {
        const sessionId = decodeURIComponent(url.pathname.replace('/api/sessions/', '').replace('/stream', ''));
        const lastEventId = request.headers['last-event-id'];
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
        });
        response.write(': connected\n\n');
        const unsubscribe = eventBus.subscribe(sessionId, (event: RuntimeEvent) => {
          response.write(`id: ${event.id}\n`);
          response.write(`data: ${JSON.stringify(event)}\n\n`);
        }, typeof lastEventId === 'string' ? lastEventId : Array.isArray(lastEventId) ? lastEventId[0] : null);
        const heartbeat = setInterval(() => {
          response.write(': ping\n\n');
        }, 15000);
        request.on('close', () => {
          clearInterval(heartbeat);
          unsubscribe();
          response.end();
        });
        return;
      }

      if (request.method === 'GET' && url.pathname.startsWith('/api/sessions/')) {
        const sessionId = decodeURIComponent(url.pathname.replace('/api/sessions/', ''));
        const detail = await readSessionDetail(config.rootDir, config.sessionDir, sessionId);
        sendJson(response, detail ? 200 : 404, detail ? {
          ...detail,
          pendingApprovals: approvalManager.list(sessionId),
          taskStatus: tasks.get(sessionId)?.status ?? detail.status,
          displayStatus: resolveDisplayStatus(tasks.get(sessionId), detail.status),
          taskError: tasks.get(sessionId)?.error,
        } : { error: 'Session not found' });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/approvals') {
        sendJson(response, 200, approvalManager.list());
        return;
      }

      if (request.method === 'POST' && url.pathname.startsWith('/api/approvals/')) {
        const approvalId = decodeURIComponent(url.pathname.replace('/api/approvals/', ''));
        const body = await readBody<{ decision?: boolean }>(request);
        const resolved = approvalManager.resolve(approvalId, body.decision === true);
        sendJson(response, resolved ? 200 : 404, resolved ? { ok: true } : { error: 'Approval not found' });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/task') {
        const body = await readBody<{ prompt?: string }>(request);
        if (!body.prompt) {
          sendJson(response, 400, { error: 'prompt is required' });
          return;
        }
        const session = await approvalRuntime.createSession('task');
        void markTask(session.id, 'task', () => approvalRuntime.runTask(body.prompt!, 'task', session));
        sendJson(response, 202, { sessionId: session.id, status: 'running' });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/chat/start') {
        const chat = await approvalRuntime.createChatSession();
        chats.set(chat.session.id, chat);
        tasks.set(chat.session.id, { sessionId: chat.session.id, mode: 'chat', status: 'completed' });
        sendJson(response, 200, { sessionId: chat.session.id });
        return;
      }

      if (request.method === 'POST' && url.pathname.startsWith('/api/chat/')) {
        const sessionId = decodeURIComponent(url.pathname.replace('/api/chat/', ''));
        const body = await readBody<{ prompt?: string }>(request);
        if (!body.prompt) {
          sendJson(response, 400, { error: 'prompt is required' });
          return;
        }
        const chat = chats.get(sessionId);
        if (!chat) {
          sendJson(response, 404, { error: 'Chat session not found. Start a new chat session first.' });
          return;
        }
        void markTask(sessionId, 'chat', () => chat.prompt(body.prompt!));
        sendJson(response, 202, { sessionId, status: 'running' });
        return;
      }

      if (request.method === 'GET' && url.pathname.startsWith('/artifacts/')) {
        const artifactPath = path.join(config.rootDir, url.pathname.replace('/artifacts/', ''));
        const content = await fs.readFile(artifactPath, 'utf8').catch(() => null);
        if (content == null) {
          response.writeHead(404);
          response.end('Not found');
          return;
        }
        response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        response.end(content);
        return;
      }

      response.writeHead(404);
      response.end('Not found');
    } catch (error) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(port, '0.0.0.0', () => resolve());
  });

  server.on('close', () => {
    approvalRuntime.close();
  });

  return server;
}
