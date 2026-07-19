import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

const root = process.cwd()

function requiredEnv(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Missing environment variable: ${name}`)
  return value
}

function loadWindowArray(relativePath, globalName) {
  const absolutePath = path.join(root, relativePath)
  if (!fs.existsSync(absolutePath)) return []

  const source = fs.readFileSync(absolutePath, 'utf8')
  const sandbox = { window: {} }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: relativePath, timeout: 2000 })
  const data = sandbox.window[globalName]
  return Array.isArray(data) ? data : []
}

function loadLessons() {
  const lessonsDir = path.join(root, 'data', 'lessons')
  if (!fs.existsSync(lessonsDir)) return []

  return fs.readdirSync(lessonsDir)
    .filter((filename) => /^lesson-\d+\.json$/i.test(filename))
    .map((filename) => {
      const source = fs.readFileSync(path.join(lessonsDir, filename), 'utf8')
      return JSON.parse(source)
    })
    .sort((left, right) => Number(left.number || 0) - Number(right.number || 0))
}

function pageUrl(baseUrl, page, fallback) {
  const target = typeof page === 'string' && page.trim() ? page.trim() : fallback
  return new URL(target, `${baseUrl}/`).toString()
}

function isPublished(lesson) {
  if (lesson.status !== 'available') return false
  if (!lesson.notification?.enabled) return false
  if (!lesson.publishedAt) return true

  const published = new Date(`${lesson.publishedAt}T00:00:00Z`)
  return Number.isFinite(published.getTime()) && published.getTime() <= Date.now()
}

const siteBaseUrl = requiredEnv('SITE_BASE_URL').replace(/\/+$/, '')
const studentId = requiredEnv('STUDENT_ID')
const projectId = requiredEnv('SUPABASE_PROJECT_ID')
const notifySecret = requiredEnv('NOTIFY_WEBHOOK_SECRET')
const selectedLessonId = process.env.LESSON_ID?.trim() || ''

const vocabularyData = loadWindowArray('data/vocabulary-data.js', 'VOCABULARY_DATA')
const grammarData = loadWindowArray('data/grammar-data.js', 'GRAMMAR_DATA')
const lessons = loadLessons().filter((lesson) => {
  if (selectedLessonId && lesson.id !== selectedLessonId) return false
  return isPublished(lesson)
})

if (selectedLessonId && lessons.length === 0) {
  throw new Error(`Lesson ${selectedLessonId} was not found or notification.enabled is not true`)
}

if (lessons.length === 0) {
  console.log('No eligible lessons. Nothing to notify.')
  process.exit(0)
}

const endpoint = process.env.NOTIFY_ENDPOINT?.trim()
  || `https://${projectId}.supabase.co/functions/v1/notify-telegram`
let failures = 0

for (const lesson of lessons) {
  const vocabulary = vocabularyData.find((topic) => topic.id === lesson.vocabularyId)
  const validVocabulary = vocabulary && Array.isArray(vocabulary.words) && vocabulary.words.length > 0
    ? {
        id: vocabulary.id,
        title: vocabulary.title || 'Слова к уроку',
        wordCount: vocabulary.words.length,
        url: pageUrl(
          siteBaseUrl,
          vocabulary.page,
          `vocabulary.html?id=${encodeURIComponent(vocabulary.id)}`,
        ),
      }
    : null

  const explicitGrammarIds = Array.isArray(lesson.grammarIds) ? lesson.grammarIds : []
  const grammarTopics = grammarData
    .filter((topic) => topic.status === 'available')
    .filter((topic) => explicitGrammarIds.includes(topic.id) || topic.linkedLessonId === lesson.id)
    .map((topic) => ({
      id: topic.id,
      title: topic.title || 'Грамматика',
      url: pageUrl(
        siteBaseUrl,
        topic.page,
        `grammar-topic.html?id=${encodeURIComponent(topic.id)}`,
      ),
    }))

  const payload = {
    studentId,
    materialType: 'lesson_bundle',
    materialId: lesson.id,
    notificationVersion: Number(lesson.notification?.version || 1),
    homework: {
      id: lesson.id,
      title: lesson.title || 'Домашняя работа',
      url: pageUrl(
        siteBaseUrl,
        lesson.page,
        `lesson.html?id=${encodeURIComponent(lesson.id)}`,
      ),
    },
    vocabulary: validVocabulary,
    grammar: grammarTopics,
  }

  console.log(`Sending notification for ${lesson.id}...`)
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-notify-secret': notifySecret,
    },
    body: JSON.stringify(payload),
  })

  const result = await response.json().catch(() => ({ error: `HTTP ${response.status}` }))
  if (!response.ok || !result.ok) {
    failures += 1
    console.error(`Failed ${lesson.id}:`, result)
  } else if (result.skipped) {
    console.log(`Skipped ${lesson.id}: ${result.reason}`)
  } else {
    console.log(`Sent ${lesson.id}; Telegram message id: ${result.telegramMessageId}`)
  }
}

if (failures > 0) process.exitCode = 1
