import { withSupabase } from 'npm:@supabase/server'

const encoder = new TextEncoder()

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

function buildMessage(hasVocabulary: boolean): string {
  if (hasVocabulary) {
    return [
      '🚀 <b>Новые материалы уже доступны!</b>',
      '',
      'Сначала изучи слова к уроку — так выполнять домашнюю работу будет легче. Затем переходи к заданиям.',
      '',
      'Удачи! Если что-то будет непонятно, отметь вопросы — разберём их на следующем уроке ✨',
    ].join('\n')
  }

  return [
    '🚀 <b>Новая домашняя работа уже доступна!</b>',
    '',
    'Переходи к заданиям. Если что-то будет непонятно, отметь вопросы — разберём их на следующем уроке.',
    '',
    'Удачи! ✨',
  ].join('\n')
}

async function sendTelegramMessage(
  token: string,
  chatId: number,
  messageThreadId: number | null,
  text: string,
  inlineKeyboard: Array<Array<{ text: string; url: string }>>,
) {
  const requestBody: Record<string, unknown> = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    reply_markup: { inline_keyboard: inlineKeyboard },
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

export default {
  fetch: withSupabase({ auth: 'none' }, async (req, ctx) => {
    if (req.method !== 'POST') {
      return Response.json({ ok: false, error: 'Method not allowed' }, { status: 405 })
    }

    const expectedSecret = Deno.env.get('NOTIFY_WEBHOOK_SECRET') ?? ''
    const actualSecret = req.headers.get('x-notify-secret') ?? ''
    if (!expectedSecret || !secureEqual(actualSecret, expectedSecret)) {
      return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
    }

    const botToken = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? ''
    if (!botToken) {
      return Response.json({ ok: false, error: 'TELEGRAM_BOT_TOKEN is not configured' }, { status: 500 })
    }

    let payload: any
    try {
      payload = await req.json()
    } catch {
      return Response.json({ ok: false, error: 'Invalid JSON' }, { status: 400 })
    }

    const studentId = typeof payload.studentId === 'string' ? payload.studentId.trim() : ''
    const materialType = typeof payload.materialType === 'string' ? payload.materialType.trim() : ''
    const materialId = typeof payload.materialId === 'string' ? payload.materialId.trim() : ''
    const notificationVersion = Number(payload.notificationVersion)
    const homework = payload.homework
    const vocabulary = payload.vocabulary
    const grammar = Array.isArray(payload.grammar) ? payload.grammar : []

    if (!studentId || !materialType || !materialId || !Number.isInteger(notificationVersion) || notificationVersion < 1) {
      return Response.json({ ok: false, error: 'Missing or invalid notification identity' }, { status: 400 })
    }

    if (!homework || !isHttpUrl(homework.url)) {
      return Response.json({ ok: false, error: 'A valid homework URL is required' }, { status: 400 })
    }

    if (vocabulary && !isHttpUrl(vocabulary.url)) {
      return Response.json({ ok: false, error: 'Invalid vocabulary URL' }, { status: 400 })
    }

    for (const item of grammar) {
      if (!item || !isHttpUrl(item.url)) {
        return Response.json({ ok: false, error: 'Invalid grammar URL' }, { status: 400 })
      }
    }

    const { data: recipient, error: recipientError } = await ctx.supabaseAdmin
      .from('telegram_recipients')
      .select('chat_id, message_thread_id, enabled')
      .eq('student_id', studentId)
      .maybeSingle()

    if (recipientError) {
      return Response.json({ ok: false, error: recipientError.message }, { status: 500 })
    }
    if (!recipient || !recipient.enabled) {
      return Response.json(
        { ok: false, error: 'Telegram recipient is not connected or is disabled' },
        { status: 404 },
      )
    }

    const { data: existing, error: existingError } = await ctx.supabaseAdmin
      .from('material_publications')
      .select('id, status, telegram_message_id')
      .eq('student_id', studentId)
      .eq('material_type', materialType)
      .eq('material_id', materialId)
      .eq('notification_version', notificationVersion)
      .maybeSingle()

    if (existingError) {
      return Response.json({ ok: false, error: existingError.message }, { status: 500 })
    }

    if (existing?.status === 'sent') {
      return Response.json({
        ok: true,
        skipped: true,
        reason: 'already_sent',
        telegramMessageId: existing.telegram_message_id,
      })
    }

    let publicationId = existing?.id as string | undefined

    if (publicationId) {
      const { error } = await ctx.supabaseAdmin
        .from('material_publications')
        .update({ status: 'pending', payload, error_message: null })
        .eq('id', publicationId)

      if (error) return Response.json({ ok: false, error: error.message }, { status: 500 })
    } else {
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
          return Response.json({ ok: true, skipped: true, reason: 'already_claimed' })
        }
        return Response.json({ ok: false, error: error.message }, { status: 500 })
      }
      publicationId = created.id
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
        buildMessage(Boolean(vocabulary)),
        keyboard,
      )

      const { error: updateError } = await ctx.supabaseAdmin
        .from('material_publications')
        .update({
          status: 'sent',
          telegram_message_id: telegramMessage.message_id,
          sent_at: new Date().toISOString(),
          error_message: null,
        })
        .eq('id', publicationId)

      if (updateError) {
        throw new Error(`Telegram sent, but log update failed: ${updateError.message}`)
      }

      return Response.json({
        ok: true,
        skipped: false,
        telegramMessageId: telegramMessage.message_id,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await ctx.supabaseAdmin
        .from('material_publications')
        .update({ status: 'failed', error_message: message })
        .eq('id', publicationId)

      return Response.json({ ok: false, error: message }, { status: 502 })
    }
  }),
}
