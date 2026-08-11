import { withSupabase } from 'npm:@supabase/server'

const encoder = new TextEncoder()
const DIAGNOSTIC_VERSION = 'polina-diagnostics-v1'
const DIAGNOSTIC_WINDOW_MS = 30_000

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-notify-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: corsHeaders })
}

function secureEqual(left: string, right: string): boolean {
  const a = encoder.encode(left)
  const b = encoder.encode(right)
  if (a.length !== b.length) return false

  let diff = 0
  for (let index = 0; index < a.length; index += 1) {
    diff |= a[index] ^ b[index]
  }
  return diff === 0
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !value) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

function escapeTelegramHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function lessonNumberFrom(homework: any): number {
  const explicit = Number(homework?.number || 0)
  if (Number.isFinite(explicit) && explicit > 0) return explicit
  const match = String(homework?.id || '').match(/lesson-(\d+)/i)
  return match ? Number(match[1]) : 0
}

function lessonLabel(homework: any): string {
  const number = lessonNumberFrom(homework)
  return number > 0 ? `Lesson ${number}` : String(homework?.id || 'Домашняя работа')
}

function buildPublicationMessage(homework: any, hasVocabulary: boolean): string {
  const label = escapeTelegramHtml(lessonLabel(homework))
  const title = escapeTelegramHtml(homework?.title || 'Домашняя работа')
  const header = [
    '🚀 <b>Новая домашняя работа уже доступна!</b>',
    '',
    `📚 <b>${label}</b>`,
    `🧩 <b>Тема:</b> ${title}`,
    '',
  ]

  if (hasVocabulary) {
    return [
      ...header,
      'Сначала изучи слова к уроку — так выполнять домашнюю работу будет легче. Затем переходи к заданиям.',
      '',
      'Удачи! Если что-то будет непонятно, отметь вопросы — разберём их на следующем уроке ✨',
    ].join('\n')
  }

  return [
    ...header,
    'Переходи к заданиям. Если что-то будет непонятно, отметь вопросы — разберём их на следующем уроке.',
    '',
    'Удачи! ✨',
  ].join('\n')
}

function buildHomeworkReportMessage(row: any): string {
  const numberMatch = String(row.lesson_id || '').match(/lesson-(\d+)/i)
  const label = numberMatch ? `Lesson ${numberMatch[1]}` : String(row.lesson_id || 'Домашняя работа')
  const studentName = escapeTelegramHtml(row.student_name || row.student_id || 'Ученик')
  const title = escapeTelegramHtml(row.lesson_title || 'Домашняя работа')
  const correct = Number(row.score_correct)
  const total = Number(row.score_total)
  const percent = Number(row.score_percent)

  const scoreLine = Number.isFinite(correct) && Number.isFinite(total) && total > 0
    ? `🎯 <b>Результат:</b> ${correct} из ${total}${Number.isFinite(percent) ? ` (${percent}%)` : ''}`
    : '🎯 <b>Результат:</b> работа отправлена без автоматического балла'

  return [
    '✅ <b>Домашняя работа отправлена</b>',
    '',
    `👤 <b>Ученик:</b> ${studentName}`,
    `📚 <b>${escapeTelegramHtml(label)}</b>`,
    `🧩 <b>Тема:</b> ${title}`,
    scoreLine,
  ].join('\n')
}

async function sendTelegramMessage(
  token: string,
  chatId: number,
  messageThreadId: number | null,
  text: string,
  inlineKeyboard: Array<Array<{ text: string; url: string }>> = [],
) {
  const requestBody: Record<string, unknown> = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
  }

  if (inlineKeyboard.length > 0) {
    requestBody.reply_markup = { inline_keyboard: inlineKeyboard }
  }

  if (messageThreadId) requestBody.message_thread_id = messageThreadId

  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(requestBody),
  })

  const result = await response.json().catch(() => null)
  if (!response.ok || !result?.ok) {
    const description = result?.description || `Telegram HTTP ${response.status}`
    throw new Error(description)
  }

  return result.result
}

async function loadRecipient(ctx: any, studentId: string) {
  const { data: recipient, error: recipientError } = await ctx.supabaseAdmin
    .from('telegram_recipients')
    .select('chat_id, message_thread_id, enabled')
    .eq('student_id', studentId)
    .maybeSingle()

  if (recipientError) throw new Error(recipientError.message)
  if (!recipient || !recipient.enabled) return null
  return recipient
}

async function claimPublication(
  ctx: any,
  studentId: string,
  materialType: string,
  materialId: string,
  notificationVersion: number,
  payload: any,
) {
  const { data: existing, error: existingError } = await ctx.supabaseAdmin
    .from('material_publications')
    .select('id, status, telegram_message_id')
    .eq('student_id', studentId)
    .eq('material_type', materialType)
    .eq('material_id', materialId)
    .eq('notification_version', notificationVersion)
    .maybeSingle()

  if (existingError) throw new Error(existingError.message)

  if (existing?.status === 'sent') {
    return {
      skipped: true,
      reason: 'already_sent',
      telegramMessageId: existing.telegram_message_id,
      publicationId: existing.id,
    }
  }

  if (existing?.id) {
    const { error } = await ctx.supabaseAdmin
      .from('material_publications')
      .update({ status: 'pending', payload, error_message: null })
      .eq('id', existing.id)

    if (error) throw new Error(error.message)
    return { skipped: false, publicationId: existing.id }
  }

  const { data: created, error } = await ctx.supabaseAdmin
    .from('material_publications')
    .insert({
      student_id: studentId,
      material_type: materialType,
      material_id: materialId,
      notification_version: notificationVersion,
      status: 'pending',
      payload,
    })
    .select('id')
    .single()

  if (error) {
    if (error.code === '23505') {
      return { skipped: true, reason: 'already_claimed' }
    }
    throw new Error(error.message)
  }

  return { skipped: false, publicationId: created.id }
}

async function markPublicationSent(ctx: any, publicationId: string, telegramMessageId: number) {
  const { error } = await ctx.supabaseAdmin
    .from('material_publications')
    .update({
      status: 'sent',
      telegram_message_id: telegramMessageId,
      sent_at: new Date().toISOString(),
      error_message: null,
    })
    .eq('id', publicationId)

  if (error) throw new Error(`Telegram sent, but log update failed: ${error.message}`)
}

async function markPublicationFailed(ctx: any, publicationId: string | undefined, message: string) {
  if (!publicationId) return
  await ctx.supabaseAdmin
    .from('material_publications')
    .update({ status: 'failed', error_message: message })
    .eq('id', publicationId)
}

async function handleHomeworkReport(ctx: any, botToken: string, payload: any) {
  const studentId = typeof payload.studentId === 'string' ? payload.studentId.trim() : ''
  const lessonId = typeof payload.lessonId === 'string' ? payload.lessonId.trim() : ''
  const requestedSubmittedAt = Date.parse(String(payload.submittedAt || ''))

  if (!studentId || !lessonId || !Number.isFinite(requestedSubmittedAt)) {
    return jsonResponse({ ok: false, error: 'Missing or invalid homework report identity' }, 400)
  }

  const { data: row, error: rowError } = await ctx.supabaseAdmin
    .from('homework_progress')
    .select('student_id, student_name, lesson_id, lesson_title, status, score_correct, score_total, score_percent, submitted_at')
    .eq('student_id', studentId)
    .eq('lesson_id', lessonId)
    .maybeSingle()

  if (rowError) return jsonResponse({ ok: false, error: rowError.message }, 500)
  if (!row || row.status !== 'submitted' || !row.submitted_at) {
    return jsonResponse({ ok: false, error: 'Homework is not submitted yet' }, 409)
  }

  const actualSubmittedAt = Date.parse(String(row.submitted_at))
  if (!Number.isFinite(actualSubmittedAt) || Math.abs(actualSubmittedAt - requestedSubmittedAt) > 5000) {
    return jsonResponse({ ok: false, error: 'Submission timestamp does not match the saved homework' }, 409)
  }

  // Browser sends this request immediately after successful cloud save.
  // This time window prevents old submitted lessons from being replayed through the public endpoint.
  if (Date.now() - actualSubmittedAt > 2 * 60 * 60 * 1000) {
    return jsonResponse({ ok: false, error: 'Homework report request is too old' }, 409)
  }

  let recipient
  try {
    recipient = await loadRecipient(ctx, studentId)
  } catch (error) {
    return jsonResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500)
  }

  if (!recipient) {
    return jsonResponse({ ok: false, error: 'Telegram recipient is not connected or is disabled' }, 404)
  }

  const reportPayload = {
    kind: 'homework_report',
    studentId,
    lessonId,
    submittedAt: row.submitted_at,
    lessonTitle: row.lesson_title,
    scoreCorrect: row.score_correct,
    scoreTotal: row.score_total,
    scorePercent: row.score_percent,
  }

  let claim: any
  try {
    claim = await claimPublication(
      ctx,
      studentId,
      'homework_submission',
      lessonId,
      1,
      reportPayload,
    )
  } catch (error) {
    return jsonResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500)
  }

  if (claim.skipped) {
    return jsonResponse({
      ok: true,
      skipped: true,
      reason: claim.reason,
      telegramMessageId: claim.telegramMessageId ?? null,
    })
  }

  try {
    const threadId = recipient.message_thread_id == null
      ? null
      : Number(recipient.message_thread_id)

    const telegramMessage = await sendTelegramMessage(
      botToken,
      Number(recipient.chat_id),
      threadId,
      buildHomeworkReportMessage(row),
    )

    await markPublicationSent(ctx, claim.publicationId, telegramMessage.message_id)

    return jsonResponse({
      ok: true,
      skipped: false,
      telegramMessageId: telegramMessage.message_id,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await markPublicationFailed(ctx, claim.publicationId, message)
    return jsonResponse({ ok: false, error: message }, 502)
  }
}

async function handleMaterialPublication(req: Request, ctx: any, botToken: string, payload: any) {
  const expectedSecret = Deno.env.get('NOTIFY_WEBHOOK_SECRET') ?? ''
  const actualSecret = req.headers.get('x-notify-secret') ?? ''
  if (!expectedSecret || !secureEqual(actualSecret, expectedSecret)) {
    return jsonResponse({ ok: false, error: 'Unauthorized' }, 401)
  }

  const studentId = typeof payload.studentId === 'string' ? payload.studentId.trim() : ''
  const materialType = typeof payload.materialType === 'string' ? payload.materialType.trim() : ''
  const materialId = typeof payload.materialId === 'string' ? payload.materialId.trim() : ''
  const notificationVersion = Number(payload.notificationVersion)
  const homework = payload.homework
  const vocabulary = payload.vocabulary
  const grammar = Array.isArray(payload.grammar) ? payload.grammar : []

  if (!studentId || !materialType || !materialId || !Number.isInteger(notificationVersion) || notificationVersion < 1) {
    return jsonResponse({ ok: false, error: 'Missing or invalid notification identity' }, 400)
  }

  if (!homework || !isHttpUrl(homework.url)) {
    return jsonResponse({ ok: false, error: 'A valid homework URL is required' }, 400)
  }

  if (vocabulary && !isHttpUrl(vocabulary.url)) {
    return jsonResponse({ ok: false, error: 'Invalid vocabulary URL' }, 400)
  }

  for (const item of grammar) {
    if (!item || !isHttpUrl(item.url)) {
      return jsonResponse({ ok: false, error: 'Invalid grammar URL' }, 400)
    }
  }

  let recipient
  try {
    recipient = await loadRecipient(ctx, studentId)
  } catch (error) {
    return jsonResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500)
  }

  if (!recipient) {
    return jsonResponse({ ok: false, error: 'Telegram recipient is not connected or is disabled' }, 404)
  }

  let claim: any
  try {
    claim = await claimPublication(
      ctx,
      studentId,
      materialType,
      materialId,
      notificationVersion,
      payload,
    )
  } catch (error) {
    return jsonResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500)
  }

  if (claim.skipped) {
    return jsonResponse({
      ok: true,
      skipped: true,
      reason: claim.reason,
      telegramMessageId: claim.telegramMessageId ?? null,
    })
  }

  const keyboard: Array<Array<{ text: string; url: string }>> = []
  if (vocabulary) keyboard.push([{ text: '💥 Открыть словарь', url: vocabulary.url }])
  keyboard.push([{ text: '📝 Перейти к заданию', url: homework.url }])

  grammar.forEach((item: any, index: number) => {
    const label = grammar.length === 1
      ? '📐 Повторить грамматику'
      : `📐 ${String(item.title || `Грамматика ${index + 1}`).slice(0, 48)}`
    keyboard.push([{ text: label, url: item.url }])
  })

  try {
    const threadId = recipient.message_thread_id == null
      ? null
      : Number(recipient.message_thread_id)

    const telegramMessage = await sendTelegramMessage(
      botToken,
      Number(recipient.chat_id),
      threadId,
      buildPublicationMessage(homework, Boolean(vocabulary)),
      keyboard,
    )

    await markPublicationSent(ctx, claim.publicationId, telegramMessage.message_id)

    return jsonResponse({
      ok: true,
      skipped: false,
      telegramMessageId: telegramMessage.message_id,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await markPublicationFailed(ctx, claim.publicationId, message)
    return jsonResponse({ ok: false, error: message }, 502)
  }
}


async function callTelegramApi(token: string, method: string, body: Record<string, unknown> = {}) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

  const result = await response.json().catch(() => null)
  if (!response.ok || !result?.ok) {
    const description = result?.description || `Telegram HTTP ${response.status}`
    return { ok: false, error: description, status: response.status }
  }

  return { ok: true, result: result.result }
}

async function handleDiagnosticsHealth(ctx: any, botToken: string, payload: any) {
  const studentId = typeof payload.studentId === 'string' ? payload.studentId.trim() : ''
  if (!studentId) return jsonResponse({ ok: false, error: 'Missing studentId' }, 400)

  const output: any = {
    ok: true,
    diagnosticVersion: DIAGNOSTIC_VERSION,
    checkedAt: new Date().toISOString(),
    database: { ok: false, homeworkRows: 0, suspiciousHomework: [] },
    recipient: { ok: false, enabled: false, threadId: null },
    telegram: {
      bot: { ok: false },
      chat: { ok: false },
    },
  }

  let recipient: any = null
  try {
    const { data, error } = await ctx.supabaseAdmin
      .from('telegram_recipients')
      .select('chat_id, message_thread_id, enabled')
      .eq('student_id', studentId)
      .maybeSingle()

    if (error) throw new Error(error.message)
    recipient = data
    if (recipient) {
      output.recipient = {
        ok: Boolean(recipient.enabled),
        enabled: Boolean(recipient.enabled),
        threadId: recipient.message_thread_id == null ? null : Number(recipient.message_thread_id),
        error: recipient.enabled ? null : 'Recipient is disabled',
      }
    } else {
      output.recipient.error = 'Recipient not found'
    }
  } catch (error) {
    output.recipient.error = error instanceof Error ? error.message : String(error)
  }

  try {
    const { data: rows, error } = await ctx.supabaseAdmin
      .from('homework_progress')
      .select('lesson_id, status, checked_at, submitted_at, updated_at')
      .eq('student_id', studentId)
      .order('updated_at', { ascending: false })
      .limit(50)

    if (error) throw new Error(error.message)
    const homeworkRows = Array.isArray(rows) ? rows : []
    const suspicious = homeworkRows
      .filter((row: any) => row?.status !== 'draft' && (!row?.checked_at || !row?.submitted_at))
      .map((row: any) => String(row.lesson_id || 'unknown'))
      .slice(0, 10)

    const { data: publications, error: publicationsError } = await ctx.supabaseAdmin
      .from('material_publications')
      .select('material_type, material_id, status, error_message, sent_at, created_at')
      .eq('student_id', studentId)
      .order('created_at', { ascending: false })
      .limit(8)

    if (publicationsError) throw new Error(publicationsError.message)

    output.database = {
      ok: true,
      homeworkRows: homeworkRows.length,
      suspiciousHomework: suspicious,
      recentPublications: publications || [],
    }
  } catch (error) {
    output.database = {
      ok: false,
      homeworkRows: 0,
      suspiciousHomework: [],
      error: error instanceof Error ? error.message : String(error),
    }
  }

  if (!botToken) {
    output.telegram.bot = { ok: false, error: 'TELEGRAM_BOT_TOKEN is not configured' }
    output.telegram.chat = { ok: false, error: 'Bot token is missing' }
    return jsonResponse(output)
  }

  const botCheck = await callTelegramApi(botToken, 'getMe')
  output.telegram.bot = botCheck.ok
    ? { ok: true, username: botCheck.result?.username || null }
    : { ok: false, error: botCheck.error || 'getMe failed' }

  if (!recipient) {
    output.telegram.chat = { ok: false, error: 'Recipient is not configured' }
  } else {
    const chatCheck = await callTelegramApi(botToken, 'getChat', { chat_id: Number(recipient.chat_id) })
    output.telegram.chat = chatCheck.ok
      ? { ok: true, type: chatCheck.result?.type || null, title: chatCheck.result?.title || null }
      : { ok: false, error: chatCheck.error || 'getChat failed' }
  }

  return jsonResponse(output)
}

async function handleDiagnosticsSendReport(req: Request, ctx: any, botToken: string, payload: any) {
  const origin = req.headers.get('origin') || ''
  if (origin !== 'https://fave-eng.github.io') {
    return jsonResponse({ ok: false, error: 'Diagnostic test sending is allowed only from the published English Space site' }, 403)
  }

  const studentId = typeof payload.studentId === 'string' ? payload.studentId.trim() : ''
  if (!studentId) return jsonResponse({ ok: false, error: 'Missing studentId' }, 400)

  let recipient
  try {
    recipient = await loadRecipient(ctx, studentId)
  } catch (error) {
    return jsonResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500)
  }

  if (!recipient) {
    return jsonResponse({ ok: false, error: 'Telegram recipient is not connected or is disabled' }, 404)
  }

  const now = Date.now()
  const bucket = Math.floor(now / DIAGNOSTIC_WINDOW_MS)
  const notificationVersion = bucket > 0 ? bucket : 1
  const retryAfterSeconds = Math.max(1, Math.ceil((DIAGNOSTIC_WINDOW_MS - (now % DIAGNOSTIC_WINDOW_MS)) / 1000))
  const threadId = recipient.message_thread_id == null ? null : Number(recipient.message_thread_id)

  let claim: any
  try {
    claim = await claimPublication(
      ctx,
      studentId,
      'diagnostic',
      'telegram-report-test',
      notificationVersion,
      {
        kind: 'diagnostics_send_report',
        diagnosticVersion: DIAGNOSTIC_VERSION,
        requestedAt: new Date(now).toISOString(),
        pageUrl: typeof payload.pageUrl === 'string' ? payload.pageUrl.slice(0, 500) : null,
      },
    )
  } catch (error) {
    return jsonResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500)
  }

  if (claim.skipped) {
    return jsonResponse({
      ok: true,
      skipped: true,
      reason: claim.reason,
      telegramMessageId: claim.telegramMessageId ?? null,
      threadId,
      retryAfterSeconds,
    })
  }

  const text = [
    '🧪 <b>ТЕСТОВЫЙ ОТЧЁТ</b>',
    '',
    `👤 <b>Ученик:</b> ${escapeTelegramHtml(studentId === 'polina' ? 'Полина' : studentId)}`,
    '📚 <b>Диагностика подключения</b>',
    '🧩 <b>Тема:</b> проверка сайта → Supabase → Edge Function → Telegram',
    `🧵 <b>Telegram thread:</b> ${threadId ?? 'general'}`,
    '🎯 <b>Результат:</b> тестовое сообщение успешно дошло до Telegram',
    '',
    `<code>${escapeTelegramHtml(new Date(now).toISOString())}</code>`,
  ].join('\n')

  try {
    const telegramMessage = await sendTelegramMessage(
      botToken,
      Number(recipient.chat_id),
      threadId,
      text,
    )

    await markPublicationSent(ctx, claim.publicationId, telegramMessage.message_id)
    return jsonResponse({
      ok: true,
      skipped: false,
      diagnosticVersion: DIAGNOSTIC_VERSION,
      telegramMessageId: telegramMessage.message_id,
      threadId,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await markPublicationFailed(ctx, claim.publicationId, message)
    return jsonResponse({ ok: false, error: message, threadId }, 502)
  }
}

export default {
  fetch: withSupabase({ auth: 'none' }, async (req, ctx) => {
    if (req.method === 'OPTIONS') {
      return new Response('ok', { headers: corsHeaders })
    }

    if (req.method !== 'POST') {
      return jsonResponse({ ok: false, error: 'Method not allowed' }, 405)
    }

    const botToken = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? ''
    if (!botToken) {
      return jsonResponse({ ok: false, error: 'TELEGRAM_BOT_TOKEN is not configured' }, 500)
    }

    let payload: any
    try {
      payload = await req.json()
    } catch {
      return jsonResponse({ ok: false, error: 'Invalid JSON' }, 400)
    }

    if (payload?.kind === 'diagnostics_health') {
      return handleDiagnosticsHealth(ctx, botToken, payload)
    }

    if (payload?.kind === 'diagnostics_send_report') {
      return handleDiagnosticsSendReport(req, ctx, botToken, payload)
    }

    if (payload?.kind === 'homework_report') {
      return handleHomeworkReport(ctx, botToken, payload)
    }

    return handleMaterialPublication(req, ctx, botToken, payload)
  }),
}
