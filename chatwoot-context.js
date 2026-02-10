/**
 * ChatwootContext — Módulo reutilizable para cualquier Dashboard App de Chatwoot.
 *
 * Documentación: https://www.chatwoot.com/hc/user-guide/articles/1677691702-how-to-use-dashboard-apps
 *
 * Payload real que envía Chatwoot (verificado):
 *   JSON.parse(event.data) → {
 *     event: "appContext",
 *     data: {
 *       conversation: { id, inbox_id, status, meta: { sender, assignee, channel, team }, messages, ... },
 *       contact: { id, name, email, phone_number, ... },
 *       currentAgent: { id, name, email }
 *     }
 *   }
 *
 * Uso:
 *   const ctx = new ChatwootContext({ debug: true, allowedInboxIds: [1, 3] });
 *   ctx.on('contextReady', ({ conversation, contact, agent }) => { ... });
 *   ctx.on('inboxBlocked', ({ inboxId }) => { ... });
 *   ctx.init();
 */

// ──────────────────────────────────────────────
// Modelos de datos
// ──────────────────────────────────────────────

class CWConversation {
  #raw;

  constructor(data = {}) {
    this.#raw = data;
  }

  get id()       { return this.#raw.id ?? null; }
  get status()   { return this.#raw.status ?? 'unknown'; }
  get inboxId()  { return this.#raw.inbox_id ?? null; }
  get channel()  { return this.#raw.meta?.channel ?? 'N/A'; }
  get messages() { return this.#raw.messages ?? []; }
  get accountId(){ return this.#raw.account_id ?? null; }
  get uuid()     { return this.#raw.uuid ?? null; }
  get labels()   { return this.#raw.labels ?? []; }
  get priority() { return this.#raw.priority ?? null; }

  get senderRaw()   { return this.#raw.meta?.sender ?? {}; }
  get assigneeRaw() { return this.#raw.meta?.assignee ?? {}; }
  get teamRaw()     { return this.#raw.meta?.team ?? {}; }

  get raw() { return structuredClone(this.#raw); }
}

class CWContact {
  #raw;

  constructor(data = {}) {
    this.#raw = data;
  }

  get id()          { return this.#raw.id ?? null; }
  get name()        { return this.#raw.name ?? 'Sin nombre'; }
  get email()       { return this.#raw.email ?? 'N/A'; }
  get phoneNumber() { return this.#raw.phone_number ?? 'N/A'; }
  get thumbnail()   { return this.#raw.thumbnail ?? null; }
  get identifier()  { return this.#raw.identifier ?? null; }
  get blocked()     { return this.#raw.blocked ?? false; }
  get companyName() { return this.#raw.additional_attributes?.company_name ?? 'N/A'; }
  get customAttributes() { return this.#raw.custom_attributes ?? {}; }

  get raw() { return structuredClone(this.#raw); }
}

class CWAgent {
  #raw;

  constructor(data = {}) {
    this.#raw = data;
  }

  get id()        { return this.#raw.id ?? null; }
  get name()      { return this.#raw.name ?? this.#raw.available_name ?? 'No asignado'; }
  get email()     { return this.#raw.email ?? 'N/A'; }
  get role()      { return this.#raw.role ?? 'N/A'; }
  get thumbnail() { return this.#raw.thumbnail ?? null; }

  get raw() { return structuredClone(this.#raw); }
}

class CWTeam {
  #raw;

  constructor(data = {}) {
    this.#raw = data ?? {};
  }

  get id()   { return this.#raw.id ?? null; }
  get name() { return this.#raw.name ?? 'N/A'; }

  get raw() { return structuredClone(this.#raw); }
}

// ──────────────────────────────────────────────
// Logger
// ──────────────────────────────────────────────

class CWDebugLogger {
  #enabled;
  #panel;

  constructor(enabled = false, panel = null) {
    this.#enabled = enabled;
    this.#panel = panel;
  }

  log(message, data = null) {
    if (!this.#enabled) return;
    const ts = new Date().toLocaleTimeString();
    console.log(`[CW ${ts}] ${message}`, data ?? '');
    if (this.#panel) {
      const safe = data ? this.#escape(JSON.stringify(data, null, 2)) : '';
      this.#panel.innerHTML +=
        `<div>[${ts}] ${message}${safe ? '<br><pre>' + safe + '</pre>' : ''}</div>`;
      this.#panel.scrollTop = this.#panel.scrollHeight;
    }
  }

  #escape(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }
}

// ──────────────────────────────────────────────
// InboxGuard
// ──────────────────────────────────────────────

class CWInboxGuard {
  #allowedIds;
  #logger;

  /**
   * @param {number[]|null} allowedIds — null = sin restricción
   * @param {CWDebugLogger} logger
   */
  constructor(allowedIds, logger) {
    this.#allowedIds = allowedIds;
    this.#logger = logger;
  }

  get isOpen()      { return this.#allowedIds === null; }
  get allowedIds()  { return this.#allowedIds ? [...this.#allowedIds] : null; }

  /**
   * @param  {number|null} inboxId
   * @returns {{ allowed: boolean, inboxId: number|null }}
   */
  check(inboxId) {
    if (this.#allowedIds === null) {
      this.#logger.log('InboxGuard: sin restricciones configuradas → acceso libre');
      return { allowed: true, inboxId };
    }

    if (inboxId === null || inboxId === undefined) {
      this.#logger.log('InboxGuard: inbox_id no presente → permitido por defecto');
      return { allowed: true, inboxId };
    }

    const allowed = this.#allowedIds.includes(inboxId);

    this.#logger.log(
      `InboxGuard: inbox_id=${inboxId} → ${allowed ? '✓ PERMITIDO' : '✗ BLOQUEADO'}  (permitidos: [${this.#allowedIds.join(', ')}])`,
    );

    return { allowed, inboxId };
  }
}

// ──────────────────────────────────────────────
// Clase principal
// ──────────────────────────────────────────────

class ChatwootContext {
  #conversation = null;
  #contact      = null;
  #agent        = null;
  #team         = null;
  #inboxGuard;
  #listeners    = {};
  #logger;
  #initialized  = false;
  #blocked      = false;
  #timeoutMs;

  /**
   * @param {Object}        opts
   * @param {boolean}       opts.debug            — Activa logs
   * @param {string}        opts.debugPanelId     — ID del elemento HTML para logs visuales
   * @param {number}        opts.timeoutMs        — Timeout en ms (default 5000)
   * @param {number[]|null} opts.allowedInboxIds  — IDs permitidos, null = todos
   */
  constructor({ debug = false, debugPanelId = null, timeoutMs = 5000, allowedInboxIds = null } = {}) {
    const panel = debugPanelId ? document.getElementById(debugPanelId) : null;
    this.#logger = new CWDebugLogger(debug, panel);
    this.#timeoutMs = timeoutMs;
    this.#inboxGuard = new CWInboxGuard(allowedInboxIds, this.#logger);

    this.#logger.log('Constructor', {
      debug,
      timeoutMs,
      allowedInboxIds,
    });
  }

  // ── Accesores ──────────────────────────────

  get conversation() { return this.#conversation; }
  get contact()      { return this.#contact; }
  get agent()        { return this.#agent; }
  get team()         { return this.#team; }
  get inboxGuard()   { return this.#inboxGuard; }
  get hasContext()    { return this.#conversation !== null; }
  get isBlocked()    { return this.#blocked; }

  // ── Eventos ────────────────────────────────
  // 'contextReady' | 'contextUpdated' | 'contextTimeout' | 'inboxBlocked' | 'rawMessage'

  on(event, cb) {
    (this.#listeners[event] ??= []).push(cb);
    return this;
  }

  off(event, cb) {
    if (!this.#listeners[event]) return this;
    this.#listeners[event] = this.#listeners[event].filter(fn => fn !== cb);
    return this;
  }

  #emit(event, payload) {
    this.#logger.log(`Evento emitido: ${event}`);
    (this.#listeners[event] ?? []).forEach(cb => {
      try { cb(payload); } catch (e) { console.error(`[CW] Error en listener "${event}":`, e); }
    });
  }

  // ── Inicialización ─────────────────────────

  init() {
    if (this.#initialized) return this;
    this.#initialized = true;

    this.#logger.log('Inicializando…');

    window.addEventListener('message', (e) => this.#handleMessage(e));
    this.fetchContext();

    setTimeout(() => {
      if (!this.hasContext && !this.#blocked) {
        this.#logger.log(`⏱ Timeout (${this.#timeoutMs}ms)`);
        this.#emit('contextTimeout', null);
      }
    }, this.#timeoutMs);

    return this;
  }

  fetchContext() {
    this.#logger.log('→ chatwoot-dashboard-app:fetch-info');
    window.parent.postMessage('chatwoot-dashboard-app:fetch-info', '*');
  }

  // ── Manejo de mensajes ─────────────────────

  #handleMessage(event) {
    this.#emit('rawMessage', event.data);

    let parsed = null;

    if (typeof event.data === 'string') {
      try { parsed = JSON.parse(event.data); } catch { return; }
    } else if (typeof event.data === 'object' && event.data !== null) {
      parsed = event.data;
    } else {
      return;
    }

    this.#logger.log('Mensaje parseado', { event: parsed.event, hasData: !!parsed.data });

    // ── Extraer los 3 objetos: conversation, contact, currentAgent ──

    let conversation, contact, currentAgent;

    // Formato real verificado: { event: "appContext", data: { conversation, contact, currentAgent } }
    if (parsed.event === 'appContext' && parsed.data) {
      this.#logger.log('Formato detectado: appContext wrapper');
      conversation = parsed.data.conversation;
      contact      = parsed.data.contact;
      currentAgent = parsed.data.currentAgent;
    }
    // Formato alternativo: { conversation, contact, currentAgent } directo
    else if (parsed.conversation) {
      this.#logger.log('Formato detectado: datos directos con conversation');
      conversation = parsed.conversation;
      contact      = parsed.contact;
      currentAgent = parsed.currentAgent;
    }
    // Formato alternativo: el payload ES la conversación { id, meta, inbox_id, ... }
    else if (parsed.id && parsed.meta?.sender) {
      this.#logger.log('Formato detectado: conversación plana');
      conversation = parsed;
      contact      = parsed.meta.sender;
      currentAgent = parsed.meta.assignee;
    }
    else {
      this.#logger.log('Mensaje ignorado: no es un payload de Chatwoot reconocido');
      return;
    }

    if (!conversation) {
      this.#logger.log('Sin datos de conversación en el payload');
      return;
    }

    // ── Crear modelos ────────────────────────

    const convModel  = new CWConversation(conversation);
    const ctcModel   = new CWContact(contact ?? conversation.meta?.sender ?? {});
    const agentModel = new CWAgent(currentAgent ?? conversation.meta?.assignee ?? {});
    const teamModel  = new CWTeam(conversation.meta?.team ?? {});

    this.#logger.log('Modelos creados', {
      conversationId: convModel.id,
      inboxId:        convModel.inboxId,
      contact:        ctcModel.name,
      agent:          agentModel.name,
      team:           teamModel.name,
    });

    // ── Verificar acceso por inbox ANTES de aplicar ──

    const guardResult = this.#inboxGuard.check(convModel.inboxId);

    if (!guardResult.allowed) {
      this.#blocked = true;
      this.#logger.log(`🚫 INBOX BLOQUEADO: inbox_id=${guardResult.inboxId}`);
      this.#emit('inboxBlocked', {
        inboxId:    guardResult.inboxId,
        allowedIds: this.#inboxGuard.allowedIds,
        conversation: convModel,
        contact:      ctcModel,
        agent:        agentModel,
      });
      return;
    }

    // ── Aplicar contexto ─────────────────────

    const isFirst = !this.hasContext;
    this.#blocked      = false;
    this.#conversation = convModel;
    this.#contact      = ctcModel;
    this.#agent        = agentModel;
    this.#team         = teamModel;

    const models = {
      conversation: this.#conversation,
      contact:      this.#contact,
      agent:        this.#agent,
      team:         this.#team,
    };

    this.#logger.log('✓ Contexto aplicado', {
      conversationId: this.#conversation.id,
      inboxId:        this.#conversation.inboxId,
      contact:        this.#contact.name,
      agent:          this.#agent.name,
      team:           this.#team.name,
    });

    if (isFirst) this.#emit('contextReady', models);
    this.#emit('contextUpdated', models);
  }
}