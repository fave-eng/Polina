(() => {
  'use strict';

  const EXPECTED_THREAD_ID = 5;
  const EXPECTED_DIAGNOSTIC_VERSION = 'polina-diagnostics-v2';
  const config = window.APP_CONFIG || {};
  const student = config.student || {};
  const studentId = String(student.id || 'polina').trim().toLowerCase();
  const checksEl = document.getElementById('checks');
  const summaryEl = document.getElementById('main-summary');
  const rawEl = document.getElementById('raw-output');
  const configInfoEl = document.getElementById('config-info');
  const telegramInfoEl = document.getElementById('telegram-info');
  const dbWriteResultEl = document.getElementById('db-write-result');
  const sendResultEl = document.getElementById('send-result');
  const runAllBtn = document.getElementById('run-all');
  const dbWriteBtn = document.getElementById('test-db-write');
  const sendBtn = document.getElementById('send-test-report');
  let supabaseClient = null;
  let lastReport = { startedAt: null, checks: [], health: null, directRows: [], errors: [] };

  const esc = (value) => String(value ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#039;');

  function addKV(target, key, value, mono = false) {
    target.insertAdjacentHTML('beforeend', `<div class="kv"><span>${esc(key)}</span><strong class="${mono ? 'mono' : ''}">${esc(value)}</strong></div>`);
  }

  function renderConfig() {
    configInfoEl.innerHTML = '';
    addKV(configInfoEl, 'student_id', studentId || '—', true);
    addKV(configInfoEl, 'Имя', student.nameRu || student.nameEn || '—');
    addKV(configInfoEl, 'Supabase URL', config.supabase?.url || 'не задан', true);
    addKV(configInfoEl, 'Anon key', config.supabase?.anonKey ? 'есть' : 'НЕТ');
    addKV(configInfoEl, 'cloudSync', String(config.features?.cloudSync !== false));
    addKV(configInfoEl, 'telegramNotifications', String(config.features?.telegramNotifications !== false));
    addKV(configInfoEl, 'Origin', window.location.origin, true);
  }

  function resetChecks() {
    checksEl.innerHTML = '';
    lastReport = { startedAt: new Date().toISOString(), checks: [], health: null, directRows: [], errors: [] };
  }

  function addCheck(name, status, detail) {
    const icon = status === 'ok' ? '✓' : status === 'bad' ? '!' : status === 'warn' ? '!' : '…';
    checksEl.insertAdjacentHTML('beforeend', `<div class="check ${status}"><div class="ico">${icon}</div><div><div class="name">${esc(name)}</div><div class="detail">${esc(detail || '')}</div></div></div>`);
    lastReport.checks.push({ name, status, detail: detail || '' });
  }

  function setSummary(status, text) {
    summaryEl.className = `summary ${status || ''}`.trim();
    summaryEl.textContent = text;
  }

  function getClient() {
    if (supabaseClient) return supabaseClient;
    if (!window.supabase?.createClient) throw new Error('Supabase JS SDK не загрузился');
    const url = String(config.supabase?.url || '').trim();
    const anonKey = String(config.supabase?.anonKey || '').trim();
    if (!url || !anonKey) throw new Error('В config.js отсутствуют supabase.url или supabase.anonKey');
    supabaseClient = window.supabase.createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
    });
    return supabaseClient;
  }

  function functionUrl() {
    const base = String(config.supabase?.url || '').replace(/\/+$/, '');
    return `${base}/functions/v1/notify-telegram`;
  }

  async function invokeDiagnostic(body) {
    const anonKey = String(config.supabase?.anonKey || '').trim();
    const response = await fetch(functionUrl(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'apikey': anonKey,
        'authorization': `Bearer ${anonKey}`
      },
      body: JSON.stringify(body)
    });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    return { ok: response.ok, status: response.status, data };
  }

  function explainFunctionFailure(result) {
    const message = String(result?.data?.error || result?.data?.message || result?.data?.raw || '').trim();
    if (result?.status === 404) return 'Edge Function notify-telegram не найдена или не задеплоена.';
    if (result?.status === 401 && /Unauthorized/i.test(message)) return 'В Supabase, вероятно, задеплоена старая версия notify-telegram: она не знает диагностический запрос и требует webhook secret.';
    if (/Failed to fetch/i.test(message)) return 'Браузер не смог вызвать Edge Function: проверь сеть, URL проекта и CORS.';
    return `HTTP ${result?.status || '—'}${message ? `: ${message}` : ''}`;
  }

  function formatError(error) {
    if (!error) return 'Неизвестная ошибка';
    const code = error.code ? `${error.code}: ` : '';
    const message = error.message || error.error_description || String(error);
    if (/homework_progress_final_dates_check/i.test(message)) {
      return `${code}${message}. Нарушено правило финальной отправки: для нечерновой работы Supabase требует submitted_at и locked_at.`;
    }
    if (/homework_progress_report_check/i.test(message)) {
      return `${code}${message}. Нарушено правило статуса Telegram-отчёта: draft/not_sent, pending/pending|failed или submitted/sent.`;
    }
    if (/Final homework submission is immutable|Submitted homework cannot be changed|Invalid homework status transition/i.test(message)) {
      return `${code}${message}. Сработала защита от изменения уже отправленной домашней работы.`;
    }
    if (/row-level security|permission denied|42501/i.test(message)) {
      return `${code}${message}. Ошибка прав доступа / RLS Supabase.`;
    }
    return `${code}${message}`;
  }

  async function runAll() {
    runAllBtn.disabled = true;
    resetChecks();
    setSummary('', 'Проверяю подключения…');
    telegramInfoEl.innerHTML = '';

    try {
      const hasConfig = Boolean(config.supabase?.url && config.supabase?.anonKey && studentId);
      addCheck('1. config.js', hasConfig ? 'ok' : 'bad', hasConfig ? `Конфигурация загружена для ${studentId}.` : 'Не хватает student_id / Supabase URL / anon key.');
      if (!hasConfig) throw new Error('Некорректный config.js');

      const sdkOk = Boolean(window.supabase?.createClient);
      addCheck('2. Supabase JS SDK', sdkOk ? 'ok' : 'bad', sdkOk ? 'Библиотека @supabase/supabase-js загружена.' : 'CDN Supabase JS не загрузился.');
      if (!sdkOk) throw new Error('Supabase SDK не загрузился');

      const client = getClient();
      const homeworkTable = config.supabase?.tables?.homework || 'homework_progress';
      const readResponse = await client
        .from(homeworkTable)
        .select('student_id,lesson_id,lesson_title,status,checked_at,submitted_at,locked_at,report_status,report_sent_at,report_error,score_correct,score_total,score_percent,answers,legacy_answers,migrated_from_legacy')
        .eq('student_id', studentId)
        .order('lesson_id', { ascending: false })
        .limit(20);

      if (readResponse.error) {
        const detail = formatError(readResponse.error);
        addCheck('3. Supabase Database / чтение homework_progress', 'bad', detail);
        lastReport.errors.push({ stage: 'database_read', error: detail });
      } else {
        lastReport.directRows = readResponse.data || [];
        addCheck('3. Supabase Database / чтение homework_progress', 'ok', `Доступ есть. Получено строк: ${(readResponse.data || []).length}.`);
      }

      let edgeResult;
      try {
        edgeResult = await invokeDiagnostic({ kind: 'diagnostics_health', studentId });
      } catch (error) {
        edgeResult = { ok: false, status: 0, data: { error: error.message || String(error) } };
      }

      if (!edgeResult.ok || edgeResult.data?.diagnosticVersion !== EXPECTED_DIAGNOSTIC_VERSION) {
        const detail = edgeResult.ok
          ? `Функция отвечает, но версия диагностики другая: ${edgeResult.data?.diagnosticVersion || 'не указана'}. Нужен повторный deploy.`
          : explainFunctionFailure(edgeResult);
        addCheck('4. Supabase Edge Function notify-telegram', 'bad', detail);
        lastReport.errors.push({ stage: 'edge_function', error: detail, response: edgeResult });
      } else {
        lastReport.health = edgeResult.data;
        addCheck('4. Supabase Edge Function notify-telegram', 'ok', `Задеплоена нужная версия: ${edgeResult.data.diagnosticVersion}.`);

        const h = edgeResult.data;
        addCheck('5. Edge Function → Supabase (service role)', h.database?.ok ? 'ok' : 'bad', h.database?.ok ? `Сервер читает таблицы Supabase. Строк ДЗ: ${h.database.homeworkRows}.` : (h.database?.error || 'Сервер не может читать Supabase.'));
        addCheck('6. Получатель Telegram', h.recipient?.ok ? 'ok' : 'bad', h.recipient?.ok ? `Получатель найден и включён. thread_id=${h.recipient.threadId ?? 'NULL'}.` : (h.recipient?.error || 'Получатель не найден/выключен.'));

        const threadOk = Number(h.recipient?.threadId) === EXPECTED_THREAD_ID;
        addCheck('7. Тема Telegram', threadOk ? 'ok' : 'bad', threadOk ? `message_thread_id=${EXPECTED_THREAD_ID} — как настроено для уведомлений и отчётов.` : `Сейчас message_thread_id=${h.recipient?.threadId ?? 'NULL'}, ожидалось ${EXPECTED_THREAD_ID}.`);
        addCheck('8. Telegram Bot API / бот', h.telegram?.bot?.ok ? 'ok' : 'bad', h.telegram?.bot?.ok ? `Telegram видит бота @${h.telegram.bot.username || 'без username'}.` : (h.telegram?.bot?.error || 'getMe завершился ошибкой.'));
        addCheck('9. Telegram Bot API / группа', h.telegram?.chat?.ok ? 'ok' : 'bad', h.telegram?.chat?.ok ? `Бот имеет доступ к целевой группе (${h.telegram.chat.type || 'chat'}).` : (h.telegram?.chat?.error || 'Бот не имеет доступа к группе.'));

        if (Array.isArray(h.database?.suspiciousHomework) && h.database.suspiciousHomework.length) {
          addCheck('10. Состояние сохранённых ДЗ', 'warn', `Есть старые/несогласованные записи по текущей state machine: ${h.database.suspiciousHomework.join(', ')}. Это не обязательно текущая ошибка, но их стоит проверить.`);
        } else {
          addCheck('10. Состояние сохранённых ДЗ', 'ok', 'Текущие записи соответствуют ожидаемым статусам draft / pending-report / submitted.');
        }

        telegramInfoEl.innerHTML = '';
        addKV(telegramInfoEl, 'Edge version', h.diagnosticVersion || '—', true);
        addKV(telegramInfoEl, 'Recipient', h.recipient?.ok ? 'найден' : 'ошибка');
        addKV(telegramInfoEl, 'Enabled', String(Boolean(h.recipient?.enabled)));
        addKV(telegramInfoEl, 'message_thread_id', h.recipient?.threadId ?? 'NULL', true);
        addKV(telegramInfoEl, 'Bot API', h.telegram?.bot?.ok ? 'OK' : 'ERROR');
        addKV(telegramInfoEl, 'Доступ к группе', h.telegram?.chat?.ok ? 'OK' : 'ERROR');
      }

      const bad = lastReport.checks.filter((item) => item.status === 'bad');
      const warn = lastReport.checks.filter((item) => item.status === 'warn');
      if (bad.length) {
        setSummary('bad', `Найдена проблема: ${bad[0].name}. Смотри первую красную строку выше.`);
      } else if (warn.length) {
        setSummary('warn', 'Основные подключения работают, но есть предупреждение по сохранённым данным.');
      } else {
        setSummary('ok', 'Все проверенные подключения работают. Теперь можно отдельно проверить запись Supabase и отправку тестового Telegram-отчёта.');
      }
    } catch (error) {
      const detail = formatError(error);
      addCheck('Проверка остановлена', 'bad', detail);
      lastReport.errors.push({ stage: 'fatal', error: detail });
      setSummary('bad', detail);
    } finally {
      lastReport.finishedAt = new Date().toISOString();
      rawEl.textContent = JSON.stringify(lastReport, null, 2);
      runAllBtn.disabled = false;
    }
  }

  async function testDatabaseWrite() {
    dbWriteBtn.disabled = true;
    dbWriteResultEl.innerHTML = '<div class="summary">Проверяю полный путь сохранения ДЗ…</div>';

    const client = getClient();
    const table = config.supabase?.tables?.homework || 'homework_progress';
    const probeId = `__diagnostic_probe__${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    try {
      // Stage 1: real browser/anon/RLS insert of a harmless draft.
      const { error: insertError } = await client.from(table).insert({
        student_id: studentId,
        student_name: student.nameRu || student.nameEn || studentId,
        lesson_id: probeId,
        lesson_title: 'Diagnostics homework write probe',
        status: 'draft',
        answers: {},
        legacy_answers: null,
        migrated_from_legacy: false,
        score_correct: null,
        score_total: null,
        score_percent: null,
        checked_at: null,
        submitted_at: null,
        locked_at: null,
        report_status: 'not_sent',
        report_sent_at: null,
        report_error: null
      });

      if (insertError) {
        throw new Error(`browser_draft_insert: ${formatError(insertError)}`);
      }

      // Stage 2: Edge Function exercises the exact database state machine
      // without sending Telegram, then deletes the technical row.
      const probe = await invokeDiagnostic({
        kind: 'diagnostics_homework_probe',
        studentId,
        lessonId: probeId
      });

      if (!probe.ok || !probe.data?.ok) {
        throw new Error(probe.data?.error || explainFunctionFailure(probe));
      }

      dbWriteResultEl.innerHTML = `<div class="summary ok">✓ Полный путь homework_progress работает: browser draft → submitted_pending_report → submitted → cleanup. Реальные ДЗ не изменялись.</div>`;
      lastReport.databaseWriteProbe = {
        ok: true,
        lessonId: probeId,
        stages: probe.data.stages || null
      };
    } catch (error) {
      const detail = formatError(error);
      dbWriteResultEl.innerHTML = `<div class="summary bad">✕ Ошибка пути homework_progress: ${esc(detail)}</div>`;
      lastReport.errors.push({ stage: 'database_write_probe', error: detail, lessonId: probeId });

      // Best-effort cleanup. Server only accepts IDs with the diagnostics prefix.
      try {
        await invokeDiagnostic({
          kind: 'diagnostics_homework_probe',
          studentId,
          lessonId: probeId
        });
      } catch {}
    } finally {
      rawEl.textContent = JSON.stringify(lastReport, null, 2);
      dbWriteBtn.disabled = false;
    }
  }

  async function sendTestReport() {
    sendBtn.disabled = true;
    sendResultEl.innerHTML = '<div class="summary">Отправляю тестовый отчёт…</div>';
    try {
      const result = await invokeDiagnostic({ kind: 'diagnostics_send_report', studentId, pageUrl: window.location.href });
      if (!result.ok || !result.data?.ok) {
        const message = result.data?.error || explainFunctionFailure(result);
        const retry = result.data?.retryAfterSeconds ? ` Повтори через ${result.data.retryAfterSeconds} сек.` : '';
        throw new Error(`${message}${retry}`);
      }
      if (result.data.skipped) {
        const retry = Number(result.data.retryAfterSeconds || 30);
        sendResultEl.innerHTML = `<div class="summary warn">Тест уже отправлялся совсем недавно. Повтори примерно через ${retry} сек.</div>`;
      } else {
        sendResultEl.innerHTML = `<div class="summary ok">✓ Telegram принял тестовый отчёт. message_id=${esc(result.data.telegramMessageId)}; thread_id=${esc(result.data.threadId)}.</div>`;
      }
    } catch (error) {
      const detail = formatError(error);
      sendResultEl.innerHTML = `<div class="summary bad">✕ Тестовый отчёт не отправлен: ${esc(detail)}</div>`;
      lastReport.errors.push({ stage: 'telegram_test_send', error: detail });
      rawEl.textContent = JSON.stringify(lastReport, null, 2);
    } finally {
      sendBtn.disabled = false;
    }
  }

  async function copyReport() {
    const text = rawEl.textContent || '';
    try {
      await navigator.clipboard.writeText(text);
      const old = document.getElementById('copy-report').textContent;
      document.getElementById('copy-report').textContent = 'Скопировано ✓';
      setTimeout(() => { document.getElementById('copy-report').textContent = old; }, 1300);
    } catch {
      window.prompt('Скопируй отчёт вручную:', text);
    }
  }

  document.getElementById('run-all').addEventListener('click', runAll);
  document.getElementById('test-db-write').addEventListener('click', testDatabaseWrite);
  document.getElementById('send-test-report').addEventListener('click', sendTestReport);
  document.getElementById('copy-report').addEventListener('click', copyReport);
  document.getElementById('reload-page').addEventListener('click', () => window.location.reload());
  renderConfig();
})();
