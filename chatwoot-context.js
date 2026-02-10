/**
 * ChatwootContext — Módulo reutilizable para cualquier Dashboard App de Chatwoot.
 *
 * Según la documentación oficial:
 * https://www.chatwoot.com/hc/user-guide/articles/1677691702-how-to-use-dashboard-apps
 *
 * - Chatwoot envía la data como JSON string vía postMessage.
 * - Para solicitar contexto: window.parent.postMessage('chatwoot-dashboard-app:fetch-info', '*')
 * - El payload es la conversación directamente: { id, status, inbox_id, meta: { sender, assignee, channel }, messages, ... }
 *
 * Uso:
 *   <script src="chatwoot-context.js"></script>
 *   <script>
 *     const ctx = new ChatwootContext({
 *       debug: true,
 *       allowedInboxIds: [1, 3, 5],
 *     });
 *     ctx.on('contextReady', ({ conversation, contact, agent }) => { ... });
 *     ctx.on('inboxBlocked', ({ inboxId, allowed }) => { ... });
 *     ctx.init();
 *   </script>
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
  get channel()  { return this.#raw.meta?.channel ?? 'N/A'; }
  get inboxId()  { return this.#raw.inbox_id ?? null; }
  get messages() { return this.#raw.messages ?? []; }

  get senderRaw()   { return this.#raw.meta?.sender ?? {}; }
  get assigneeRaw() { return this.#raw.meta?.assignee ?? {}; }

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

// ──────────────────────────────────────────────
// Logger interno
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
      this.#panel.innerHTML += `<div>[${ts}] ${message}${safe ? '<br><pre>' + safe + '</pre>' : ''}</div>`;
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
// Control de acceso por inbox
// ──────────────────────────────────────────────

class CWInboxGuard {
  #allowedIds;
  #logger;

  /**
   * @param {number[]|null} allowedIds - IDs permitidos, null = sin restricción
   * @param {CWDebugLogger} logger
   */
  constructor(allowedIds, logger) {
    this.#allowedIds = allowedIds;
    this.#logger = logger;
  }

  /** true si no hay restricción configurada */
  get isOpen() {
    return this.#allowedIds === null;
  }

  /** Lista de inbox IDs permitidos (copia) */
  get allowedIds() {
    return this.#allowedIds ? [...this.#allowedIds] : null;
  }

  /**
   * Evalúa si un inboxId tiene acceso.
   * @param  {number|null} inboxId
   * @returns {{ allowed: boolean, inboxId: number|null, reason: string }}
   */
  check(inboxId) {
    // Sin restricción configurada → siempre permitido
    if (this.#allowedIds === null) {
      this.#logger.log('InboxGuard: sin restricciones, acceso libre');
      return { allowed: true, inboxId, reason: 'no_restriction' };
    }

    // Sin inbox en el contexto → permitir (no podemos validar)
    if (inboxId === null || inboxId === undefined) {
      this.#logger.log('InboxGuard: inbox_id no presente en el contexto, permitiendo');
      return { allowed: true, inboxId, reason: 'no_inbox_id' };
    }

    const allowed = this.#allowedIds.includes(inboxId);
    this.#logger.log(
      `InboxGuard: inbox_id=${inboxId} ${allowed ? '✓ permitido' : '✗ bloqueado'}`,
      { inboxId, allowedIds: this.#allowedIds }
    );

    return {
      allowed,
      inboxId,
      reason: allowed ? 'inbox_allowed' : 'inbox_blocked',
    };
  }
}

// ──────────────────────────────────────────────
// Clase principal
// ──────────────────────────────────────────────

class ChatwootContext {
  #conversation = null;
  #contact      = null;
  #agent        = null;
  #inboxGuard;
  #listeners    = {};
  #logger;
  #initialized  = false;
  #blocked       = false;
  #timeoutMs;

  /**
   * @param {Object}        opts
   * @param {boolean}       opts.debug           - Activa logs en consola y panel visual
   * @param {string}        opts.debugPanelId    - ID del elemento HTML para mostrar logs
   * @param {number}        opts.timeoutMs       - ms antes de emitir 'contextTimeout' (default 5000)
   * @param {number[]|null} opts.allowedInboxIds - IDs de inbox permitidos. null = todos (default null)
   */
  constructor({ debug = false, debugPanelId = null, timeoutMs = 5000, allowedInboxIds = null } = {}) {
    const panel = debugPanelId ? document.getElementById(debugPanelId) : null;
    this.#logger = new CWDebugLogger(debug, panel);
    this.#timeoutMs = timeoutMs;
    this.#inboxGuard = new CWInboxGuard(allowedInboxIds, this.#logger);
  }

  // ── Accesores ──────────────────────────────

  /** @returns {CWConversation|null} */
  get conversation() { return this.#conversation; }

  /** @returns {CWContact|null} */
  get contact() { return this.#contact; }

  /** @returns {CWAgent|null} */
  get agent() { return this.#agent; }

  /** @returns {CWInboxGuard} */
  get inboxGuard() { return this.#inboxGuard; }

  /** true si ya se recibió contexto al menos una vez */
  get hasContext() { return this.#conversation !== null; }

  /** true si el inbox actual fue bloqueado por el guard */
  get isBlocked() { return this.#blocked; }

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
    this.#logger.log(`Evento: ${event}`);
    (this.#listeners[event] ?? []).forEach(cb => {
      try { cb(payload); } catch (e) { console.error(`[CW] Error en listener "${event}":`, e); }
    });
  }

  // ── Inicialización ─────────────────────────

  init() {
    if (this.#initialized) return this;
    this.#initialized = true;

    this.#logger.log('Inicializando ChatwootContext…');

    window.addEventListener('message', (e) => this.#handleMessage(e));

    this.fetchContext();

    setTimeout(() => {
      if (!this.hasContext) {
        this.#logger.log(`⏱ Timeout (${this.#timeoutMs}ms): no se recibió contexto`);
        this.#emit('contextTimeout', null);
      }
    }, this.#timeoutMs);

    return this;
  }

  /** Solicita contexto actualizado a Chatwoot bajo demanda */
  fetchContext() {
    this.#logger.log('→ chatwoot-dashboard-app:fetch-info');
    window.parent.postMessage('chatwoot-dashboard-app:fetch-info', '*');
  }

  // ── Manejo de mensajes ─────────────────────

  #handleMessage(event) {
    this.#emit('rawMessage', event.data);

    let parsed = null;

    if (typeof event.data === 'string') {
      try {
        parsed = JSON.parse(event.data);
      } catch {
        return;
      }
    } else if (typeof event.data === 'object' && event.data !== null) {
      parsed = event.data;
    } else {
      return;
    }

    this.#logger.log('Mensaje recibido', parsed);

    if (!this.#looksLikeChatwootPayload(parsed)) {
      this.#logger.log('No parece un payload de Chatwoot, ignorado');
      return;
    }

    this.#applyContext(parsed);
  }

  #looksLikeChatwootPayload(data) {
    if (data.id && data.meta?.sender) return true;
    if (data.conversation || data.contact || data.currentAgent) return true;
    if (data.event === 'appContext' && data.data) return true;
    return false;
  }

  #applyContext(data) {
    const isFirst = !this.hasContext;

    // Formato principal: la data ES la conversación
    if (data.id && data.meta?.sender) {
      this.#conversation = new CWConversation(data);
      this.#contact      = new CWContact(data.meta.sender);
      this.#agent        = new CWAgent(data.meta.assignee ?? {});
    }
    // Fallback: envuelto en appContext
    else if (data.event === 'appContext' && data.data) {
      return this.#applyContext(data.data);
    }
    // Fallback: datos con claves separadas
    else if (data.conversation) {
      this.#conversation = new CWConversation(data.conversation);
      this.#contact      = new CWContact(data.contact ?? data.conversation.meta?.sender ?? {});
      this.#agent        = new CWAgent(data.currentAgent ?? data.conversation.meta?.assignee ?? {});
    }
    else {
      this.#logger.log('Formato de contexto no reconocido');
      return;
    }

    // ── Verificar acceso por inbox ───────────
    const guardResult = this.#inboxGuard.check(this.#conversation.inboxId);

    if (!guardResult.allowed) {
      this.#blocked = true;
      this.#emit('inboxBlocked', {
        inboxId:    guardResult.inboxId,
        allowedIds: this.#inboxGuard.allowedIds,
        reason:     guardResult.reason,
      });
      // No emitir contextReady/contextUpdated si está bloqueado
      return;
    }

    this.#blocked = false;

    const models = {
      conversation: this.#conversation,
      contact:      this.#contact,
      agent:        this.#agent,
    };

    this.#logger.log('✓ Contexto aplicado', {
      conversationId: this.#conversation.id,
      inboxId:        this.#conversation.inboxId,
      contact:        this.#contact.name,
      agent:          this.#agent.name,
    });

    if (isFirst) this.#emit('contextReady', models);
    this.#emit('contextUpdated', models);
  }
}