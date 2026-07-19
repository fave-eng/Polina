/**
 * ТЕХНИЧЕСКИЙ ПРИМЕР. Этот файл не подключён к страницам сайта.
 * Скопируйте объект в data/homework-data.js и замените демонстрационные поля
 * материалами преподавателя.
 */
window.LESSON_TECHNICAL_EXAMPLE = {
  id: "lesson-example",
  number: 1,
  title: "Название урока",
  subtitle: "Краткое описание",
  status: "draft",
  page: "lesson.html?id=lesson-example",
  vocabularyId: "vocab-lesson-example",
  publishedAt: "2026-01-01",
  totalPoints: 10,
  blocks: [
    { type: "info", title: "Информация", text: "Текст преподавателя." },
    { type: "tip", title: "Подсказка", text: "Краткая подсказка." },
    { type: "text", id: "task-text", prompt: "Введите ответ", answer: "" },
    { type: "textarea", id: "task-long", prompt: "Напишите развёрнутый ответ", answer: "" },
    { type: "single", id: "task-single", prompt: "Выберите один вариант", options: ["Вариант A", "Вариант B"], answer: 0 },
    { type: "multiple", id: "task-multiple", prompt: "Выберите несколько вариантов", options: ["Вариант A", "Вариант B"], answer: [0] },
    { type: "select", id: "task-select", prompt: "Выберите вариант", options: ["Вариант A", "Вариант B"], answer: 0 },
    { type: "match", id: "task-match", prompt: "Сопоставьте пары", pairs: [{ left: "A", right: "1" }] },
    { type: "reorder", id: "task-reorder", prompt: "Восстановите порядок", words: ["word", "order"], answer: "word order" },
    { type: "translate", id: "task-translate", prompt: "Переведите предложение", source: "Текст для перевода", answer: "" },
    { type: "audio", id: "task-audio", prompt: "Прослушайте запись", audio: "audio/example.mp3", answer: "" },
    { type: "reading", id: "task-reading", title: "Reading", text: "Текст для чтения.", questions: [] }
  ]
};
