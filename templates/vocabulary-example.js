/**
 * ТЕХНИЧЕСКИЙ ПРИМЕР. Файл не подключён к ученическому сайту.
 */
window.VOCABULARY_TECHNICAL_EXAMPLE = {
  id: "vocab-example",
  title: "Название темы",
  label: "Урок",
  icon: "💬",
  type: "lesson",
  linkedLessonId: "lesson-example",
  page: "vocabulary.html?id=vocab-example",
  words: [
    {
      id: "word-example",
      // uniqueKey можно указать вручную только для разных значений одинакового написания.
      // Без uniqueKey повторяющееся поле en будет автоматически исключено.
      en: "example",
      ru: "пример",
      transcription: "/ɪɡˈzɑːmpəl/",
      exampleEn: "This is an example.",
      exampleRu: "Это пример.",
      audio: ""
    }
  ]
};
