(() => {
  "use strict";

  const STORAGE_KEY = "entrega-em-dia-v1";
  const FILE_DB_NAME = "entrega-em-dia-files";
  const FILE_DB_VERSION = 2;
  const CONTRACT_STORE = "contracts";
  const ICP_STORE = "icps";
  const MAX_CONTRACT_FILE_SIZE = 10 * 1024 * 1024;
  const MAX_ICP_FILE_SIZE = 10 * 1024 * 1024;
  const ALLOWED_CONTRACT_EXTENSIONS = ["pdf", "doc", "docx", "png", "jpg", "jpeg"];
  const EVENT_LABELS = { research: "Pesquisa", first_delivery: "1ª listagem", delivery: "Listagem", feedback: "Feedback", followup: "Follow-up" };
  const MONTH_FORMATTER = new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric" });
  const LONG_DATE_FORMATTER = new Intl.DateTimeFormat("pt-BR", { weekday: "long", day: "2-digit", month: "long" });
  const SHORT_MONTH = new Intl.DateTimeFormat("pt-BR", { month: "short" });
  const TIMELINE_DATE_FORMATTER = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short", year: "numeric" });
  const COLOR_PALETTE = ["#53f0df", "#0099ff", "#0e6eff", "#4dccff", "#1065e3", "#68bab5"];

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const pad = (number) => String(number).padStart(2, "0");
  const toISO = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const fromISO = (value) => {
    const [year, month, day] = value.split("-").map(Number);
    return new Date(year, month - 1, day);
  };
  const escapeHTML = (value = "") => String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
  const normalizeList = (value) => value.split(",").map((item) => item.trim()).filter(Boolean);
  const selectedValues = (control) => control.matches("select")
    ? [...control.selectedOptions].map((option) => option.value)
    : $$('input[type="checkbox"]:checked', control).map((input) => input.value);
  const startOfMonth = (date) => new Date(date.getFullYear(), date.getMonth(), 1);
  const endOfMonth = (date) => new Date(date.getFullYear(), date.getMonth() + 1, 0);
  const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const endOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
  const clampDay = (year, month, day) => Math.min(Number(day), new Date(year, month + 1, 0).getDate());
  const plural = (count, singular, pluralWord) => `${count} ${count === 1 ? singular : pluralWord}`;
  const addDays = (date, amount) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + amount);
  const isSameDay = (a, b) => toISO(a) === toISO(b);
  const isSameMonth = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();

  function addBusinessDays(date, amount) {
    const result = startOfDay(date);
    let added = 0;
    while (added < amount) {
      result.setDate(result.getDate() + 1);
      if (result.getDay() !== 0 && result.getDay() !== 6) added += 1;
    }
    return result;
  }

  function initialCadence(client) {
    const kickoff = fromISO(client.startDate);
    const research = addBusinessDays(kickoff, 2);
    const firstDelivery = addBusinessDays(research, 5);
    const feedback = addDays(firstDelivery, 15);
    return { kickoff, research, firstDelivery, feedback };
  }

  function matchesCalendarFilter(event, filter = calendarFilter) {
    if (filter === "all") return true;
    if (filter === "delivery") return event.type === "delivery" || event.type === "first_delivery";
    return event.type === filter;
  }

  let state = loadState();
  let activeView = "overview";
  let viewMonth = startOfMonth(new Date());
  let selectedDate = new Date();
  let calendarFilter = "all";
  let clientFilter = "active";
  let currentFormStep = 1;
  let detailClientId = null;
  let pendingContractFile = null;
  let removeStoredContractFile = false;
  let pendingIcpFile = null;
  let removeStoredIcpFile = false;

  function defaultState() {
    const now = new Date();
    return {
      clients: [],
      completions: {},
      createdAt: now.toISOString(),
      version: 5
    };
  }

  function emptyContract(client = {}) {
    return {
      leadVolume: "",
      leadPeriod: "monthly",
      startDate: client.startDate || "",
      endDate: "",
      service: "",
      notes: "",
      document: null
    };
  }

  function initialTimelineForClient(client) {
    const title = client.icp?.document ? "ICP inicial importado por PDF" : "ICP inicial definido";
    return [
      { id: `${client.id}:timeline:kickoff`, type: "kickoff", date: client.startDate, title: "Reunião de kickoff", note: "Início da cadência operacional do cliente.", changes: [] },
      { id: `${client.id}:timeline:icp-created`, type: "icp_created", date: client.createdAt || new Date().toISOString(), title, note: client.icp?.document ? "Documento legado centralizado na ficha do cliente." : "Primeira versão do perfil ideal registrada.", changes: [] }
    ];
  }

  function completedEventTitle(type) {
    return ({
      research: "Pesquisa de mercado concluída",
      first_delivery: "Primeira listagem entregue",
      delivery: "Listagem mensal entregue",
      feedback: "Reunião de feedback concluída",
      followup: "Follow-up realizado"
    })[type] || "Compromisso concluído";
  }

  function migrateState(saved) {
    const version = saved.version || 1;
    if (version < 2) {
      saved.clients = saved.clients.map((client) => ({
        ...client,
        schedules: {
          ...client.schedules,
          onboarding: { enabled: true },
          followup: { ...client.schedules?.followup, frequency: "weekly" }
        }
      }));
    }
    saved.clients = saved.clients.map((client) => ({
      ...client,
      contract: { ...emptyContract(client), ...(client.contract || {}) },
      icp: { ...(client.icp || {}), document: client.icp?.document || null },
      timeline: Array.isArray(client.timeline) && client.timeline.length ? client.timeline : initialTimelineForClient(client)
    }));
    Object.entries(saved.completions || {}).forEach(([eventId, completedAt]) => {
      const [clientId, type, date] = eventId.split(":");
      const client = saved.clients.find((item) => item.id === clientId);
      if (!client || !date || client.timeline.some((entry) => entry.sourceEventId === eventId)) return;
      client.timeline.push({
        id: `${clientId}:timeline:${eventId}`,
        type,
        date,
        recordedAt: completedAt,
        sourceEventId: eventId,
        title: completedEventTitle(type),
        note: "Atividade concluída antes da criação da linha do tempo.",
        changes: []
      });
    });
    saved.version = 5;
    return saved;
  }

  function loadState() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (saved && Array.isArray(saved.clients) && saved.completions) {
        const migrated = migrateState(saved);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
        return migrated;
      }
    } catch (error) {
      console.warn("Não foi possível ler os dados salvos.", error);
    }
    return defaultState();
  }

  function saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function openFileDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(FILE_DB_NAME, FILE_DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(CONTRACT_STORE)) database.createObjectStore(CONTRACT_STORE, { keyPath: "clientId" });
        if (!database.objectStoreNames.contains(ICP_STORE)) database.createObjectStore(ICP_STORE, { keyPath: "clientId" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Não foi possível abrir o armazenamento de anexos"));
    });
  }

  async function fileStoreRequest(storeName, mode, operation) {
    const database = await openFileDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, mode);
      const request = operation(transaction.objectStore(storeName));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      transaction.oncomplete = () => database.close();
      transaction.onerror = () => { database.close(); reject(transaction.error); };
    });
  }

  const storedFileRecord = (clientId, file) => ({ clientId, blob: file, name: file.name, type: file.type, size: file.size, updatedAt: new Date().toISOString() });
  const getStoredFile = (storeName, clientId) => fileStoreRequest(storeName, "readonly", (store) => store.get(clientId));
  const putStoredFile = (storeName, clientId, file) => fileStoreRequest(storeName, "readwrite", (store) => store.put(storedFileRecord(clientId, file)));
  const deleteStoredFile = (storeName, clientId) => fileStoreRequest(storeName, "readwrite", (store) => store.delete(clientId));
  const getAllStoredFiles = (storeName) => fileStoreRequest(storeName, "readonly", (store) => store.getAll());
  const clearStoredFiles = (storeName) => fileStoreRequest(storeName, "readwrite", (store) => store.clear());
  const getContractFile = (clientId) => getStoredFile(CONTRACT_STORE, clientId);
  const putContractFile = (clientId, file) => putStoredFile(CONTRACT_STORE, clientId, file);
  const deleteContractFile = (clientId) => deleteStoredFile(CONTRACT_STORE, clientId);
  const getAllContractFiles = () => getAllStoredFiles(CONTRACT_STORE);
  const clearContractFiles = () => clearStoredFiles(CONTRACT_STORE);
  const getIcpFile = (clientId) => getStoredFile(ICP_STORE, clientId);
  const putIcpFile = (clientId, file) => putStoredFile(ICP_STORE, clientId, file);
  const deleteIcpFile = (clientId) => deleteStoredFile(ICP_STORE, clientId);
  const getAllIcpFiles = () => getAllStoredFiles(ICP_STORE);
  const clearIcpFiles = () => clearStoredFiles(ICP_STORE);

  function uid() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function monthDate(year, month, day) {
    return new Date(year, month, clampDay(year, month, day));
  }

  function firstWeekdayOnOrAfter(start, weekday) {
    const result = new Date(start);
    const distance = (Number(weekday) - result.getDay() + 7) % 7;
    result.setDate(result.getDate() + distance);
    return result;
  }

  function generateEvents(rangeStart, rangeEnd, includeInactive = false) {
    rangeStart = startOfDay(rangeStart);
    rangeEnd = endOfDay(rangeEnd);
    const events = [];
    state.clients.forEach((client) => {
      if (!includeInactive && client.status !== "active") return;
      const clientStart = fromISO(client.startDate);
      const effectiveStart = clientStart > rangeStart ? clientStart : rangeStart;
      if (effectiveStart > rangeEnd) return;
      const cadence = initialCadence(client);
      const onboardingEnabled = client.schedules?.onboarding?.enabled ?? true;
      const { schedules = {} } = client;

      if (onboardingEnabled) {
        if (cadence.research >= effectiveStart && cadence.research <= rangeEnd) events.push(buildEvent(client, "research", cadence.research, "", "", { initial: true }));
        if (cadence.firstDelivery >= effectiveStart && cadence.firstDelivery <= rangeEnd) events.push(buildEvent(client, "first_delivery", cadence.firstDelivery, "", schedules.delivery?.leads, { initial: true }));
        if (cadence.feedback >= effectiveStart && cadence.feedback <= rangeEnd) events.push(buildEvent(client, "feedback", cadence.feedback, schedules.feedback?.time, "", { initial: true }));
      }

      for (let cursor = startOfMonth(effectiveStart); cursor <= rangeEnd; cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1)) {
        if (schedules.delivery?.enabled) {
          const date = monthDate(cursor.getFullYear(), cursor.getMonth(), schedules.delivery.day);
          const afterFirstCycle = !onboardingEnabled || (date > cadence.firstDelivery && !isSameMonth(date, cadence.firstDelivery));
          if (afterFirstCycle && date >= effectiveStart && date <= rangeEnd) events.push(buildEvent(client, "delivery", date, "", schedules.delivery.leads));
        }
        if (schedules.feedback?.enabled) {
          const date = monthDate(cursor.getFullYear(), cursor.getMonth(), schedules.feedback.day);
          const afterFirstCycle = !onboardingEnabled || (date > cadence.feedback && !isSameMonth(date, cadence.feedback));
          if (afterFirstCycle && date >= effectiveStart && date <= rangeEnd) events.push(buildEvent(client, "feedback", date, schedules.feedback.time));
        }
      }

      if (client.schedules?.followup?.enabled) {
        const rule = client.schedules.followup;
        const followupStart = onboardingEnabled ? addDays(cadence.firstDelivery, 3) : clientStart;
        const canAddFollowup = (date) => !events.some((event) => event.clientId === client.id && ["first_delivery", "delivery", "feedback"].includes(event.type) && isSameDay(event.date, date));
        if (rule.frequency === "monthly") {
          for (let cursor = startOfMonth(effectiveStart); cursor <= rangeEnd; cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1)) {
            const date = firstWeekdayOnOrAfter(cursor, rule.weekday);
            if (date >= followupStart && date >= effectiveStart && date <= rangeEnd && canAddFollowup(date)) events.push(buildEvent(client, "followup", date, rule.time));
          }
        } else {
          const interval = rule.frequency === "weekly" ? 7 : 14;
          let date = firstWeekdayOnOrAfter(followupStart, rule.weekday);
          while (date < effectiveStart) date = addDays(date, interval);
          while (date <= rangeEnd) {
            if (canAddFollowup(date)) events.push(buildEvent(client, "followup", date, rule.time));
            date = addDays(date, interval);
          }
        }
      }
    });
    return events.sort((a, b) => a.date - b.date || (a.time || "").localeCompare(b.time || ""));
  }

  function buildEvent(client, type, date, time = "", leads = "", metadata = {}) {
    const key = `${client.id}:${type}:${toISO(date)}`;
    return { id: key, clientId: client.id, clientName: client.companyName, clientColor: client.color, type, date, time, leads, ...metadata, completed: Boolean(state.completions[key]) };
  }

  function eventDescription(event) {
    if (event.type === "research") return "Pesquisa de mercado · prazo de 2 dias úteis";
    if (event.type === "first_delivery") return event.leads ? `Primeira listagem · ${event.leads} leads previstos` : "Primeira listagem do cliente";
    if (event.type === "delivery") return event.leads ? `${event.leads} leads previstos` : "Entrega mensal";
    if (event.type === "feedback" && event.initial) return event.time ? `${event.time} · 15 dias após a primeira listagem` : "15 dias após a primeira listagem";
    return event.time ? `${event.time} · ${event.type === "feedback" ? "Reunião mensal" : "Contato recorrente"}` : "Compromisso recorrente";
  }

  function switchView(view) {
    activeView = view;
    $$(".view").forEach((item) => item.classList.remove("active"));
    $(`#${view}View`).classList.add("active");
    $$(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === view));
    const titles = { overview: "Visão geral", calendar: "Agenda de entregas", clients: "Clientes" };
    $("#pageTitle").textContent = titles[view];
    $("#sidebar").classList.remove("open");
    render();
  }

  function render() {
    renderNavigation();
    if (activeView === "overview") renderOverview();
    if (activeView === "calendar") renderCalendar();
    if (activeView === "clients") renderClients();
  }

  function renderNavigation() {
    const today = new Date();
    const nearFuture = addDays(today, 45);
    const events = generateEvents(addDays(today, -365), nearFuture).filter((event) => !event.completed && event.date <= nearFuture);
    const pending = events.filter((event) => event.date <= today).length;
    $("#navPendingCount").textContent = pending;
    const next = events.find((event) => event.date >= new Date(today.getFullYear(), today.getMonth(), today.getDate()));
    $("#sidebarNextTitle").textContent = next ? `${EVENT_LABELS[next.type]} · ${next.clientName}` : "Tudo em dia";
    $("#sidebarNextMeta").textContent = next ? `${LONG_DATE_FORMATTER.format(next.date)}${next.time ? `, às ${next.time}` : ""}` : "Nenhuma pendência próxima";
  }

  function renderOverview() {
    const monthStart = startOfMonth(viewMonth);
    const monthEnd = endOfMonth(viewMonth);
    const events = generateEvents(monthStart, monthEnd);
    const deliveries = events.filter((event) => event.type === "delivery" || event.type === "first_delivery");
    const completed = events.filter((event) => event.completed);
    const now = new Date();
    const pending = generateEvents(addDays(now, -366), now).filter((event) => !event.completed && event.date <= now);

    $("#overviewMonthLabel").textContent = MONTH_FORMATTER.format(viewMonth);
    $("#statDeliveries").textContent = deliveries.length;
    $("#statDeliveriesMeta").textContent = deliveries.length ? plural(new Set(deliveries.map((item) => item.clientId)).size, "cliente atendido", "clientes atendidos") : "Nenhuma programada";
    $("#statPending").textContent = pending.length;
    $("#statPendingMeta").textContent = pending.length ? `${pending.filter((event) => event.date < new Date(now.getFullYear(), now.getMonth(), now.getDate())).length} atrasadas` : "Tudo em ordem";
    $("#statCompleted").textContent = completed.length;
    $("#statCompletedMeta").textContent = `${events.length ? Math.round((completed.length / events.length) * 100) : 0}% do mês`;
    $("#statClients").textContent = state.clients.filter((client) => client.status === "active").length;
    $("#statClientsMeta").textContent = state.clients.length ? `${state.clients.length} na carteira total` : "Nenhum ICP cadastrado";

    const futureEvents = generateEvents(addDays(now, -60), addDays(now, 75))
      .filter((event) => !event.completed)
      .filter((event) => event.date >= addDays(new Date(now.getFullYear(), now.getMonth(), now.getDate()), -7))
      .slice(0, 7);
    $("#upcomingList").innerHTML = futureEvents.length ? futureEvents.map(eventRowHTML).join("") : emptyHTML("Agenda livre", "Cadastre um cliente para gerar as primeiras rotinas.");

    const grouped = new Map();
    pending.forEach((event) => grouped.set(event.clientId, [...(grouped.get(event.clientId) || []), event]));
    const attention = [...grouped.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 5);
    $("#attentionList").innerHTML = attention.length ? attention.map(([clientId, items]) => {
      const client = state.clients.find((item) => item.id === clientId);
      const overdue = items.some((item) => item.date < new Date(now.getFullYear(), now.getMonth(), now.getDate()));
      return `<button class="attention-item ${overdue ? "overdue" : ""}" data-open-client="${clientId}"><i class="attention-bar"></i><div><strong>${escapeHTML(client?.companyName)}</strong><span>${overdue ? "Possui compromissos atrasados" : "Há tarefas para hoje"}</span></div><b class="attention-count">${items.length}</b></button>`;
    }).join("") : emptyHTML("Nenhum alerta", "As pendências dos clientes aparecerão aqui.");
  }

  function eventRowHTML(event) {
    return `<div class="event-row ${event.completed ? "done" : ""}">
      <div class="event-date"><strong>${pad(event.date.getDate())}</strong><span>${SHORT_MONTH.format(event.date).replace(".", "")}</span></div>
      <div class="event-main"><strong>${escapeHTML(event.clientName)}</strong><span>${escapeHTML(eventDescription(event))}</span></div>
      <span class="event-type ${event.type}">${EVENT_LABELS[event.type]}</span>
      <button class="complete-button ${event.completed ? "done" : ""}" data-toggle-event="${event.id}" title="${event.completed ? "Reabrir" : "Marcar como concluído"}">${event.completed ? "✓" : ""}</button>
    </div>`;
  }

  function renderCalendar() {
    $("#calendarMonthLabel").textContent = MONTH_FORMATTER.format(viewMonth);
    const first = startOfMonth(viewMonth);
    const mondayOffset = (first.getDay() + 6) % 7;
    const gridStart = addDays(first, -mondayOffset);
    const gridEnd = addDays(gridStart, 41);
    const allEvents = generateEvents(gridStart, gridEnd);
    const filteredEvents = allEvents.filter((event) => matchesCalendarFilter(event));
    const byDate = filteredEvents.reduce((map, event) => {
      const key = toISO(event.date);
      map[key] = [...(map[key] || []), event];
      return map;
    }, {});

    const days = [];
    for (let i = 0; i < 42; i += 1) {
      const date = addDays(gridStart, i);
      const key = toISO(date);
      const events = byDate[key] || [];
      days.push(`<button class="calendar-day ${date.getMonth() !== viewMonth.getMonth() ? "outside" : ""} ${isSameDay(date, new Date()) ? "today" : ""} ${isSameDay(date, selectedDate) ? "selected" : ""}" data-date="${key}">
        <span class="calendar-date-number">${date.getDate()}</span>
        <span class="calendar-events">${events.slice(0, 3).map((event) => `<span class="calendar-event ${event.type} ${event.completed ? "done" : ""}">${escapeHTML(event.clientName)}</span>`).join("")}${events.length > 3 ? `<span class="more-events">+ ${events.length - 3} outros</span>` : ""}</span>
      </button>`);
    }
    $("#calendarGrid").innerHTML = days.join("");
    renderSelectedDay();
  }

  function renderSelectedDay() {
    $("#selectedDayTitle").textContent = LONG_DATE_FORMATTER.format(selectedDate);
    const dayEvents = generateEvents(selectedDate, selectedDate).filter((event) => matchesCalendarFilter(event));
    $("#selectedDayEvents").innerHTML = dayEvents.length ? dayEvents.map((event) => `<article class="day-event ${event.completed ? "done" : ""}">
      <span class="event-type ${event.type}">${EVENT_LABELS[event.type]}</span>
      <strong>${escapeHTML(event.clientName)}</strong><small>${escapeHTML(eventDescription(event))}</small>
      <div class="day-event-footer"><button class="text-button" data-open-client="${event.clientId}">Ver ICP →</button><button class="complete-button ${event.completed ? "done" : ""}" data-toggle-event="${event.id}">${event.completed ? "✓" : ""}</button></div>
    </article>`).join("") : emptyHTML("Nenhum compromisso", "Este dia está livre.");
  }

  function renderClients() {
    const query = $("#clientSearch").value.trim().toLowerCase();
    const clients = state.clients.filter((client) => {
      if (clientFilter === "active" && client.status !== "active") return false;
      const haystack = [client.companyName, client.icp?.title, client.contract?.service, client.contract?.notes, ...(client.icp?.segments || []), ...(client.icp?.regions || []), ...(client.icp?.states || [])].join(" ").toLowerCase();
      return haystack.includes(query);
    });
    $("#clientGrid").innerHTML = clients.length ? clients.map(clientCardHTML).join("") : emptyHTML(state.clients.length ? "Nada encontrado" : "Sua carteira começa aqui", state.clients.length ? "Tente outro termo ou filtro." : "Adicione o primeiro cliente e as datas serão geradas automaticamente.", true);
  }

  function clientCardHTML(client) {
    const next = generateEvents(new Date(), addDays(new Date(), 90)).find((event) => event.clientId === client.id && !event.completed);
    const tags = [...(client.icp?.segments || []), ...(client.icp?.regions || []), ...(client.icp?.states || [])].slice(0, client.icp?.document ? 3 : 4);
    if (client.icp?.document) tags.unshift("PDF do ICP");
    const statusLabels = { active: "Ativo", paused: "Pausado", closed: "Encerrado" };
    const contract = client.contract || emptyContract(client);
    const volume = formatLeadVolume(contract);
    const validity = contractValidity(client);
    return `<article class="client-card" style="--client-color:${client.color || COLOR_PALETTE[0]}">
      <div class="client-card-header"><div class="client-avatar">${escapeHTML(client.companyName.slice(0, 2).toUpperCase())}</div><span class="status-badge ${client.status}">${statusLabels[client.status]}</span></div>
      <h3>${escapeHTML(client.companyName)}</h3><span class="icp-name">${escapeHTML(client.icp?.title || "ICP ainda sem título")}</span>
      <div class="client-tags">${tags.length ? tags.map((tag) => `<span class="client-tag ${tag === "PDF do ICP" ? "document-tag" : ""}">${escapeHTML(tag)}</span>`).join("") : '<span class="client-tag">Sem segmentação</span>'}</div>
      <div class="client-contract-summary"><div><span>Volume contratado</span><strong>${escapeHTML(volume)}</strong></div><div><span>Vigência</span><strong class="contract-state ${validity.tone}">${escapeHTML(validity.short)}</strong></div></div>
      <div class="client-next"><div><span>Próximo compromisso</span><strong>${next ? `${EVENT_LABELS[next.type]} · ${pad(next.date.getDate())}/${pad(next.date.getMonth() + 1)}` : "Nenhum agendado"}</strong></div><span>→</span></div>
      <div class="client-card-actions"><button data-open-client="${client.id}">Abrir cliente</button><button data-edit-client="${client.id}">Editar</button></div>
    </article>`;
  }

  function formatLeadVolume(contract = {}) {
    if (!contract.leadVolume) return "Não informado";
    const labels = { monthly: "mês", delivery: "entrega", total: "contrato" };
    return `${Number(contract.leadVolume).toLocaleString("pt-BR")} leads / ${labels[contract.leadPeriod] || "mês"}`;
  }

  function contractValidity(client) {
    const contract = client.contract || {};
    if (!contract.endDate) return { short: "Sem término", label: "Prazo não definido", tone: "neutral" };
    const end = fromISO(contract.endDate);
    const today = startOfDay(new Date());
    const days = Math.ceil((end - today) / 86400000);
    if (days < 0) return { short: "Encerrado", label: `Encerrado em ${formatDate(contract.endDate)}`, tone: "expired" };
    if (days === 0) return { short: "Encerra hoje", label: "Encerra hoje", tone: "warning" };
    if (days <= 30) return { short: `${days} dias`, label: `Encerra em ${plural(days, "dia", "dias")}`, tone: "warning" };
    return { short: formatDate(contract.endDate), label: `Vigente até ${formatDate(contract.endDate)}`, tone: "healthy" };
  }

  function emptyHTML(title, description, withAction = false) {
    return `<div class="empty-state"><strong>${title}</strong><span>${description}</span>${withAction ? '<br><button class="text-button" data-new-client>＋ Novo cliente</button>' : ""}</div>`;
  }

  const icpListValue = (values) => values?.length ? values.join(", ") : "Não informado";
  const icpRangeValue = (minimum, maximum) => minimum || maximum ? `${minimum || "—"} a ${maximum || "—"}` : "Não informado";
  const ICP_CHANGE_FIELDS = [
    { label: "Título", value: (icp) => icp.title || "Não informado" },
    { label: "Clientes similares", value: (icp) => icpListValue(icp.similarClients) },
    { label: "Segmentos", value: (icp) => icpListValue(icp.segments) },
    { label: "CNAEs", value: (icp) => icpListValue(icp.cnaes) },
    { label: "Regiões", value: (icp) => icpListValue(icp.regions) },
    { label: "Estados", value: (icp) => icpListValue(icp.states) },
    { label: "Municípios", value: (icp) => icpListValue(icp.cities) },
    { label: "Porte em funcionários", value: (icp) => icpRangeValue(icp.employeesMin, icp.employeesMax) },
    { label: "Faturamento", value: (icp) => icp.revenueRange || "Não informado" },
    { label: "Quantidade de filiais", value: (icp) => icpRangeValue(icp.branchesMin, icp.branchesMax) },
    { label: "Características da empresa", value: (icp) => icp.companyTraits || "Não informado" },
    { label: "Níveis hierárquicos", value: (icp) => icpListValue(icp.personaLevels) },
    { label: "Departamentos", value: (icp) => icpListValue(icp.personaDepartments) },
    { label: "Características da persona", value: (icp) => icp.personaTraits || "Não informado" },
    { label: "Documento do ICP", value: (icp) => icp.document?.name || "Não anexado", compare: (icp) => icp.document ? `${icp.document.name}|${icp.document.size}|${icp.document.updatedAt}` : "" }
  ];

  function describeIcpChanges(previous = {}, current = {}) {
    return ICP_CHANGE_FIELDS.reduce((changes, field) => {
      const previousKey = field.compare ? field.compare(previous) : field.value(previous);
      const currentKey = field.compare ? field.compare(current) : field.value(current);
      if (previousKey !== currentKey) changes.push({ label: field.label, from: field.value(previous), to: field.value(current) });
      return changes;
    }, []);
  }

  function completedEventTimelineEntry(event, completedAt) {
    return {
      id: `${event.clientId}:timeline:${event.id}`,
      type: event.type,
      date: toISO(event.date),
      recordedAt: completedAt,
      sourceEventId: event.id,
      title: completedEventTitle(event.type),
      note: eventDescription(event),
      changes: []
    };
  }

  function toggleCompletion(eventId) {
    const [clientId, , date] = eventId.split(":");
    const client = state.clients.find((item) => item.id === clientId);
    const event = date ? generateEvents(fromISO(date), fromISO(date), true).find((item) => item.id === eventId) : null;
    if (state.completions[eventId]) {
      delete state.completions[eventId];
      if (client?.timeline) client.timeline = client.timeline.filter((entry) => entry.sourceEventId !== eventId);
    } else {
      const completedAt = new Date().toISOString();
      state.completions[eventId] = completedAt;
      if (client && event) {
        client.timeline = Array.isArray(client.timeline) ? client.timeline : initialTimelineForClient(client);
        if (!client.timeline.some((entry) => entry.sourceEventId === eventId)) client.timeline.push(completedEventTimelineEntry(event, completedAt));
      }
    }
    saveState();
    render();
    toast(state.completions[eventId] ? "Compromisso concluído" : "Compromisso reaberto", "O painel foi atualizado.");
  }

  function openClientModal(clientId = null) {
    resetClientForm();
    const client = clientId ? state.clients.find((item) => item.id === clientId) : null;
    if (client) fillClientForm(client);
    $("#clientModalTitle").textContent = client ? `Editar ${client.companyName}` : "Novo cliente";
    $("#deleteClientButton").classList.toggle("hidden", !client);
    $("#icpRevisionContext").classList.toggle("hidden", !client);
    goToFormStep(1);
    $("#clientModal").showModal();
  }

  function resetClientForm() {
    $("#clientForm").reset();
    $("#clientId").value = "";
    $("#startDate").value = toISO(new Date());
    $("#contractStartDate").value = toISO(new Date());
    $("#employeesMin").value = "1";
    $("#employeesMax").value = "10.000+";
    pendingContractFile = null;
    removeStoredContractFile = false;
    pendingIcpFile = null;
    removeStoredIcpFile = false;
    $("#icpRevisionContext").classList.add("hidden");
    renderContractFilePreview();
    renderIcpFilePreview();
    $("#deliveryDay").value = 10;
    $("#feedbackDay").value = 20;
    $("#feedbackTime").value = "10:00";
    $("#followupFrequency").value = "weekly";
    $("#followupWeekday").value = "3";
    $("#followupTime").value = "14:00";
    ["onboardingEnabled", "deliveryEnabled", "feedbackEnabled", "followupEnabled"].forEach((id) => $("#" + id).checked = true);
    updateScheduleCards();
    updateCadencePreview();
  }

  function fillClientForm(client) {
    const icp = client.icp || {};
    const schedules = client.schedules || {};
    const contract = { ...emptyContract(client), ...(client.contract || {}) };
    const values = {
      clientId: client.id, companyName: client.companyName, contactName: client.contactName, ownerName: client.ownerName,
      startDate: client.startDate, clientStatus: client.status, clientLink: client.link, accountNotes: client.notes,
      contractLeadVolume: contract.leadVolume, contractLeadPeriod: contract.leadPeriod, contractStartDate: contract.startDate,
      contractEndDate: contract.endDate, contractService: contract.service, contractNotes: contract.notes,
      icpTitle: icp.title, similarClients: (icp.similarClients || []).join(", "), marketSegments: (icp.segments || []).join(", "),
      cnaes: (icp.cnaes || []).join(", "), states: (icp.states || []).join(", "), cities: (icp.cities || []).join(", "),
      employeesMin: icp.employeesMin, employeesMax: icp.employeesMax, revenueRange: icp.revenueRange,
      branchesMin: icp.branchesMin, branchesMax: icp.branchesMax, companyTraits: icp.companyTraits,
      personaLevels: (icp.personaLevels || []).join(", "), personaDepartments: (icp.personaDepartments || []).join(", "), personaTraits: icp.personaTraits,
      deliveryDay: schedules.delivery?.day, leadsQuantity: schedules.delivery?.leads, feedbackDay: schedules.feedback?.day,
      feedbackTime: schedules.feedback?.time, followupFrequency: schedules.followup?.frequency, followupWeekday: schedules.followup?.weekday, followupTime: schedules.followup?.time
    };
    Object.entries(values).forEach(([id, value]) => { if ($("#" + id) && value !== undefined && value !== null) $("#" + id).value = value; });
    $$('#regions input[type="checkbox"]').forEach((input) => input.checked = (icp.regions || []).includes(input.value));
    $("#deliveryEnabled").checked = schedules.delivery?.enabled ?? true;
    $("#feedbackEnabled").checked = schedules.feedback?.enabled ?? true;
    $("#followupEnabled").checked = schedules.followup?.enabled ?? true;
    $("#onboardingEnabled").checked = schedules.onboarding?.enabled ?? true;
    renderContractFilePreview(contract.document);
    renderIcpFilePreview(icp.document);
    updateScheduleCards();
    updateCadencePreview();
  }

  function goToFormStep(step) {
    currentFormStep = Math.max(1, Math.min(3, step));
    $$(".form-page").forEach((page) => page.classList.toggle("active", Number(page.dataset.step) === currentFormStep));
    $$(".form-step").forEach((item) => item.classList.toggle("active", Number(item.dataset.stepTarget) <= currentFormStep));
    $("#previousStepButton").classList.toggle("hidden", currentFormStep === 1);
    $("#nextStepButton").classList.toggle("hidden", currentFormStep === 3);
    $("#saveClientButton").classList.toggle("hidden", currentFormStep !== 3);
    $("#clientModal .modal-body").scrollTop = 0;
  }

  function validateStep(step) {
    const requiredIds = step === 1 ? ["companyName", "startDate"] : [];
    for (const id of requiredIds) {
      const input = $("#" + id);
      if (!input.value.trim()) { input.reportValidity(); input.focus(); return false; }
    }
    if (step === 1) {
      const start = $("#contractStartDate").value;
      const end = $("#contractEndDate").value;
      $("#contractEndDate").setCustomValidity(start && end && end < start ? "O término do contrato não pode ser anterior ao início." : "");
      if (!$("#contractEndDate").checkValidity()) { $("#contractEndDate").reportValidity(); $("#contractEndDate").focus(); return false; }
    }
    if (step === 2) {
      const id = $("#clientId").value;
      const existingDocument = state.clients.find((client) => client.id === id)?.icp?.document;
      const hasDocument = Boolean(pendingIcpFile || (!removeStoredIcpFile && existingDocument));
      const titleInput = $("#icpTitle");
      titleInput.setCustomValidity(!titleInput.value.trim() && !hasDocument ? "Informe um título de segmentação ou anexe o PDF do ICP." : "");
      if (!titleInput.checkValidity()) { titleInput.reportValidity(); titleInput.focus(); return false; }
    }
    return true;
  }

  function readClientForm() {
    const id = $("#clientId").value || uid();
    const existing = state.clients.find((client) => client.id === id);
    const existingContract = existing?.contract || emptyContract(existing || { startDate: $("#startDate").value });
    const existingIcp = existing?.icp || {};
    const document = removeStoredContractFile ? null : pendingContractFile ? {
      name: pendingContractFile.name, type: pendingContractFile.type, size: pendingContractFile.size, updatedAt: new Date().toISOString()
    } : existingContract.document || null;
    const icpDocument = removeStoredIcpFile ? null : pendingIcpFile ? {
      name: pendingIcpFile.name, type: pendingIcpFile.type || "application/pdf", size: pendingIcpFile.size, updatedAt: new Date().toISOString()
    } : existingIcp.document || null;
    const companyName = $("#companyName").value.trim();
    return {
      id,
      companyName, contactName: $("#contactName").value.trim(), ownerName: $("#ownerName").value.trim(),
      startDate: $("#startDate").value, status: $("#clientStatus").value, link: $("#clientLink").value.trim(), notes: $("#accountNotes").value.trim(),
      color: existing?.color || COLOR_PALETTE[state.clients.length % COLOR_PALETTE.length],
      createdAt: existing?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString(),
      timeline: Array.isArray(existing?.timeline) ? [...existing.timeline] : [],
      contract: {
        leadVolume: $("#contractLeadVolume").value ? Number($("#contractLeadVolume").value) : "",
        leadPeriod: $("#contractLeadPeriod").value,
        startDate: $("#contractStartDate").value,
        endDate: $("#contractEndDate").value,
        service: $("#contractService").value.trim(),
        notes: $("#contractNotes").value.trim(),
        document
      },
      icp: {
        title: $("#icpTitle").value.trim() || `ICP arquivado · ${companyName}`, document: icpDocument,
        similarClients: normalizeList($("#similarClients").value), segments: normalizeList($("#marketSegments").value),
        cnaes: normalizeList($("#cnaes").value), regions: selectedValues($("#regions")), states: normalizeList($("#states").value.toUpperCase()), cities: normalizeList($("#cities").value),
        employeesMin: $("#employeesMin").value, employeesMax: $("#employeesMax").value, revenueRange: $("#revenueRange").value,
        branchesMin: $("#branchesMin").value, branchesMax: $("#branchesMax").value, companyTraits: $("#companyTraits").value.trim(),
        personaLevels: normalizeList($("#personaLevels").value), personaDepartments: normalizeList($("#personaDepartments").value), personaTraits: $("#personaTraits").value.trim()
      },
      schedules: {
        onboarding: { enabled: $("#onboardingEnabled").checked },
        delivery: { enabled: $("#deliveryEnabled").checked, day: Number($("#deliveryDay").value), leads: $("#leadsQuantity").value },
        feedback: { enabled: $("#feedbackEnabled").checked, day: Number($("#feedbackDay").value), time: $("#feedbackTime").value },
        followup: { enabled: $("#followupEnabled").checked, frequency: $("#followupFrequency").value, weekday: Number($("#followupWeekday").value), time: $("#followupTime").value }
      }
    };
  }

  async function saveClient(event) {
    event.preventDefault();
    if (!validateStep(1) || !validateStep(2)) { goToFormStep(!$("#companyName").value || !$("#startDate").value ? 1 : 2); return; }
    const client = readClientForm();
    const index = state.clients.findIndex((item) => item.id === client.id);
    const existing = index >= 0 ? state.clients[index] : null;
    try {
      if (pendingContractFile) await putContractFile(client.id, pendingContractFile);
      else if (removeStoredContractFile) await deleteContractFile(client.id);
      if (pendingIcpFile) await putIcpFile(client.id, pendingIcpFile);
      else if (removeStoredIcpFile) await deleteIcpFile(client.id);
    } catch (error) {
      console.error(error);
      toast("Anexo não salvo", "Não foi possível guardar os documentos neste navegador.");
      return;
    }
    if (existing) {
      const changes = describeIcpChanges(existing.icp || {}, client.icp || {});
      const reason = $("#icpChangeReason").value.trim();
      if (changes.length) {
        client.timeline.push({
          id: `${client.id}:timeline:icp-${Date.now()}`,
          type: "icp_update",
          date: new Date().toISOString(),
          title: "ICP atualizado",
          note: reason || "Alteração registrada na ficha do cliente.",
          changes
        });
      } else if (reason) {
        client.timeline.push({
          id: `${client.id}:timeline:note-${Date.now()}`,
          type: "icp_note",
          date: new Date().toISOString(),
          title: "Observação sobre o ICP",
          note: reason,
          changes: []
        });
      }
      state.clients[index] = client;
    } else {
      client.timeline = initialTimelineForClient(client);
      state.clients.push(client);
    }
    saveState();
    $("#clientModal").close();
    render();
    toast(index >= 0 ? "Cliente atualizado" : "Cliente cadastrado", "As recorrências já estão disponíveis na agenda.");
  }

  async function deleteCurrentClient() {
    const id = $("#clientId").value;
    const client = state.clients.find((item) => item.id === id);
    if (!client || !confirm(`Excluir ${client.companyName}? Esta ação remove o ICP e as regras de recorrência.`)) return;
    state.clients = state.clients.filter((item) => item.id !== id);
    Object.keys(state.completions).filter((key) => key.startsWith(`${id}:`)).forEach((key) => delete state.completions[key]);
    try { await Promise.all([deleteContractFile(id), deleteIcpFile(id)]); } catch (error) { console.warn("Não foi possível remover todos os anexos do cliente.", error); }
    saveState();
    $("#clientModal").close();
    render();
    toast("Cliente excluído", "O cadastro e seus compromissos foram removidos.");
  }

  function openClientDetail(clientId) {
    const client = state.clients.find((item) => item.id === clientId);
    if (!client) return;
    detailClientId = clientId;
    $("#detailClientName").textContent = client.companyName;
    $("#detailClientMeta").textContent = `${client.icp?.title || "Sem título de ICP"} · ${client.status === "active" ? "Cliente ativo" : client.status === "paused" ? "Cliente pausado" : "Cliente encerrado"}`;
    const icp = client.icp || {};
    const contract = { ...emptyContract(client), ...(client.contract || {}) };
    const validity = contractValidity(client);
    const hasStructuredIcp = [icp.segments, icp.similarClients, icp.cnaes, icp.regions, icp.states, icp.cities, icp.personaLevels, icp.personaDepartments]
      .some((values) => values?.length) || Boolean(icp.companyTraits || icp.personaTraits);
    const nextEvents = generateEvents(new Date(), addDays(new Date(), 60)).filter((event) => event.clientId === client.id).slice(0, 4);
    $("#clientDetailBody").innerHTML = `<div class="detail-grid">
      <section class="detail-section full contract-detail-card">
        <div class="contract-detail-heading"><div><span class="eyebrow">CONTRATO & ESCOPO</span><h3>${escapeHTML(contract.service || "Informações contratuais")}</h3></div><span class="contract-status-pill ${validity.tone}">${escapeHTML(validity.label)}</span></div>
        <div class="contract-kpis">
          <div><span>Volume contratado</span><strong>${escapeHTML(formatLeadVolume(contract))}</strong></div>
          <div><span>Início do trabalho</span><strong>${formatDate(contract.startDate)}</strong></div>
          <div><span>Término</span><strong>${formatDate(contract.endDate)}</strong></div>
          <div><span>Documento</span><strong>${contract.document ? escapeHTML(contract.document.name) : "Não anexado"}</strong></div>
        </div>
        ${contract.notes ? `<p class="contract-notes">${escapeHTML(contract.notes)}</p>` : ""}
        ${contract.document ? `<button class="secondary-button compact-button contract-download" data-contract-download="${client.id}">⇩ Baixar contrato</button>` : '<span class="contract-empty-note">Adicione o contrato na edição do cliente para centralizar o documento aqui.</span>'}
      </section>
      ${icp.document ? `<section class="detail-section full icp-document-detail">
        <div class="icp-document-icon">PDF</div>
        <div class="icp-document-copy"><span class="eyebrow">ICP ARQUIVADO</span><h3>${escapeHTML(icp.document.name)}</h3><p>${fileSizeLabel(icp.document.size)} · Documento de referência do perfil ideal deste cliente.</p></div>
        <button class="secondary-button compact-button" data-icp-download="${client.id}">⇩ Baixar PDF do ICP</button>
      </section>` : ""}
      ${timelineDetailHTML(client)}
      <section class="detail-section"><h3>Conta</h3>${detailItem("Contato", client.contactName || "—")}${detailItem("Responsável interno", client.ownerName || "—")}${detailItem("Kickoff", formatDate(client.startDate))}${client.link ? detailItem("Pasta / canal", `<a href="${escapeHTML(client.link)}" target="_blank" rel="noreferrer">Abrir link ↗</a>`, true) : ""}</section>
      ${hasStructuredIcp || !icp.document ? `
        <section class="detail-section"><h3>Segmentação</h3>${detailTags("Segmentos", icp.segments)}${detailTags("Clientes similares", icp.similarClients)}${detailTags("CNAEs", icp.cnaes)}</section>
        <section class="detail-section"><h3>Localização & porte</h3>${detailTags("Regiões", icp.regions)}${detailTags("Estados", icp.states)}${detailTags("Municípios", icp.cities)}${detailItem("Funcionários", `${icp.employeesMin || "1"} a ${icp.employeesMax || "10.000+"}`)}${detailItem("Faturamento", icp.revenueRange || "—")}${detailItem("Filiais", `${icp.branchesMin || "1"} a ${icp.branchesMax || "200+"}`)}</section>
        <section class="detail-section"><h3>Persona</h3>${detailTags("Níveis", icp.personaLevels)}${detailTags("Departamentos", icp.personaDepartments)}${detailItem("Características", icp.personaTraits || "—")}</section>
        <section class="detail-section full"><h3>Critérios específicos</h3>${detailItem("Características da empresa", icp.companyTraits || "—")}${detailItem("Observações da conta", client.notes || "—")}</section>
      ` : `<section class="detail-section full legacy-icp-note"><span>Consulta simplificada</span><strong>Este cliente foi migrado por documento.</strong><p>Os critérios de segmentação, porte e persona estão centralizados no PDF de ICP acima.</p>${client.notes ? detailItem("Observações da conta", client.notes) : ""}</section>`}
      <section class="detail-section full"><h3>Próximos compromissos</h3>${nextEvents.length ? nextEvents.map((event) => `<div class="event-row">${eventRowHTML(event).replace(/^<div class="event-row[^>]*>|<\/div>$/g, "")}</div>`).join("") : '<span class="empty-state">Nenhum compromisso programado.</span>'}</section>
    </div>`;
    $("#clientDetailModal").showModal();
  }

  function detailItem(label, value, raw = false) {
    return `<div class="detail-item"><span>${label}</span><strong>${raw ? value : escapeHTML(value)}</strong></div>`;
  }
  function detailTags(label, values = []) {
    return `<div class="detail-item"><span>${label}</span><div class="detail-tags">${values?.length ? values.map((value) => `<i class="detail-tag">${escapeHTML(value)}</i>`).join("") : '<i class="detail-tag">—</i>'}</div></div>`;
  }
  function formatDate(value) { return value ? new Intl.DateTimeFormat("pt-BR").format(fromISO(value)) : "—"; }

  function timelineDateObject(value) {
    if (!value) return new Date(0);
    return value.includes("T") ? new Date(value) : fromISO(value);
  }

  function timelineDateLabel(value) {
    if (!value) return "Data não informada";
    return TIMELINE_DATE_FORMATTER.format(timelineDateObject(value)).replace(".", "");
  }

  function timelineDetailHTML(client) {
    const entries = [...(client.timeline || initialTimelineForClient(client))].sort((a, b) => timelineDateObject(b.date) - timelineDateObject(a.date));
    const lastIcpEntry = entries.find((entry) => entry.type === "icp_update" || entry.type === "icp_created");
    const lastSummary = lastIcpEntry?.changes?.length
      ? `${lastIcpEntry.changes.slice(0, 2).map((change) => `${change.label}: ${change.to}`).join(" · ")}${lastIcpEntry.changes.length > 2 ? ` +${lastIcpEntry.changes.length - 2}` : ""}`
      : lastIcpEntry?.note || "Nenhuma revisão registrada.";
    const entryHTML = entries.map((entry) => {
      const changes = entry.changes?.length ? `<div class="timeline-changes">${entry.changes.map((change) => `<div class="timeline-change"><span>${escapeHTML(change.label)}</span><del>${escapeHTML(change.from)}</del><b>→</b><ins>${escapeHTML(change.to)}</ins></div>`).join("")}</div>` : "";
      const symbols = { kickoff: "K", icp_created: "◎", icp_update: "↻", icp_note: "✎", research: "P", first_delivery: "1ª", delivery: "L", feedback: "F", followup: "↗" };
      return `<article class="timeline-entry ${entry.type}">
        <div class="timeline-rail"><i>${symbols[entry.type] || "•"}</i></div>
        <div class="timeline-entry-body"><div class="timeline-entry-heading"><strong>${escapeHTML(entry.title)}</strong><time>${timelineDateLabel(entry.date)}</time></div>${entry.note ? `<p>${escapeHTML(entry.note)}</p>` : ""}${changes}</div>
      </article>`;
    }).join("");
    return `<section class="detail-section full timeline-detail">
      <div class="timeline-heading"><div><span class="eyebrow">HISTÓRICO DO CLIENTE</span><h3>Linha do tempo</h3></div><span class="timeline-count">${plural(entries.length, "registro", "registros")}</span></div>
      <div class="latest-icp-card"><div><span>ÚLTIMA VERSÃO DO ICP</span><strong>${lastIcpEntry ? timelineDateLabel(lastIcpEntry.date) : "Sem registro"}</strong></div><p>${escapeHTML(lastSummary)}</p></div>
      <div class="timeline-list">${entryHTML || '<span class="contract-empty-note">A atividade do cliente aparecerá aqui.</span>'}</div>
    </section>`;
  }

  function fileSizeLabel(size = 0) {
    if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
    return `${(size / (1024 * 1024)).toFixed(1).replace(".", ",")} MB`;
  }

  function renderContractFilePreview(document = null) {
    const file = pendingContractFile;
    const metadata = file ? { name: file.name, size: file.size, type: file.type } : (!removeStoredContractFile ? document : null);
    $("#contractFilePreview").classList.toggle("hidden", !metadata);
    $("#contractUploadArea").classList.toggle("has-file", Boolean(metadata));
    if (!metadata) return;
    const extension = metadata.name.split(".").pop()?.toUpperCase() || "DOC";
    $("#contractFileType").textContent = extension.slice(0, 4);
    $("#contractFileName").textContent = metadata.name;
    $("#contractFileMeta").textContent = `${fileSizeLabel(metadata.size)} · ${file ? "pronto para salvar" : "anexado ao cliente"}`;
  }

  function selectContractFile(file) {
    if (!file) return;
    const extension = file.name.split(".").pop()?.toLowerCase();
    if (!ALLOWED_CONTRACT_EXTENSIONS.includes(extension)) {
      toast("Formato não aceito", "Use PDF, DOC, DOCX, PNG ou JPG.");
      $("#contractFile").value = "";
      return;
    }
    if (file.size > MAX_CONTRACT_FILE_SIZE) {
      toast("Arquivo muito grande", "O contrato deve ter no máximo 10 MB.");
      $("#contractFile").value = "";
      return;
    }
    pendingContractFile = file;
    removeStoredContractFile = false;
    renderContractFilePreview();
  }

  function renderIcpFilePreview(document = null) {
    const file = pendingIcpFile;
    const metadata = file ? { name: file.name, size: file.size, type: file.type } : (!removeStoredIcpFile ? document : null);
    $("#icpFilePreview").classList.toggle("hidden", !metadata);
    $("#icpUploadArea").classList.toggle("has-file", Boolean(metadata));
    if (!metadata) return;
    $("#icpFileType").textContent = "PDF";
    $("#icpFileName").textContent = metadata.name;
    $("#icpFileMeta").textContent = `${fileSizeLabel(metadata.size)} · ${file ? "pronto para salvar" : "arquivado no cliente"}`;
  }

  function selectIcpFile(file) {
    if (!file) return;
    const extension = file.name.split(".").pop()?.toLowerCase();
    if (extension !== "pdf") {
      toast("Formato não aceito", "O resumo do ICP deve estar em PDF.");
      $("#icpFile").value = "";
      return;
    }
    if (file.size > MAX_ICP_FILE_SIZE) {
      toast("Arquivo muito grande", "O PDF do ICP deve ter no máximo 10 MB.");
      $("#icpFile").value = "";
      return;
    }
    pendingIcpFile = file;
    removeStoredIcpFile = false;
    const titleInput = $("#icpTitle");
    if (!titleInput.value.trim()) titleInput.value = file.name.replace(/\.pdf$/i, "").replace(/[-_]+/g, " ").trim();
    titleInput.setCustomValidity("");
    renderIcpFilePreview();
  }

  async function downloadContract(clientId) {
    try {
      const stored = await getContractFile(clientId);
      if (!stored?.blob) throw new Error("Arquivo não encontrado");
      const url = URL.createObjectURL(stored.blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = stored.name || "contrato";
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast("Contrato baixado", stored.name || "O arquivo foi preparado.");
    } catch (error) {
      console.error(error);
      toast("Contrato indisponível", "O anexo não foi encontrado neste navegador. Restaure um backup ou anexe novamente.");
    }
  }

  async function downloadIcpDocument(clientId) {
    try {
      const stored = await getIcpFile(clientId);
      if (!stored?.blob) throw new Error("Arquivo não encontrado");
      const url = URL.createObjectURL(stored.blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = stored.name || "resumo-icp.pdf";
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast("PDF do ICP baixado", stored.name || "O arquivo foi preparado.");
    } catch (error) {
      console.error(error);
      toast("PDF do ICP indisponível", "O arquivo não foi encontrado neste navegador. Restaure um backup ou anexe novamente.");
    }
  }

  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  function dataURLToBlob(dataURL) {
    const [header, encoded] = dataURL.split(",");
    const mime = header.match(/data:(.*?);base64/)?.[1] || "application/octet-stream";
    const bytes = atob(encoded);
    const array = new Uint8Array(bytes.length);
    for (let index = 0; index < bytes.length; index += 1) array[index] = bytes.charCodeAt(index);
    return new Blob([array], { type: mime });
  }

  function updateScheduleCards() {
    [["deliveryEnabled", ".delivery-rule"], ["feedbackEnabled", ".feedback-rule"], ["followupEnabled", ".followup-rule"]].forEach(([inputId, card]) => $(card).classList.toggle("disabled", !$("#" + inputId).checked));
    $("#cadenceTimeline").classList.toggle("disabled", !$("#onboardingEnabled").checked);
    $(".labeled-switch .switch-label").textContent = $("#onboardingEnabled").checked ? "Ativa" : "Inativa";
  }

  function updateCadencePreview() {
    const value = $("#startDate").value;
    if (!value) return;
    const dates = initialCadence({ startDate: value });
    const formatter = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short" });
    $("#cadenceKickoffDate").textContent = formatter.format(dates.kickoff).replace(".", "");
    $("#cadenceResearchDate").textContent = formatter.format(dates.research).replace(".", "");
    $("#cadenceFirstDeliveryDate").textContent = formatter.format(dates.firstDelivery).replace(".", "");
    $("#cadenceFeedbackDate").textContent = formatter.format(dates.feedback).replace(".", "");
  }

  function toast(title, message) {
    const item = document.createElement("div");
    item.className = "toast";
    item.innerHTML = `<strong>${escapeHTML(title)}</strong><span>${escapeHTML(message)}</span>`;
    $("#toastRegion").appendChild(item);
    setTimeout(() => item.remove(), 3600);
  }

  async function exportBackup() {
    let contractFiles = [];
    let icpFiles = [];
    try {
      const [storedContracts, storedIcps] = await Promise.all([getAllContractFiles(), getAllIcpFiles()]);
      contractFiles = await Promise.all(storedContracts.map(async (stored) => ({ clientId: stored.clientId, name: stored.name, type: stored.type, size: stored.size, updatedAt: stored.updatedAt, data: await blobToDataURL(stored.blob) })));
      icpFiles = await Promise.all(storedIcps.map(async (stored) => ({ clientId: stored.clientId, name: stored.name, type: stored.type, size: stored.size, updatedAt: stored.updatedAt, data: await blobToDataURL(stored.blob) })));
    } catch (error) {
      console.error(error);
      toast("Backup incompleto", "Os dados foram exportados, mas não foi possível incluir todos os anexos.");
    }
    const blob = new Blob([JSON.stringify({ ...state, contractFiles, icpFiles }, null, 2)], { type: "application/json" });
    const anchor = document.createElement("a");
    anchor.href = URL.createObjectURL(blob);
    anchor.download = `entrega-em-dia-backup-${toISO(new Date())}.json`;
    anchor.click();
    URL.revokeObjectURL(anchor.href);
    toast("Backup exportado", "Guarde o arquivo em um local seguro.");
  }

  async function importBackup(file) {
    if (!file) return;
    try {
      const imported = JSON.parse(await file.text());
      if (!Array.isArray(imported.clients) || typeof imported.completions !== "object") throw new Error("Formato inválido");
      if (!confirm(`Importar ${imported.clients.length} clientes? Os dados atuais serão substituídos.`)) return;
      const contractFiles = Array.isArray(imported.contractFiles) ? imported.contractFiles : [];
      const icpFiles = Array.isArray(imported.icpFiles) ? imported.icpFiles : [];
      delete imported.contractFiles;
      delete imported.icpFiles;
      state = migrateState(imported);
      await Promise.all([clearContractFiles(), clearIcpFiles()]);
      for (const [storeName, files] of [[CONTRACT_STORE, contractFiles], [ICP_STORE, icpFiles]]) {
        for (const stored of files) {
          if (!stored.clientId || !stored.data) continue;
          const blob = dataURLToBlob(stored.data);
          await fileStoreRequest(storeName, "readwrite", (store) => store.put({ clientId: stored.clientId, blob, name: stored.name, type: stored.type || blob.type, size: stored.size || blob.size, updatedAt: stored.updatedAt || new Date().toISOString() }));
        }
      }
      saveState();
      render();
      const attachmentCount = contractFiles.length + icpFiles.length;
      toast("Backup importado", attachmentCount ? `Dados e ${plural(attachmentCount, "anexo", "anexos")} restaurados.` : "Os dados foram restaurados com sucesso.");
    } catch (error) {
      console.error(error);
      toast("Não foi possível importar", "Selecione um backup válido do Entrega em Dia.");
    } finally { $("#importInput").value = ""; }
  }

  function openQuickSearch() {
    $("#searchOverlay").hidden = false;
    $("#quickSearchInput").value = "";
    renderQuickSearch();
    setTimeout(() => $("#quickSearchInput").focus(), 0);
  }

  function renderQuickSearch() {
    const query = $("#quickSearchInput").value.toLowerCase();
    const matches = state.clients.filter((client) => [client.companyName, client.icp?.title, ...(client.icp?.segments || [])].join(" ").toLowerCase().includes(query)).slice(0, 8);
    $("#quickSearchResults").innerHTML = matches.length ? matches.map((client) => `<button class="quick-result" data-quick-client="${client.id}"><div class="client-avatar" style="--client-color:${client.color};background:${client.color}55">${escapeHTML(client.companyName.slice(0,2).toUpperCase())}</div><div><strong>${escapeHTML(client.companyName)}</strong><span>${escapeHTML(client.icp?.title || "Sem título de ICP")}</span></div></button>`).join("") : emptyHTML("Nenhum cliente encontrado", "Tente outro termo.");
  }

  function populateOptions() {
    const employees = ["1", "5", "10", "20", "50", "100", "200", "500", "1.000", "2.000", "5.000", "10.000+"];
    const revenues = ["R$ 100 mil – R$ 500 mil", "R$ 500 mil – R$ 1 mi", "R$ 1 mi – R$ 5 mi", "R$ 5 mi – R$ 20 mi", "R$ 20 mi – R$ 100 mi", "R$ 100 mi – R$ 500 mi", "R$ 500 mi – R$ 1 bi+"];
    [$("#employeesMin"), $("#employeesMax")].forEach((select) => select.innerHTML = employees.map((item) => `<option>${item}</option>`).join(""));
    $("#employeesMax").value = "10.000+";
    $("#revenueRange").innerHTML = revenues.map((item) => `<option>${item}</option>`).join("");
  }

  function bindEvents() {
    $$(".nav-item").forEach((button) => button.addEventListener("click", () => switchView(button.dataset.view)));
    $$('[data-view-link]').forEach((button) => button.addEventListener("click", () => switchView(button.dataset.viewLink)));
    $("#mobileMenu").addEventListener("click", () => $("#sidebar").classList.toggle("open"));
    [$("#newClientButton"), $("#newClientButtonSecondary")].forEach((button) => button.addEventListener("click", () => openClientModal()));
    $("#quickSearchButton").addEventListener("click", openQuickSearch);
    $("#exportButton").addEventListener("click", exportBackup);
    $("#importInput").addEventListener("change", (event) => importBackup(event.target.files[0]));
    $("#clientSearch").addEventListener("input", renderClients);

    [["prevMonth", -1], ["overviewPrevMonth", -1], ["nextMonth", 1], ["overviewNextMonth", 1]].forEach(([id, direction]) => $("#" + id).addEventListener("click", () => { viewMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth() + direction, 1); render(); }));
    $("#todayButton").addEventListener("click", () => { viewMonth = startOfMonth(new Date()); selectedDate = new Date(); renderCalendar(); });
    $("#calendarFilters").addEventListener("click", (event) => {
      const button = event.target.closest("[data-filter]"); if (!button) return;
      calendarFilter = button.dataset.filter; $$("[data-filter]").forEach((item) => item.classList.toggle("active", item === button)); renderCalendar();
    });
    $(".client-filters").addEventListener("click", (event) => {
      const button = event.target.closest("[data-client-filter]"); if (!button) return;
      clientFilter = button.dataset.clientFilter; $$('[data-client-filter]').forEach((item) => item.classList.toggle("active", item === button)); renderClients();
    });

    document.addEventListener("click", (event) => {
      const complete = event.target.closest("[data-toggle-event]"); if (complete) { toggleCompletion(complete.dataset.toggleEvent); return; }
      const open = event.target.closest("[data-open-client]"); if (open) { openClientDetail(open.dataset.openClient); return; }
      const edit = event.target.closest("[data-edit-client]"); if (edit) { openClientModal(edit.dataset.editClient); return; }
      const create = event.target.closest("[data-new-client]"); if (create) { openClientModal(); return; }
      const dateButton = event.target.closest("[data-date]"); if (dateButton) { selectedDate = fromISO(dateButton.dataset.date); if (selectedDate.getMonth() !== viewMonth.getMonth()) viewMonth = startOfMonth(selectedDate); renderCalendar(); }
      const quick = event.target.closest("[data-quick-client]"); if (quick) { $("#searchOverlay").hidden = true; openClientDetail(quick.dataset.quickClient); }
      const contractDownload = event.target.closest("[data-contract-download]"); if (contractDownload) { downloadContract(contractDownload.dataset.contractDownload); return; }
      const icpDownload = event.target.closest("[data-icp-download]"); if (icpDownload) downloadIcpDocument(icpDownload.dataset.icpDownload);
    });

    $$('[data-close-modal]').forEach((button) => button.addEventListener("click", () => $("#clientModal").close()));
    $$('[data-close-detail]').forEach((button) => button.addEventListener("click", () => $("#clientDetailModal").close()));
    $("#clientForm").addEventListener("submit", saveClient);
    $("#nextStepButton").addEventListener("click", () => { if (validateStep(currentFormStep)) goToFormStep(currentFormStep + 1); });
    $("#previousStepButton").addEventListener("click", () => goToFormStep(currentFormStep - 1));
    $$(".form-step").forEach((step) => step.addEventListener("click", () => { const target = Number(step.dataset.stepTarget); if (target < currentFormStep || validateStep(currentFormStep)) goToFormStep(target); }));
    $("#deleteClientButton").addEventListener("click", deleteCurrentClient);
    $("#editFromDetail").addEventListener("click", () => { $("#clientDetailModal").close(); openClientModal(detailClientId); });
    ["onboardingEnabled", "deliveryEnabled", "feedbackEnabled", "followupEnabled"].forEach((id) => $("#" + id).addEventListener("change", updateScheduleCards));
    $("#startDate").addEventListener("change", updateCadencePreview);
    $("#startDate").addEventListener("change", () => { if (!$("#contractStartDate").value) $("#contractStartDate").value = $("#startDate").value; });
    $("#contractStartDate").addEventListener("change", () => $("#contractEndDate").setCustomValidity(""));
    $("#contractEndDate").addEventListener("change", () => $("#contractEndDate").setCustomValidity(""));
    $("#contractFile").addEventListener("change", (event) => selectContractFile(event.target.files[0]));
    $("#removeContractFile").addEventListener("click", () => {
      pendingContractFile = null;
      removeStoredContractFile = true;
      $("#contractFile").value = "";
      renderContractFilePreview();
    });
    $("#icpFile").addEventListener("change", (event) => selectIcpFile(event.target.files[0]));
    $("#removeIcpFile").addEventListener("click", () => {
      pendingIcpFile = null;
      removeStoredIcpFile = true;
      $("#icpFile").value = "";
      renderIcpFilePreview();
    });
    $("#icpTitle").addEventListener("input", () => $("#icpTitle").setCustomValidity(""));

    $("#quickSearchInput").addEventListener("input", renderQuickSearch);
    $("#searchOverlay").addEventListener("click", (event) => { if (event.target === $("#searchOverlay")) $("#searchOverlay").hidden = true; });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") $("#searchOverlay").hidden = true;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); openQuickSearch(); }
    });
  }

  function initialize() {
    populateOptions();
    bindEvents();
    $("#todayLabel").textContent = LONG_DATE_FORMATTER.format(new Date());
    render();
  }

  initialize();
})();
