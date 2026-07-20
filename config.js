window.APP_CONFIG = {
  student: {
    id: "polina",
    nameRu: "Полина",
    nameEn: "Polina",
    level: "B1",
    textbook: "Outcomes",
    textbookEdition: "Intermediate B1 course"
  },

  supabase: {
    url: "https://zqzgarvmpqqqaobeicpc.supabase.co",
    anonKey: "sb_publishable_tLdpYQZSbjxOZGQpee_jMQ_lfOBYZxC",
    authMode: "none",
    tables: {
      homework: "homework_progress",
      vocabulary: "vocabulary_progress",
      vocabularyTopics: "vocabulary_topic_progress",
      grammar: "grammar_progress"
    }
  },

  features: {
    homework: true,
    vocabulary: true,
    grammar: true,
    cloudSync: true,
    telegramNotifications: true
  }
};
