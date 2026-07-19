(() => {
  'use strict';

  const config = window.APP_CONFIG || {};
  const student = config.student || {};
  let HOMEWORK_DATA = [];
  const RAW_VOCABULARY_DATA = Array.isArray(window.VOCABULARY_DATA) ? window.VOCABULARY_DATA : [];
  const GRAMMAR_DATA = Array.isArray(window.GRAMMAR_DATA) ? window.GRAMMAR_DATA : [];
  const lessonCache = new Map();
  const lessonsPath = 'data/lessons';
  const maxLessonNumber = 200;
  const maxConsecutiveMissingLessons = 3;

  const safeText = (value, fallback = '') => value === undefined || value === null ? fallback : String(value);
  const escapeHtml = (value) => safeText(value)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#039;');
  const byId = (id) => document.getElementById(id);
  const queryParam = (name) => new URLSearchParams(window.location.search).get(name) || '';
  const unique = (items) => [...new Set(Array.isArray(items) ? items : [])];
  const safePercent = (value, total) => {
    const numerator = Number(value) || 0;
    const denominator = Number(total) || 0;
    if (denominator <= 0) return 0;
    return Math.max(0, Math.min(100, Math.round((numerator / denominator) * 100)));
  };
  const shuffled = (items) => {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  };
  const dateMs = (value) => {
    const time = Date.parse(value || '');
    return Number.isFinite(time) ? time : 0;
  };

  function normalizeLesson(rawLesson, requestedId = '') {
    if (!rawLesson || typeof rawLesson !== 'object') return null;
    const id = safeText(rawLesson.id || requestedId).trim();
    if (!/^lesson-\d+$/.test(id)) return null;
    const inferredNumber = Number(id.replace('lesson-', '')) || 0;
    return {
      ...rawLesson,
      id,
      number: Number(rawLesson.number || inferredNumber),
      title: safeText(rawLesson.title, `Lesson ${inferredNumber}`),
      subtitle: safeText(rawLesson.subtitle, 'Интерактивное домашнее задание'),
      status: safeText(rawLesson.status, 'available'),
      page: `lesson.html?id=${encodeURIComponent(id)}`,
      blocks: Array.isArray(rawLesson.blocks) ? rawLesson.blocks : []
    };
  }

  async function fetchLessonFile(id) {
    const cleanId = safeText(id).trim();
    if (!/^lesson-\d+$/.test(cleanId)) return null;
    if (lessonCache.has(cleanId)) return lessonCache.get(cleanId);

    const promise = (async () => {
      const url = new URL(`${lessonsPath}/${cleanId}.json`, document.baseURI);
      const response = await fetch(url, { cache: 'no-store' });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`Не удалось загрузить ${cleanId}.json: ${response.status}`);
      const lesson = normalizeLesson(await response.json(), cleanId);
      if (!lesson) throw new Error(`Файл ${cleanId}.json имеет неверную структуру.`);
      return lesson;
    })();

    lessonCache.set(cleanId, promise);
    try {
      return await promise;
    } catch (error) {
      lessonCache.delete(cleanId);
      throw error;
    }
  }

  async function discoverHomeworkData() {
    try {
      const indexUrl = new URL(`${lessonsPath}/index.json`, document.baseURI);
      const response = await fetch(indexUrl, { cache: 'no-store' });
      if (response.ok) {
        const payload = await response.json();
        const ids = Array.isArray(payload) ? payload : payload.lessons;
        if (Array.isArray(ids)) {
          const lessons = (await Promise.all(ids.map((id) => fetchLessonFile(id)))).filter(Boolean);
          return lessons.sort((a, b) => Number(a.number || 0) - Number(b.number || 0));
        }
      }
    } catch (error) {
      console.warn('Не удалось загрузить индекс уроков, используется резервный поиск:', error);
    }

    const lessons = [];
    let consecutiveMissing = 0;
    for (let number = 1; number <= maxLessonNumber; number += 1) {
      const lesson = await fetchLessonFile(`lesson-${number}`);
      if (lesson) {
        lessons.push(lesson);
        consecutiveMissing = 0;
      } else {
        consecutiveMissing += 1;
        if (consecutiveMissing >= maxConsecutiveMissingLessons) break;
      }
    }
    return lessons.sort((a, b) => Number(a.number || 0) - Number(b.number || 0));
  }

  async function loadHomeworkData() {
    const view = document.body?.dataset?.view || '';
    const requestedId = queryParam('id');

    if (view === 'lesson' && requestedId) {
      const lesson = await fetchLessonFile(requestedId);
      HOMEWORK_DATA = lesson ? [lesson] : [];
    } else {
      HOMEWORK_DATA = await discoverHomeworkData();
    }

    window.HOMEWORK_DATA = HOMEWORK_DATA;
    return HOMEWORK_DATA;
  }

  async function resolveLessonContent(lesson) {
    return lesson || null;
  }

  function normalizeWordKey(value) {
    return safeText(value)
      .normalize('NFKC')
      .toLocaleLowerCase('en')
      .replace(/[’‘`]/g, "'")
      .trim()
      .replace(/\s+/g, ' ')
      .replace(/^[\s.,!?;:()[\]{}"“”]+|[\s.,!?;:()[\]{}"“”]+$/g, '');
  }

  function buildVocabularyCatalog(topics) {
    const seen = new Map();
    const byKey = new Map();
    const idToKey = new Map();
    const duplicates = [];
    const preparedTopics = topics.map((topic) => {
      const words = [];
      (Array.isArray(topic.words) ? topic.words : []).forEach((sourceWord) => {
        const wordKey = normalizeWordKey(sourceWord.uniqueKey || sourceWord.en);
        if (!wordKey) return;
        idToKey.set(safeText(sourceWord.id), wordKey);
        if (seen.has(wordKey)) {
          duplicates.push({ wordKey, skippedTopicId: topic.id, firstTopicId: seen.get(wordKey).topicId });
          return;
        }
        const word = { ...sourceWord, __wordKey: wordKey };
        const record = { word, topicId: topic.id };
        seen.set(wordKey, record);
        byKey.set(wordKey, record);
        words.push(word);
      });
      return { ...topic, words };
    });
    if (duplicates.length) {
      console.info('Повторяющиеся слова исключены из словаря:', duplicates);
    }
    return {
      topics: preparedTopics.filter((topic) => topic.words.length > 0),
      allTopics: preparedTopics,
      allWords: [...byKey.values()].map((item) => item.word),
      byKey,
      idToKey,
      duplicates
    };
  }

  const VOCABULARY_CATALOG = buildVocabularyCatalog(RAW_VOCABULARY_DATA);
  const VOCABULARY_DATA = VOCABULARY_CATALOG.topics;

  function showToast(message) {
    const toast = byId('app-toast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => toast.classList.remove('show'), 3000);
  }

  const storage = {
    read(key, fallback) {
      try {
        const raw = window.localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
      } catch (error) {
        console.warn('Не удалось прочитать локальный прогресс:', error);
        return fallback;
      }
    },
    write(key, value) {
      try {
        window.localStorage.setItem(key, JSON.stringify(value));
        return true;
      } catch (error) {
        console.warn('Не удалось сохранить локальный прогресс:', error);
        return false;
      }
    }
  };

  const studentId = safeText(student.id, 'student').toLowerCase().trim().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'student';
  const key = (section) => `english_space_${studentId}_${section}`;
  const tables = {
    homework: config.supabase?.tables?.homework || 'homework_progress',
    vocabulary: config.supabase?.tables?.vocabulary || 'vocabulary_progress',
    vocabularyTopics: config.supabase?.tables?.vocabularyTopics || 'vocabulary_topic_progress',
    grammar: config.supabase?.tables?.grammar || 'grammar_progress'
  };

  const CloudService = {
    client: null,
    syncing: false,
    timers: {},
    isConfigured() {
      return Boolean(
        config.features?.cloudSync &&
        safeText(config.supabase?.url).trim() &&
        safeText(config.supabase?.anonKey).trim() &&
        window.supabase?.createClient
      );
    },
    async init() {
      if (!this.isConfigured()) return null;
      if (!this.client) {
        // Удаляем сохранённую сессию старой версии сайта.
        // Иначе Supabase может отправлять запросы как authenticated,
        // хотя новая схема рассчитана на роль anon.
        try {
          const projectRef = new URL(config.supabase.url).hostname.split('.')[0];
          window.localStorage.removeItem(`sb-${projectRef}-auth-token`);
        } catch (error) {
          console.warn('Не удалось очистить старую Supabase-сессию:', error);
        }

        const emptyAuthStorage = {
          getItem() { return null; },
          setItem() {},
          removeItem() {}
        };

        this.client = window.supabase.createClient(
          config.supabase.url,
          config.supabase.anonKey,
          {
            auth: {
              persistSession: false,
              autoRefreshToken: false,
              detectSessionInUrl: false,
              storage: emptyAuthStorage
            }
          }
        );
      }
      return this.client;
    },
    queue(section) {
      if (!this.isConfigured() || !this.client || this.syncing) return;
      window.clearTimeout(this.timers[section]);
      this.timers[section] = window.setTimeout(() => {
        window.ProgressService.syncToCloud(section).catch((error) => {
          console.error('Ошибка облачного сохранения:', error);
          showToast('Не удалось сохранить прогресс в Supabase');
        });
      }, 450);
    }
  };

  function migrateLegacyPolinaProgress() {
    const marker = key('legacy_migration_v2');
    if (window.localStorage.getItem(marker)) return;

    const now = new Date().toISOString();
    const readRawJson = (storageKey, fallback = null) => {
      try {
        const raw = window.localStorage.getItem(storageKey);
        return raw ? JSON.parse(raw) : fallback;
      } catch (error) {
        console.warn(`Не удалось прочитать старый ключ ${storageKey}:`, error);
        return fallback;
      }
    };
    const firstNumber = (keys) => {
      for (const storageKey of keys) {
        const value = Number(window.localStorage.getItem(storageKey));
        if (Number.isFinite(value) && value >= 0) return value;
      }
      return 0;
    };

    try {
      // Домашние задания: старые баллы и, если они есть в браузере, старые ответы.
      const oldScores = readRawJson('polina_hw_scores', {}) || {};
      const oldAnswers = readRawJson('polina_hw_answers', {}) || {};
      const direct = {
        4: window.localStorage.getItem('polina_hw4_score'),
        5: window.localStorage.getItem('polina_hw5_score'),
        6: window.localStorage.getItem('polina_hw6_score')
      };
      const merged = { ...oldScores };
      Object.entries(direct).forEach(([number, score]) => {
        if (score && !merged[number]) merged[number] = score;
      });

      const homework = storage.read(key('homework'), { completedIds: [], results: {}, submissions: {} });
      homework.completedIds = unique(homework.completedIds);
      homework.results = homework.results && typeof homework.results === 'object' ? homework.results : {};
      homework.submissions = homework.submissions && typeof homework.submissions === 'object' ? homework.submissions : {};
      Object.entries(merged).forEach(([number, score]) => {
        const match = safeText(score).match(/(\d+)\s*\/\s*(\d+)/);
        if (!match) return;
        const lessonId = `lesson-${number}`;
        const correct = Number(match[1]);
        const total = Number(match[2]);
        const previous = homework.results[lessonId] || {};
        homework.results[lessonId] = {
          ...previous,
          correct,
          total,
          percent: safePercent(correct, total),
          checkedAt: previous.checkedAt || now,
          legacyAnswers: oldAnswers[number] || oldAnswers[String(number)] || previous.legacyAnswers || null,
          migratedAt: previous.migratedAt || now
        };
        if (!homework.completedIds.includes(lessonId)) homework.completedIds.push(lessonId);
        homework.submissions[lessonId] = homework.submissions[lessonId] || { savedAt: now, status: 'migrated-local' };
      });
      storage.write(key('homework'), homework);

      // Словарь: переносим точные отметки из старого localStorage, когда они доступны.
      const vocabulary = normalizeVocabularyProgress(storage.read(key('vocabulary'), {}));
      const topicById = new Map(VOCABULARY_CATALOG.allTopics.map((topic) => [topic.id, topic]));
      const ensureTopic = (topicId) => {
        if (!vocabulary.topics[topicId]) vocabulary.topics[topicId] = { tests: [] };
        if (!Array.isArray(vocabulary.topics[topicId].tests)) vocabulary.topics[topicId].tests = [];
        return vocabulary.topics[topicId];
      };
      const setLegacyBaseline = (topicId, learnedCount, total, source) => {
        const topic = ensureTopic(topicId);
        const count = Math.max(0, Number(learnedCount || 0));
        if (!count) return;
        topic.legacyLearnedCount = Math.max(Number(topic.legacyLearnedCount || 0), count);
        topic.legacyTotal = Math.max(Number(topic.legacyTotal || 0), Number(total || 0));
        topic.legacySource = topic.legacySource || source;
        topic.legacyUpdatedAt = topic.legacyUpdatedAt || now;
      };
      const setLegacyWord = (topicId, wordId, status) => {
        const topic = topicById.get(topicId);
        const word = topic?.words?.find((item) => safeText(item.id) === safeText(wordId));
        if (!word?.__wordKey) return;
        const previous = vocabulary.words[word.__wordKey];
        if (previous?.status === 'known' && status === 'difficult') return;
        vocabulary.words[word.__wordKey] = {
          status,
          topicId,
          learnedAt: status === 'known' ? (previous?.learnedAt || now) : null,
          updatedAt: previous?.updatedAt || now
        };
      };
      const importNumericTopicState = (topicId, prefix, storageKeys) => {
        let state = null;
        for (const storageKey of storageKeys) {
          state = readRawJson(storageKey, null);
          if (state) break;
        }
        if (!state || typeof state !== 'object') return;
        unique(state.learned).forEach((legacyId) => setLegacyWord(topicId, `${prefix}${legacyId}`, 'known'));
        unique(state.hard).forEach((legacyId) => setLegacyWord(topicId, `${prefix}${legacyId}`, 'difficult'));
      };

      importNumericTopicState('vocab-lesson-4', 'l4-', [
        'polina_vocab_everyday_state',
        'polina_vocab_everyday_problems_state',
        'polina_vocab_problems_state'
      ]);
      importNumericTopicState('vocab-lesson-5', 'l5-', ['polina_vocab_languages_state']);
      importNumericTopicState('vocab-lesson-6', 'l6-', ['polina_vocab_language_classes_state']);

      const feelings = readRawJson('polina_vocab_feelings_state', null);
      if (feelings && typeof feelings === 'object') {
        const feelingsWordId = (legacyId) => String(legacyId).startsWith('p')
          ? `l7p-${String(legacyId).slice(1)}`
          : `l7-${legacyId}`;
        unique(feelings.learned).forEach((legacyId) => setLegacyWord('vocab-lesson-7', feelingsWordId(legacyId), 'known'));
        unique(feelings.hard).forEach((legacyId) => setLegacyWord('vocab-lesson-7', feelingsWordId(legacyId), 'difficult'));
      }

      const hugsLearned = readRawJson('homework_vocab_only_v1', []);
      if (Array.isArray(hugsLearned)) {
        hugsLearned.forEach((legacyId) => setLegacyWord('vocab-lesson-8', `l8-${legacyId}`, 'known'));
        setLegacyBaseline('vocab-lesson-8', hugsLearned.length, 26, 'legacy-local:hugs');
      }

      const verbState = readRawJson('polina_verb_state', null);
      if (verbState && typeof verbState === 'object') {
        const learnedRu = new Set(unique(verbState.learnedRu).map((item) => safeText(item).toLowerCase()));
        const learnedForms = new Set(unique(verbState.learnedForms).map((item) => safeText(item).toLowerCase()));
        const hard = new Set(unique(verbState.hard).map((item) => safeText(item).toLowerCase()));
        const topic = topicById.get('vocab-irregular-verbs');
        (topic?.words || []).forEach((word) => {
          const base = safeText(word.en).split('—')[0].trim().toLowerCase();
          if (learnedRu.has(base) && learnedForms.has(base)) setLegacyWord(topic.id, word.id, 'known');
          else if (hard.has(base)) setLegacyWord(topic.id, word.id, 'difficult');
        });
      }

      setLegacyBaseline('vocab-lesson-4', firstNumber(['polina_words_learned', 'polina_vocab_everyday']), 30, 'legacy-local:everyday');
      setLegacyBaseline('vocab-lesson-5', firstNumber(['polina_vocab_languages']), 36, 'legacy-local:languages');
      setLegacyBaseline('vocab-lesson-6', firstNumber(['polina_vocab_language_classes']), 20, 'legacy-local:language-classes');
      setLegacyBaseline('vocab-lesson-7', firstNumber(['polina_vocab_feelings']), 46, 'legacy-local:feelings');
      setLegacyBaseline('vocab-irregular-verbs', firstNumber(['polina_vocab_verbs']), 49, 'legacy-local:irregular-verbs');
      storage.write(key('vocabulary'), normalizeVocabularyProgress(vocabulary));

      window.localStorage.setItem(marker, 'done');
    } catch (error) {
      console.warn('Не удалось полностью перенести старый локальный прогресс Полины:', error);
    }
  }

  function findLegacyLessonTarget(lessonId, legacyKey) {
    const keyText = safeText(legacyKey);
    let match;
    if (lessonId === 'lesson-4') {
      if ((match = keyText.match(/^1\.(\d+)$/))) return ['l4-key-vocab', match[1]];
      if ((match = keyText.match(/^12\.1\.(\d+)$/))) return ['l4-12-1', String(Number(match[1]) - 1)];
      if ((match = keyText.match(/^12\.2\.(\d+)$/))) return ['l4-12-2', String(Number(match[1]) - 1)];
      if ((match = keyText.match(/^12\.4\.(\d+)$/))) return ['l4-12-4', String(Number(match[1]) - 1)];
      if ((match = keyText.match(/^free_(\d+)$/))) return ['l4-over-to-you', match[1]];
      if (keyText === 'matrix') return ['l4-collocations', 'matrix'];
    }
    if (lessonId === 'lesson-5') {
      if ((match = keyText.match(/^q1_(.+)$/))) return ['l5-ex1', match[1]];
      if ((match = keyText.match(/^q2_(\d+)$/))) return ['l5-ex2', match[1]];
      if ((match = keyText.match(/^q3_1_(\d+)$/))) return ['l5-ex31', match[1]];
      if ((match = keyText.match(/^q3_2_(\d+)$/))) return ['l5-ex32', match[1]];
      if ((match = keyText.match(/^q3_3_(\d+)$/))) return ['l5-ex33', match[1]];
    }
    if (lessonId === 'lesson-6') {
      if (keyText === 'q7') return ['l6-ex7', '1'];
      if ((match = keyText.match(/^q8_(\d+)$/))) return ['l6-ex8', match[1]];
      if ((match = keyText.match(/^q9_(\d+)$/))) return ['l6-ex9', match[1]];
    }
    if (lessonId === 'lesson-7') {
      if ((match = keyText.match(/^q1_(\d+)$/))) return ['l7-ex1', match[1]];
      if ((match = keyText.match(/^q2_(.+)$/))) return ['l7-ex2', match[1]];
      if ((match = keyText.match(/^q43_1_(\d+)$/))) return ['l7-ex431', match[1]];
      if ((match = keyText.match(/^q43_2_(\d+)$/))) return ['l7-ex432', String(Number(match[1]) - 1)];
    }
    if (lessonId === 'lesson-8') {
      if ((match = keyText.match(/^q3_(\d+)$/))) return ['l8-ex3', match[1]];
      if ((match = keyText.match(/^q99_(\d+)$/))) return ['l8-ex992', match[1]];
      if ((match = keyText.match(/^q4_(\d+)$/))) return ['l8-ex4', match[1]];
      if ((match = keyText.match(/^pred_(\d+)$/))) return ['l8-predictions', match[1]];
      if (keyText === 'q5') return ['l8-ex5', '1'];
      if ((match = keyText.match(/^listen_(\d+)$/))) return ['l8-listening', match[1]];
    }
    return null;
  }

  function convertLegacyChoiceValue(item, value) {
    if (!item || !['single', 'select'].includes(item.input)) return value;
    if (value === undefined || value === null || value === '') return '';
    const options = Array.isArray(item.options) ? item.options : [];
    if (Number.isInteger(value) && value >= 0 && value < options.length) return value;
    const raw = safeText(value).trim();
    if (/^[a-z]$/i.test(raw)) {
      const index = raw.toLowerCase().charCodeAt(0) - 97;
      if (index >= 0 && index < options.length) return index;
    }
    if (/^[tf]$/i.test(raw) && options.length === 2) return raw.toUpperCase() === 'T' ? 0 : 1;
    if (/^\d+$/.test(raw)) {
      const index = Number(raw);
      if (index >= 0 && index < options.length) return index;
    }
    const normalized = normalizeAnswer(raw);
    const index = options.findIndex((option) => {
      const optionNormalized = normalizeAnswer(option);
      return optionNormalized === normalized || optionNormalized.includes(normalized) || normalized.includes(optionNormalized);
    });
    return index >= 0 ? index : value;
  }

  function convertLegacyHomeworkAnswers(lessonId, legacyAnswers, lesson) {
    if (!legacyAnswers || typeof legacyAnswers !== 'object' || !lesson) return {};
    const converted = {};
    const blocks = Array.isArray(lesson.blocks) ? lesson.blocks : [];
    Object.entries(legacyAnswers).forEach(([legacyKey, rawValue]) => {
      const alreadyNewBlock = blocks.find((block) => block.id === legacyKey);
      if (alreadyNewBlock) {
        converted[legacyKey] = rawValue;
        return;
      }
      const target = findLegacyLessonTarget(lessonId, legacyKey);
      if (!target) return;
      const [blockId, itemId] = target;
      const block = blocks.find((item) => item.id === blockId);
      const item = block?.items?.find((entry) => safeText(entry.id) === safeText(itemId));
      if (!block || !item) return;
      if (!converted[blockId] || typeof converted[blockId] !== 'object') converted[blockId] = {};
      if (item.input === 'multiple' && !Array.isArray(rawValue)) return;
      converted[blockId][itemId] = convertLegacyChoiceValue(item, rawValue);
    });
    return converted;
  }

  function mergeLessonAnswers(legacyAnswers, currentAnswers) {
    const merged = { ...(legacyAnswers && typeof legacyAnswers === 'object' ? legacyAnswers : {}) };
    Object.entries(currentAnswers && typeof currentAnswers === 'object' ? currentAnswers : {}).forEach(([blockId, value]) => {
      if (value && typeof value === 'object' && !Array.isArray(value) && merged[blockId] && typeof merged[blockId] === 'object' && !Array.isArray(merged[blockId])) {
        merged[blockId] = { ...merged[blockId], ...value };
      } else {
        merged[blockId] = value;
      }
    });
    return merged;
  }

  function normalizeVocabularyProgress(value) {
    const words = value?.words && typeof value.words === 'object' ? { ...value.words } : {};
    const topics = {};
    Object.entries(value?.topics && typeof value.topics === 'object' ? value.topics : {}).forEach(([topicId, topic]) => {
      topics[topicId] = {
        tests: Array.isArray(topic?.tests) ? topic.tests : [],
        legacyLearnedCount: Math.max(0, Number(topic?.legacyLearnedCount || 0)),
        legacyTotal: Math.max(0, Number(topic?.legacyTotal || 0)),
        legacySource: safeText(topic?.legacySource),
        legacyUpdatedAt: topic?.legacyUpdatedAt || null
      };
      unique(topic?.known).forEach((legacyId) => {
        const wordKey = VOCABULARY_CATALOG.idToKey.get(safeText(legacyId));
        if (wordKey) words[wordKey] = { status: 'known', topicId, learnedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      });
      unique(topic?.difficult).forEach((legacyId) => {
        const wordKey = VOCABULARY_CATALOG.idToKey.get(safeText(legacyId));
        if (wordKey && words[wordKey]?.status !== 'known') words[wordKey] = { status: 'difficult', topicId, updatedAt: new Date().toISOString() };
      });
    });
    Object.entries(words).forEach(([wordKey, item]) => {
      if (!['known', 'difficult'].includes(item?.status)) delete words[wordKey];
    });
    return { words, topics };
  }

  window.ProgressService = {
    loadHomeworkProgress() {
      const value = storage.read(key('homework'), {});
      return {
        completedIds: unique(value.completedIds),
        results: value.results && typeof value.results === 'object' ? value.results : {},
        submissions: value.submissions && typeof value.submissions === 'object' ? value.submissions : {}
      };
    },
    saveHomeworkProgress(progress) {
      const ok = storage.write(key('homework'), progress || {});
      CloudService.queue('homework');
      return ok;
    },
    loadVocabularyProgress() {
      return normalizeVocabularyProgress(storage.read(key('vocabulary'), {}));
    },
    saveVocabularyProgress(progress) {
      const normalized = normalizeVocabularyProgress(progress || {});
      const ok = storage.write(key('vocabulary'), normalized);
      const difficult = Object.entries(normalized.words)
        .filter(([, item]) => item.status === 'difficult')
        .map(([wordKey]) => wordKey);
      storage.write(key('difficult_words'), difficult);
      CloudService.queue('vocabulary');
      return ok;
    },
    loadGrammarProgress() {
      const value = storage.read(key('grammar'), {});
      return { topics: value.topics && typeof value.topics === 'object' ? value.topics : {} };
    },
    saveGrammarProgress(progress) {
      const ok = storage.write(key('grammar'), progress || {});
      CloudService.queue('grammar');
      return ok;
    },
    async syncFromCloud() {
      if (!CloudService.isConfigured()) return false;
      if (!CloudService.client) await CloudService.init();
      CloudService.syncing = true;
      try {
        const client = CloudService.client;
        const [homeworkResponse, vocabularyResponse, vocabularyTopicsResponse, grammarResponse] = await Promise.all([
          client.from(tables.homework).select('*').eq('student_id', studentId),
          client.from(tables.vocabulary).select('*').eq('student_id', studentId),
          client.from(tables.vocabularyTopics).select('*').eq('student_id', studentId),
          client.from(tables.grammar).select('*').eq('student_id', studentId)
        ]);
        [homeworkResponse, vocabularyResponse, vocabularyTopicsResponse, grammarResponse].forEach((response) => {
          if (response.error) throw response.error;
        });

        const homework = this.loadHomeworkProgress();
        (homeworkResponse.data || []).forEach((row) => {
          const localResult = homework.results[row.lesson_id] || {};
          const cloudLegacyAnswers = row.legacy_answers && typeof row.legacy_answers === 'object' ? row.legacy_answers : null;
          if (!Object.keys(localResult).length || dateMs(row.updated_at) >= dateMs(localResult.checkedAt)) {
            homework.results[row.lesson_id] = {
              ...localResult,
              correct: Number(row.score_correct || 0),
              total: Number(row.score_total || 0),
              percent: Number(row.score_percent || 0),
              answers: row.answers && typeof row.answers === 'object' ? row.answers : {},
              legacyAnswers: cloudLegacyAnswers || localResult.legacyAnswers || null,
              checkedAt: row.checked_at || row.updated_at,
              migratedAt: row.migrated_from_legacy ? (localResult.migratedAt || row.updated_at) : localResult.migratedAt
            };
          } else if (cloudLegacyAnswers && !localResult.legacyAnswers) {
            homework.results[row.lesson_id] = { ...localResult, legacyAnswers: cloudLegacyAnswers };
          }
          if (row.status === 'submitted' || row.migrated_from_legacy) {
            homework.submissions[row.lesson_id] = {
              savedAt: row.submitted_at || row.updated_at,
              status: row.migrated_from_legacy ? 'migrated-cloud' : 'cloud'
            };
          }
          if (row.status === 'submitted' || row.migrated_from_legacy) {
            homework.completedIds.push(row.lesson_id);
          }
        });
        homework.completedIds = unique(homework.completedIds);
        storage.write(key('homework'), homework);

        const vocabulary = this.loadVocabularyProgress();
        (vocabularyResponse.data || []).forEach((row) => {
          const local = vocabulary.words[row.word_key];
          if (!local || dateMs(row.updated_at) >= dateMs(local.updatedAt)) {
            vocabulary.words[row.word_key] = {
              status: row.status,
              topicId: row.source_topic_id || '',
              learnedAt: row.learned_at || null,
              updatedAt: row.updated_at
            };
          }
        });
        (vocabularyTopicsResponse.data || []).forEach((row) => {
          const localTopic = vocabulary.topics[row.topic_id] || {};
          const localTests = localTopic.tests || [];
          const cloudTests = Array.isArray(row.tests) ? row.tests : [];
          const merged = new Map();
          [...localTests, ...cloudTests].forEach((test) => merged.set(test.completedAt || JSON.stringify(test), test));
          vocabulary.topics[row.topic_id] = {
            tests: [...merged.values()],
            legacyLearnedCount: Math.max(Number(localTopic.legacyLearnedCount || 0), Number(row.legacy_learned_count || 0)),
            legacyTotal: Math.max(Number(localTopic.legacyTotal || 0), Number(row.legacy_total || 0)),
            legacySource: localTopic.legacySource || row.legacy_source || '',
            legacyUpdatedAt: dateMs(row.legacy_updated_at) >= dateMs(localTopic.legacyUpdatedAt)
              ? row.legacy_updated_at
              : localTopic.legacyUpdatedAt
          };
        });
        storage.write(key('vocabulary'), normalizeVocabularyProgress(vocabulary));

        const grammar = this.loadGrammarProgress();
        (grammarResponse.data || []).forEach((row) => {
          const local = grammar.topics[row.topic_id] || {};
          grammar.topics[row.topic_id] = {
            passed: Boolean(local.passed || row.passed),
            attempts: Math.max(Number(local.attempts || 0), Number(row.attempts || 0)),
            bestScore: Math.max(Number(local.bestScore || 0), Number(row.best_score || 0)),
            updatedAt: dateMs(row.updated_at) >= dateMs(local.updatedAt) ? row.updated_at : local.updatedAt
          };
        });
        storage.write(key('grammar'), grammar);
        await this.syncToCloud();
        return true;
      } finally {
        CloudService.syncing = false;
      }
    },
    async syncToCloud(section = 'all') {
      if (!CloudService.isConfigured()) return false;
      if (!CloudService.client) await CloudService.init();
      const client = CloudService.client;
      const sections = section === 'all' ? ['homework', 'vocabulary', 'grammar'] : [section];

      if (sections.includes('homework')) {
        const progress = this.loadHomeworkProgress();
        const lessonIds = unique([...Object.keys(progress.results), ...Object.keys(progress.submissions)]);
        const rows = lessonIds.map((lessonId) => {
          const result = progress.results[lessonId] || {};
          const submission = progress.submissions[lessonId];
          const lesson = HOMEWORK_DATA.find((item) => item.id === lessonId) || {};
          const total = Number(result.total || 0);
          const correct = Number(result.correct || 0);
          return {
            student_id: studentId,
            student_name: safeText(student.nameRu || student.nameEn),
            lesson_id: lessonId,
            lesson_title: safeText(lesson.title, lessonId),
            status: submission ? 'submitted' : 'checked',
            answers: result.answers && typeof result.answers === 'object' ? result.answers : {},
            legacy_answers: result.legacyAnswers && typeof result.legacyAnswers === 'object' ? result.legacyAnswers : null,
            migrated_from_legacy: Boolean(result.migratedAt || result.legacyAnswers),
            score_correct: total > 0 ? correct : null,
            score_total: total > 0 ? total : null,
            score_percent: total > 0 ? safePercent(correct, total) : null,
            checked_at: result.checkedAt || null,
            submitted_at: submission?.savedAt || null
          };
        });
        if (rows.length) {
          const { error } = await client.from(tables.homework).upsert(rows, { onConflict: 'student_id,lesson_id' });
          if (error) throw error;
        }
      }

      if (sections.includes('vocabulary')) {
        const progress = this.loadVocabularyProgress();
        const wordRows = Object.entries(progress.words).filter(([wordKey]) => VOCABULARY_CATALOG.byKey.has(wordKey)).map(([wordKey, state]) => {
          const record = VOCABULARY_CATALOG.byKey.get(wordKey);
          return {
            student_id: studentId,
            word_key: wordKey,
            word_id: safeText(record?.word?.id, wordKey),
            en: safeText(record?.word?.en, wordKey),
            ru: safeText(record?.word?.ru),
            source_topic_id: state.topicId || record?.topicId || null,
            status: state.status,
            learned_at: state.status === 'known' ? (state.learnedAt || new Date().toISOString()) : null
          };
        });
        if (wordRows.length) {
          const { error } = await client.from(tables.vocabulary).upsert(wordRows, { onConflict: 'student_id,word_key' });
          if (error) throw error;
        }
        const topicRows = Object.entries(progress.topics)
          .filter(([, topic]) => (Array.isArray(topic.tests) && topic.tests.length) || Number(topic.legacyLearnedCount || 0) > 0)
          .map(([topicId, topic]) => ({
            student_id: studentId,
            topic_id: topicId,
            tests: Array.isArray(topic.tests) ? topic.tests : [],
            legacy_learned_count: Math.max(0, Number(topic.legacyLearnedCount || 0)),
            legacy_total: Math.max(0, Number(topic.legacyTotal || 0)),
            legacy_source: safeText(topic.legacySource) || null,
            legacy_updated_at: topic.legacyUpdatedAt || null
          }));
        if (topicRows.length) {
          const { error } = await client.from(tables.vocabularyTopics).upsert(topicRows, { onConflict: 'student_id,topic_id' });
          if (error) throw error;
        }
      }

      if (sections.includes('grammar')) {
        const progress = this.loadGrammarProgress();
        const rows = Object.entries(progress.topics).map(([topicId, state]) => ({
          student_id: studentId,
          topic_id: topicId,
          passed: Boolean(state.passed),
          attempts: Number(state.attempts || 0),
          best_score: Number(state.bestScore || 0)
        }));
        if (rows.length) {
          const { error } = await client.from(tables.grammar).upsert(rows, { onConflict: 'student_id,topic_id' });
          if (error) throw error;
        }
      }
      return true;
    }
  };

  function fillConfig() {
    const values = {
      nameRu: student.nameRu,
      nameEn: student.nameEn,
      level: student.level,
      textbook: student.textbook,
      textbookEdition: student.textbookEdition
    };
    document.querySelectorAll('[data-config]').forEach((node) => {
      node.textContent = safeText(values[node.dataset.config]);
    });
    if (student.nameEn) document.title = `${document.title} · ${student.nameEn}`;
  }

  function markNavigation() {
    const page = document.body.dataset.page;
    document.querySelectorAll('[data-nav]').forEach((link) => {
      const active = link.dataset.nav === page;
      link.classList.toggle('active', active);
      if (active) link.setAttribute('aria-current', 'page');
    });
  }

  function progressMarkup(label, value, total, tone = '') {
    const percent = safePercent(value, total);
    return `<div class="progress-row">
      <div class="progress-row-head"><strong>${escapeHtml(label)}</strong><span>${Number(value) || 0} из ${Number(total) || 0}</span></div>
      <div class="progress-track" role="progressbar" aria-label="${escapeHtml(label)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}">
        <div class="progress-fill ${tone}" style="width:${percent}%"></div>
      </div>
    </div>`;
  }

  function exactKnownCountForTopic(progress, topic) {
    return (topic?.words || []).filter((word) => progress.words[word.__wordKey]?.status === 'known').length;
  }

  function effectiveKnownCountForTopic(progress, topic) {
    const exact = exactKnownCountForTopic(progress, topic);
    const legacy = Math.max(0, Number(progress.topics[topic?.id]?.legacyLearnedCount || 0));
    return Math.min(Number(topic?.words?.length || 0), Math.max(exact, legacy));
  }

  function effectiveKnownTotal(progress) {
    return VOCABULARY_DATA.reduce((sum, topic) => sum + effectiveKnownCountForTopic(progress, topic), 0);
  }

  function totals() {
    const hwProgress = window.ProgressService.loadHomeworkProgress();
    const vocabProgress = window.ProgressService.loadVocabularyProgress();
    const grammarProgress = window.ProgressService.loadGrammarProgress();
    const publishedHomework = HOMEWORK_DATA.filter((item) => ['available', 'completed', 'locked'].includes(item.status));
    const completedHomework = publishedHomework.filter((item) => hwProgress.completedIds.includes(item.id) || Boolean(hwProgress.submissions[item.id]) || item.status === 'completed').length;
    const knownWordCount = effectiveKnownTotal(vocabProgress);
    const passedGrammar = GRAMMAR_DATA.filter((topic) => grammarProgress.topics[topic.id]?.passed === true || topic.passed === true).length;
    return {
      homeworkTotal: publishedHomework.length,
      homeworkCompleted: completedHomework,
      vocabularyTotal: VOCABULARY_CATALOG.allWords.length,
      vocabularyKnown: knownWordCount,
      vocabularyTopics: VOCABULARY_DATA.length,
      grammarTotal: GRAMMAR_DATA.filter((topic) => topic.status !== 'draft').length,
      grammarPassed: passedGrammar
    };
  }

  function emptyState(icon, title, text) {
    return `<div class="card empty-state"><div class="empty-state-icon">${icon}</div><h3>${escapeHtml(title)}</h3><p>${escapeHtml(text)}</p></div>`;
  }

  function renderHome() {
    const t = totals();
    if (byId('home-stat-completed')) byId('home-stat-completed').textContent = t.homeworkCompleted;
    if (byId('vocab-stat-known')) byId('vocab-stat-known').textContent = t.vocabularyKnown;
    if (byId('grammar-stat-passed')) byId('grammar-stat-passed').textContent = t.grammarPassed;
    const list = byId('home-progress-list');
    if (list) list.innerHTML = [
      progressMarkup('Домашние задания', t.homeworkCompleted, t.homeworkTotal),
      progressMarkup('Словарный запас', t.vocabularyKnown, t.vocabularyTotal, 'rose'),
      progressMarkup('Грамматика', t.grammarPassed, t.grammarTotal, 'green')
    ].join('');
    const current = byId('current-material');
    if (current) {
      const homeworkProgress = window.ProgressService.loadHomeworkProgress();
      const currentHomework = HOMEWORK_DATA
        .filter((item) => item.status === 'available' && !homeworkProgress.completedIds.includes(item.id) && !homeworkProgress.submissions[item.id])
        .sort((a, b) => dateMs(b.publishedAt) - dateMs(a.publishedAt) || Number(b.number || 0) - Number(a.number || 0))[0];

      if (currentHomework) {
        const href = currentHomework.page || `lesson.html?id=${encodeURIComponent(currentHomework.id)}`;
        current.innerHTML = `<a class="card interactive item-card current-material-card" href="${escapeHtml(href)}">
          <div class="item-icon">✨</div>
          <div class="item-main"><h3>${escapeHtml(safeText(currentHomework.title, 'Текущее задание'))}</h3><p>${escapeHtml(safeText(currentHomework.subtitle, 'Продолжить работу с опубликованным материалом.'))}</p></div>
          <span class="status-badge status-available">Продолжить</span>
        </a>`;
      } else {
        const publishedHomework = HOMEWORK_DATA.filter((item) => ['available', 'completed'].includes(item.status));
        const everythingCompleted = publishedHomework.length > 0 && publishedHomework.every((item) => item.status === 'completed' || homeworkProgress.completedIds.includes(item.id) || Boolean(homeworkProgress.submissions[item.id]));
        current.innerHTML = everythingCompleted
          ? '<a class="card interactive item-card current-material-card" href="homework.html"><div class="item-icon">✅</div><div class="item-main"><h3>Все опубликованные материалы выполнены</h3><p>Новый материал появится после следующей публикации преподавателя.</p></div><span class="arrow" aria-hidden="true">→</span></a>'
          : '<div class="card disabled empty-state"><div class="empty-state-icon">✨</div><h3>Текущий материал пока не опубликован</h3><p>Здесь автоматически появится последнее доступное домашнее задание.</p></div>';
      }
    }
  }

  function renderHomework() {
    const progress = window.ProgressService.loadHomeworkProgress();
    const published = HOMEWORK_DATA.filter((item) => item.status !== 'draft');

    const isComplete = (item) => progress.completedIds.includes(item.id)
      || Boolean(progress.submissions[item.id])
      || item.status === 'completed';

    const completionTime = (item) => {
      const submission = progress.submissions[item.id] || {};
      const result = progress.results[item.id] || {};
      const candidates = [
        submission.savedAt,
        submission.submittedAt,
        result.submittedAt,
        result.updatedAt,
        item.completedAt
      ];
      for (const value of candidates) {
        const timestamp = dateMs(value);
        if (timestamp) return timestamp;
      }
      return 0;
    };

    const newestLessonFirst = (a, b) => dateMs(b.publishedAt) - dateMs(a.publishedAt)
      || Number(b.number || 0) - Number(a.number || 0);

    const completedNewestFirst = (a, b) => completionTime(b) - completionTime(a)
      || Number(b.number || 0) - Number(a.number || 0);

    const completed = published.filter(isComplete).length;
    const percent = safePercent(completed, published.length);
    byId('hw-completed').textContent = completed;
    byId('hw-total').textContent = published.length;
    byId('hw-percent').textContent = `${percent}%`;
    byId('hw-overall-progress').innerHTML = progressMarkup('Общий прогресс', completed, published.length);

    const root = byId('homework-list');
    if (!published.length) {
      root.innerHTML = emptyState('📝', 'Домашних заданий пока нет', 'После первого урока преподаватель добавит сюда интерактивное задание.');
      return;
    }

    const renderCard = (item) => {
      const locked = item.status === 'locked';
      const complete = isComplete(item);
      const lessonNumber = Number(item.number || 0);
      const numberPrefix = lessonNumber > 0 ? `Lesson ${lessonNumber} · ` : '';
      const title = locked
        ? `🔒 ${numberPrefix}Coming soon`
        : `${numberPrefix}${safeText(item.title, 'Задание')}`;
      const savedResult = progress.results[item.id];
      const scoreSuffix = savedResult && Number(savedResult.total || 0) > 0
        ? ` · Результат ${Number(savedResult.correct || 0)}/${Number(savedResult.total || 0)}`
        : '';
      const subtitle = locked
        ? 'Материал откроется после публикации преподавателем.'
        : `${safeText(item.subtitle, 'Интерактивное задание')}${scoreSuffix}`;
      const status = complete ? 'completed' : safeText(item.status, 'available');
      const label = complete ? 'Выполнено' : status === 'available' ? 'Доступно' : status === 'locked' ? 'Закрыто' : 'Черновик';
      const tag = locked ? 'div' : 'a';
      const href = locked ? '' : ` href="${escapeHtml(item.page || `lesson.html?id=${encodeURIComponent(item.id)}`)}"`;
      return `<${tag} class="card item-card ${locked ? 'disabled' : 'interactive'}"${href}>
        <div class="item-icon">${complete ? '✅' : locked ? '🔒' : '📝'}</div>
        <div class="item-main"><h3>${escapeHtml(title)}</h3><p>${escapeHtml(subtitle)}</p></div>
        <span class="status-badge status-${escapeHtml(status)}">${escapeHtml(label)}</span>
      </${tag}>`;
    };

    const renderGroup = (title, items, tone = '') => {
      if (!items.length) return '';
      return `<section class="homework-group ${tone}" aria-label="${escapeHtml(title)}">
        <div class="homework-group-heading">
          <h3>${escapeHtml(title)}</h3>
          <span>${items.length}</span>
        </div>
        <div class="homework-group-list">${items.map(renderCard).join('')}</div>
      </section>`;
    };

    const toDo = published
      .filter((item) => !isComplete(item) && item.status !== 'locked')
      .sort(newestLessonFirst);
    const done = published
      .filter(isComplete)
      .sort(completedNewestFirst);
    const comingSoon = published
      .filter((item) => !isComplete(item) && item.status === 'locked')
      .sort((a, b) => Number(a.number || 0) - Number(b.number || 0));

    root.innerHTML = [
      renderGroup('Нужно выполнить', toDo, 'homework-group-todo'),
      renderGroup('Выполненные', done, 'homework-group-done'),
      renderGroup('Скоро', comingSoon, 'homework-group-locked')
    ].join('');
  }

  function renderGrammar() {
    const progress = window.ProgressService.loadGrammarProgress();
    const published = GRAMMAR_DATA.filter((topic) => topic.status !== 'draft');
    const passed = published.filter((topic) => progress.topics[topic.id]?.passed || topic.passed).length;
    byId('grammar-passed').textContent = passed;
    byId('grammar-total').textContent = published.length;
    byId('grammar-overall-progress').innerHTML = progressMarkup('Общий прогресс', passed, published.length, 'green');
    const root = byId('grammar-list');
    if (!published.length) {
      root.innerHTML = emptyState('📐', 'Грамматические темы пока не опубликованы', `Материалы будут добавляться в соответствии с уроками и учебником «${safeText(student.textbook)}».`);
      return;
    }
    root.innerHTML = [...published].sort((a,b) => (a.order || 0) - (b.order || 0)).map((topic) => {
      const locked = topic.status === 'locked';
      const isPassed = progress.topics[topic.id]?.passed || topic.passed;
      const title = locked ? '🔒 Coming soon' : safeText(topic.title, 'Грамматическая тема');
      const tag = locked ? 'div' : 'a';
      const href = locked ? '' : ` href="${escapeHtml(topic.page || `grammar-topic.html?id=${encodeURIComponent(topic.id)}`)}"`;
      return `<${tag} class="card item-card ${locked ? 'disabled' : 'interactive'}"${href}>
        <div class="item-icon">${isPassed ? '✅' : locked ? '🔒' : '📐'}</div>
        <div class="item-main"><h3>${escapeHtml(title)}</h3><p>${locked ? 'Материал ещё не опубликован.' : `${escapeHtml(topic.level || student.level)} · ${Number(progress.topics[topic.id]?.attempts || topic.attempts || 0)} попыток`}</p></div>
        <span class="status-badge status-${isPassed ? 'completed' : locked ? 'locked' : 'available'}">${isPassed ? 'Пройдено' : locked ? 'Закрыто' : 'Открыть'}</span>
      </${tag}>`;
    }).join('');
  }

  function renderVocabularyHub() {
    const progress = window.ProgressService.loadVocabularyProgress();
    const totalWords = VOCABULARY_CATALOG.allWords.length;
    const knownCount = effectiveKnownTotal(progress);
    byId('vocab-known').textContent = knownCount;
    byId('vocab-total').textContent = totalWords;
    byId('vocab-topics').textContent = VOCABULARY_DATA.length;
    byId('vocab-percent').textContent = `${safePercent(knownCount, totalWords)}%`;
    byId('vocab-overall-progress').innerHTML = progressMarkup('Общий прогресс', knownCount, totalWords, 'rose');
    const root = byId('vocabulary-list');
    const filters = byId('vocab-filters');

    const draw = (filter = 'all') => {
      const filtered = VOCABULARY_DATA.filter((topic) => {
        const topicKnown = effectiveKnownCountForTopic(progress, topic);
        const complete = topic.words.length > 0 && topicKnown >= topic.words.length;
        if (filter === 'completed') return complete;
        if (filter === 'lesson') return topic.type === 'lesson';
        if (filter === 'extra') return topic.type === 'extra';
        return true;
      });
      if (!filtered.length) {
        root.innerHTML = emptyState('💥', 'Словарных тренажёров пока нет', 'Новые темы появятся после уроков. Повторяющиеся слова автоматически исключаются.');
        return;
      }
      root.innerHTML = filtered.map((topic) => {
        const wordCount = topic.words.length;
        const topicKnown = effectiveKnownCountForTopic(progress, topic);
        const complete = wordCount > 0 && topicKnown >= wordCount;
        return `<a class="card item-card interactive" href="${escapeHtml(topic.page || `vocabulary.html?id=${encodeURIComponent(topic.id)}`)}">
          <div class="item-icon">${escapeHtml(topic.icon || '💬')}</div>
          <div class="item-main"><h3>${escapeHtml(topic.title || 'Словарная тема')}</h3><p>${escapeHtml(topic.label || '')} · ${topicKnown} из ${wordCount} слов</p></div>
          <span class="status-badge status-${complete ? 'completed' : 'available'}">${complete ? 'Завершено' : 'Открыть'}</span>
        </a>`;
      }).join('');
    };
    if (filters) {
      filters.onclick = (event) => {
        const button = event.target.closest('[data-filter]');
        if (!button) return;
        filters.querySelectorAll('[data-filter]').forEach((item) => item.classList.toggle('active', item === button));
        draw(button.dataset.filter);
      };
    }
    draw();
  }

  function renderReadingSections(block) {
    const sections = Array.isArray(block.sections) ? block.sections : [];
    if (!sections.length) {
      const text = escapeHtml(block.text || '').replaceAll('\n', '<br>');
      return `<div class="reading-copy-wrap"><p class="reading-copy">${text}</p></div>`;
    }
    return `<div class="reading-sections">${sections.map((section) => `<section class="reading-section">
      <div class="reading-section-heading"><span class="reading-number">${escapeHtml(section.number || '')}</span><h4>${escapeHtml(section.heading || '')}</h4></div>
      <p class="reading-section-copy">${escapeHtml(section.text || '')}</p>
    </section>`).join('')}</div>`;
  }

  function renderExerciseItem(item, blockId, index) {
    const itemId = safeText(item.id, `${index + 1}`);
    const number = item.number === undefined ? index + 1 : item.number;
    const prompt = escapeHtml(item.prompt || '');
    const inputId = `exercise-${blockId}-${itemId}`.replace(/[^a-zA-Z0-9_-]/g, '-');
    const numberMarkup = number === '' || number === null ? '' : `<span class="exercise-number">${escapeHtml(number)}</span>`;

    if (item.example) {
      return `<div class="exercise-item exercise-example" data-exercise-item="${escapeHtml(itemId)}">
        <div class="exercise-item-header">${numberMarkup}<div class="exercise-prompt">${prompt}</div></div>
        <div class="example-answer"><span>Example</span><strong>${escapeHtml(item.exampleAnswer || '')}</strong></div>
      </div>`;
    }

    let control = '';
    if (item.input === 'multiple' || item.input === 'single') {
      const inputType = item.input === 'multiple' ? 'checkbox' : 'radio';
      control = `<div class="option-list compact-options">${(item.options || []).map((option, optionIndex) => `<label class="option"><input type="${inputType}" name="${escapeHtml(inputId)}" value="${optionIndex}"><span>${escapeHtml(option)}</span></label>`).join('')}</div>`;
    } else if (item.input === 'select') {
      control = `<select id="${escapeHtml(inputId)}"><option value="">Choose an answer</option>${(item.options || []).map((option, optionIndex) => `<option value="${optionIndex}">${escapeHtml(option)}</option>`).join('')}</select>`;
    } else if (item.input === 'textarea') {
      control = `<textarea id="${escapeHtml(inputId)}" placeholder="${escapeHtml(item.placeholder || '')}"></textarea>`;
    } else if (item.input === 'gaps') {
      const answers = Array.isArray(item.answers) ? item.answers : [];
      const segments = Array.isArray(item.segments) ? item.segments : [];
      control = `<div class="sentence-gaps" aria-label="${prompt}">${answers.map((answer, gapIndex) => `${gapIndex < segments.length ? `<span>${escapeHtml(segments[gapIndex])}</span>` : ''}<input class="gap-input" data-gap-index="${gapIndex}" aria-label="Gap ${gapIndex + 1}" autocomplete="off">`).join('')}${segments.length > answers.length ? `<span>${escapeHtml(segments[segments.length - 1])}</span>` : ''}</div>`;
    } else {
      control = `<input class="text-field" id="${escapeHtml(inputId)}" autocomplete="off" placeholder="${escapeHtml(item.placeholder || '')}">`;
    }

    return `<div class="exercise-item" data-exercise-item="${escapeHtml(itemId)}" data-input-type="${escapeHtml(item.input || 'text')}">
      <div class="exercise-item-header">${numberMarkup}<label class="exercise-prompt" for="${escapeHtml(inputId)}">${prompt}</label></div>
      <div class="exercise-control">${control}</div>
      <div class="feedback" aria-live="polite"></div>
    </div>`;
  }

  function renderLessonBlock(block, index) {
    const id = safeText(block.id, `task-${index}`);
    const title = escapeHtml(block.title || block.prompt || `Задание ${index + 1}`);
    const text = escapeHtml(block.text || '').replaceAll('\n', '<br>');

    if (block.type === 'section') {
      return `<header id="lesson-section-${index}" class="lesson-section-title lesson-block" data-lesson-section><span class="lesson-section-step">${escapeHtml(block.__sectionNumber || index + 1)}</span><div><span class="eyebrow">${escapeHtml(block.eyebrow || 'Материал')}</span><h2>${title}</h2>${text ? `<p class="muted">${text}</p>` : ''}</div></header>`;
    }
    if (block.type === 'info') return `<article class="card info-card lesson-block"><h3>${title}</h3><p>${text}</p></article>`;
    if (block.type === 'tip') return `<article class="card tip-card lesson-block"><h3>${title}</h3><p>${text}</p></article>`;
    if (block.type === 'reading') {
      const sectionCount = Array.isArray(block.sections) ? block.sections.length : 0;
      return `<article class="card lesson-block reading-card"><div class="reading-title"><div><span class="eyebrow">Reading</span><h3>${title}</h3></div>${sectionCount ? `<span class="reading-count">${sectionCount} sections</span>` : ''}</div>${renderReadingSections(block)}</article>`;
    }
    if (block.type === 'exercise') {
      const items = Array.isArray(block.items) ? block.items : [];
      const wordBank = Array.isArray(block.wordBank) && block.wordBank.length
        ? `<div class="word-bank" aria-label="Word bank"><strong class="word-bank-label">Word bank</strong>${block.wordBank.map((word) => `<span>${escapeHtml(word)}</span>`).join('')}</div>`
        : '';
      const player = block.audio ? `<audio class="audio-player" controls preload="none" src="${escapeHtml(block.audio)}"></audio>` : '';
      return `<article class="card lesson-block exercise-card" data-task="${escapeHtml(id)}" data-type="exercise">
        <div class="exercise-heading"><span class="eyebrow">Exercise</span><h3>${title}</h3>${block.instructions ? `<p class="muted exercise-instructions">${escapeHtml(block.instructions)}</p>` : ''}${player}${wordBank}</div>
        <div class="exercise-items">${items.map((item, itemIndex) => renderExerciseItem(item, id, itemIndex)).join('')}</div>
      </article>`;
    }
    if (block.type === 'text' || block.type === 'translate') return `<article class="card lesson-block" data-task="${escapeHtml(id)}" data-type="${escapeHtml(block.type)}"><label class="field-label" for="${escapeHtml(id)}">${title}</label>${block.source ? `<p class="muted">${escapeHtml(block.source)}</p>` : ''}<input class="text-field" id="${escapeHtml(id)}" name="${escapeHtml(id)}" autocomplete="off"><div class="feedback"></div></article>`;
    if (block.type === 'textarea') return `<article class="card lesson-block" data-task="${escapeHtml(id)}" data-type="textarea"><label class="field-label" for="${escapeHtml(id)}">${title}</label><textarea id="${escapeHtml(id)}" name="${escapeHtml(id)}"></textarea><div class="feedback"></div></article>`;
    if (block.type === 'single' || block.type === 'multiple') {
      const inputType = block.type === 'single' ? 'radio' : 'checkbox';
      const options = (block.options || []).map((option, optionIndex) => `<label class="option"><input type="${inputType}" name="${escapeHtml(id)}" value="${optionIndex}"><span>${escapeHtml(option)}</span></label>`).join('');
      return `<article class="card lesson-block" data-task="${escapeHtml(id)}" data-type="${escapeHtml(block.type)}"><h3>${title}</h3><div class="option-list">${options}</div><div class="feedback"></div></article>`;
    }
    if (block.type === 'select') {
      const options = (block.options || []).map((option, optionIndex) => `<option value="${optionIndex}">${escapeHtml(option)}</option>`).join('');
      return `<article class="card lesson-block" data-task="${escapeHtml(id)}" data-type="select"><label class="field-label" for="${escapeHtml(id)}">${title}</label><select id="${escapeHtml(id)}"><option value="">Выберите ответ</option>${options}</select><div class="feedback"></div></article>`;
    }
    if (block.type === 'match') {
      const rights = (block.pairs || []).map((pair) => pair.right);
      const rows = (block.pairs || []).map((pair, pairIndex) => `<div>${escapeHtml(pair.left)}</div><select data-match-index="${pairIndex}"><option value="">Выберите пару</option>${rights.map((right, rightIndex) => `<option value="${rightIndex}">${escapeHtml(right)}</option>`).join('')}</select>`).join('');
      return `<article class="card lesson-block" data-task="${escapeHtml(id)}" data-type="match"><h3>${title}</h3><div class="match-grid">${rows}</div><div class="feedback"></div></article>`;
    }
    if (block.type === 'reorder') {
      const chips = shuffled(block.words || []).map((word) => `<button class="word-chip" type="button" data-word="${escapeHtml(word)}">${escapeHtml(word)}</button>`).join('');
      return `<article class="card lesson-block" data-task="${escapeHtml(id)}" data-type="reorder"><h3>${title}</h3><div class="word-chips" data-reorder-source>${chips}</div><label class="field-label" for="${escapeHtml(id)}">Собранный ответ</label><input class="text-field" id="${escapeHtml(id)}" readonly><div class="feedback"></div></article>`;
    }
    if (block.type === 'audio') {
      const player = block.audio ? `<audio class="audio-player" controls preload="none" src="${escapeHtml(block.audio)}"></audio>` : '<p class="muted">Аудиофайл ещё не прикреплён.</p>';
      const response = block.response === false ? '' : `<input class="text-field" id="${escapeHtml(id)}" aria-label="Ответ на аудиозадание"><div class="feedback"></div>`;
      const taskAttrs = block.response === false ? '' : ` data-task="${escapeHtml(id)}" data-type="audio"`;
      return `<article class="card lesson-block audio-card"${taskAttrs}><div class="audio-icon" aria-hidden="true">🎧</div><div class="audio-content"><h3>${title}</h3>${text ? `<p class="muted">${text}</p>` : ''}${player}${response}</div></article>`;
    }
    return '';
  }

  function normalizeAnswer(value) {
    return safeText(value)
      .normalize('NFKC')
      .replace(/[’‘`]/g, "'")
      .trim()
      .toLocaleLowerCase('en')
      .replace(/[.!?,;:]+$/g, '')
      .replace(/\s+/g, ' ');
  }

  function textAnswerMatches(item, actual) {
    const accepted = Array.isArray(item.acceptedAnswers) && item.acceptedAnswers.length
      ? item.acceptedAnswers
      : Array.isArray(item.answer) ? item.answer : [item.answer];
    return accepted.some((answer) => normalizeAnswer(answer) !== '' && normalizeAnswer(answer) === normalizeAnswer(actual));
  }

  function checkExerciseItem(item, itemNode) {
    const inputType = item.input || 'text';
    let actual;
    let correct = false;

    if (inputType === 'multiple') {
      actual = [...itemNode.querySelectorAll('input:checked')].map((input) => Number(input.value)).sort((a, b) => a - b);
      const expected = [...(item.answer || [])].map(Number).sort((a, b) => a - b);
      correct = JSON.stringify(actual) === JSON.stringify(expected);
    } else if (inputType === 'single') {
      actual = itemNode.querySelector('input:checked')?.value ?? '';
      correct = Number(actual) === Number(item.answer);
    } else if (inputType === 'select') {
      actual = itemNode.querySelector('select')?.value ?? '';
      correct = actual !== '' && Number(actual) === Number(item.answer);
    } else if (inputType === 'gaps') {
      actual = [...itemNode.querySelectorAll('[data-gap-index]')].map((input) => input.value);
      const expected = Array.isArray(item.answers) ? item.answers : [];
      correct = expected.length > 0 && expected.every((answer, index) => {
        const accepted = Array.isArray(answer) ? answer : [answer];
        return accepted.some((variant) => normalizeAnswer(variant) === normalizeAnswer(actual[index]));
      });
    } else {
      actual = itemNode.querySelector('input, textarea')?.value || '';
      correct = textAnswerMatches(item, actual);
    }

    return { actual, correct };
  }

  function checkExerciseBlock(block, node) {
    const actual = {};
    let correctCount = 0;
    let total = 0;

    (Array.isArray(block.items) ? block.items : []).forEach((item, index) => {
      if (item.example) return;
      const itemId = safeText(item.id, `${index + 1}`);
      const itemNode = node.querySelector(`[data-exercise-item="${CSS.escape(itemId)}"]`);
      if (!itemNode) return;
      const result = checkExerciseItem(item, itemNode);
      actual[itemId] = result.actual;
      const feedback = itemNode.querySelector('.feedback');

      if (item.scored === false) {
        itemNode.classList.remove('is-correct', 'is-wrong');
        itemNode.classList.add('is-saved');
        if (feedback) {
          feedback.className = 'feedback show neutral';
          feedback.textContent = 'Ответ сохранён для преподавателя.';
        }
        return;
      }

      total += 1;
      if (result.correct) correctCount += 1;
      itemNode.classList.toggle('is-correct', result.correct);
      itemNode.classList.toggle('is-wrong', !result.correct);
      itemNode.classList.remove('is-saved');
      if (feedback) {
        feedback.className = `feedback show ${result.correct ? 'good' : 'bad'}`;
        feedback.textContent = result.correct ? 'Верно!' : safeText(item.explanation, 'Проверь ответ и попробуй ещё раз.');
      }
    });

    return { actual, correctCount, total };
  }

  function checkLessonTask(block, node) {
    if (block.type === 'exercise') return checkExerciseBlock(block, node);
    let actual;
    let correct = false;
    if (block.type === 'single') {
      actual = node.querySelector('input:checked')?.value;
      correct = Number(actual) === Number(block.answer);
    } else if (block.type === 'multiple') {
      actual = [...node.querySelectorAll('input:checked')].map((input) => Number(input.value)).sort((a,b) => a-b);
      const expected = [...(block.answer || [])].map(Number).sort((a,b) => a-b);
      correct = JSON.stringify(actual) === JSON.stringify(expected);
    } else if (block.type === 'select') {
      actual = node.querySelector('select')?.value;
      correct = Number(actual) === Number(block.answer);
    } else if (block.type === 'match') {
      actual = [...node.querySelectorAll('[data-match-index]')].map((select) => Number(select.value));
      correct = actual.length > 0 && actual.every((value, index) => value === index);
    } else {
      actual = node.querySelector('input, textarea')?.value || '';
      if (Array.isArray(block.answer)) correct = block.answer.some((answer) => normalizeAnswer(answer) === normalizeAnswer(actual));
      else correct = normalizeAnswer(block.answer) !== '' && normalizeAnswer(block.answer) === normalizeAnswer(actual);
    }
    return { correctCount: correct ? 1 : 0, total: 1, actual };
  }

  function restoreExerciseAnswers(block, node, saved) {
    if (!saved || typeof saved !== 'object') return;
    (Array.isArray(block.items) ? block.items : []).forEach((item, index) => {
      if (item.example) return;
      const itemId = safeText(item.id, `${index + 1}`);
      const value = saved[itemId];
      if (value === undefined) return;
      const itemNode = node.querySelector(`[data-exercise-item="${CSS.escape(itemId)}"]`);
      if (!itemNode) return;
      const inputType = item.input || 'text';
      if (inputType === 'multiple') {
        const selected = new Set(Array.isArray(value) ? value.map(Number) : []);
        itemNode.querySelectorAll('input[type="checkbox"]').forEach((input) => { input.checked = selected.has(Number(input.value)); });
      } else if (inputType === 'single') {
        const input = itemNode.querySelector(`input[value="${CSS.escape(safeText(value))}"]`);
        if (input) input.checked = true;
      } else if (inputType === 'select') {
        const select = itemNode.querySelector('select');
        if (select) select.value = safeText(value);
      } else if (inputType === 'gaps') {
        const values = Array.isArray(value) ? value : [];
        itemNode.querySelectorAll('[data-gap-index]').forEach((input, gapIndex) => { input.value = safeText(values[gapIndex]); });
      } else {
        const input = itemNode.querySelector('input, textarea');
        if (input) input.value = safeText(value);
      }
    });
  }

  function restoreLessonAnswers(root, blocks, savedAnswers) {
    if (!savedAnswers || typeof savedAnswers !== 'object') return;
    blocks.forEach((block, index) => {
      const taskId = safeText(block.id, `task-${index}`);
      const value = savedAnswers[taskId];
      if (value === undefined) return;
      const node = root.querySelector(`[data-task="${CSS.escape(taskId)}"]`);
      if (!node) return;
      if (block.type === 'exercise') {
        restoreExerciseAnswers(block, node, value);
      } else if (block.type === 'single') {
        const input = node.querySelector(`input[value="${CSS.escape(safeText(value))}"]`);
        if (input) input.checked = true;
      } else if (block.type === 'multiple') {
        const selected = new Set(Array.isArray(value) ? value.map(Number) : []);
        node.querySelectorAll('input[type="checkbox"]').forEach((input) => { input.checked = selected.has(Number(input.value)); });
      } else if (block.type === 'select') {
        const select = node.querySelector('select');
        if (select) select.value = safeText(value);
      } else if (block.type === 'match') {
        const values = Array.isArray(value) ? value : [];
        node.querySelectorAll('[data-match-index]').forEach((select, matchIndex) => { select.value = safeText(values[matchIndex]); });
      } else {
        const input = node.querySelector('input, textarea');
        if (input) input.value = safeText(value);
      }
    });
  }

  function showLessonTaskResult(block, node, result) {
    if (block.type === 'exercise') return;
    const total = Number(result.total || 0);
    const correctCount = Number(result.correctCount || 0);
    const isCorrect = total > 0 && correctCount === total;
    node.classList.toggle('is-correct', isCorrect);
    node.classList.toggle('is-wrong', !isCorrect);
    const feedback = node.querySelector('.feedback');
    if (feedback) {
      feedback.className = `feedback show ${isCorrect ? 'good' : 'bad'}`;
      feedback.textContent = isCorrect ? 'Верно!' : safeText(block.explanation, 'В ответе есть ошибка.');
    }
  }

  function reviewRestoredLesson(root, blocks) {
    const checkableTypes = ['text','textarea','single','multiple','select','match','reorder','translate','audio','exercise'];
    blocks
      .filter((block) => checkableTypes.includes(block.type) && !(block.type === 'audio' && block.response === false))
      .forEach((block, index) => {
        const taskId = safeText(block.id, `task-${index}`);
        const node = root.querySelector(`[data-task="${CSS.escape(taskId)}"]`);
        if (!node) return;
        const result = checkLessonTask(block, node);
        showLessonTaskResult(block, node, result);
      });
  }

  function lockCompletedLesson(root) {
    root.classList.add('lesson-is-locked');
    root.querySelectorAll('input, textarea').forEach((control) => {
      if (control.type === 'radio' || control.type === 'checkbox') {
        control.disabled = true;
      } else {
        control.readOnly = true;
        control.setAttribute('aria-readonly', 'true');
      }
    });
    root.querySelectorAll('select, button[data-word]').forEach((control) => {
      control.disabled = true;
    });
  }

  async function renderLesson() {
    const id = queryParam('id');
    const lessonRecord = HOMEWORK_DATA.find((item) => item.id === id && item.status !== 'draft');
    const root = byId('lesson-root');
    if (!lessonRecord || lessonRecord.status === 'locked') {
      root.innerHTML = emptyState('📝', 'Задание ещё не опубликовано', 'Преподаватель добавит материал после урока.');
      return;
    }

    byId('lesson-hero-title').textContent = safeText(lessonRecord.title, 'Задание');
    byId('lesson-hero-subtitle').textContent = safeText(lessonRecord.subtitle, 'Интерактивная практика');
    root.innerHTML = '<div class="card empty-state compact-empty"><div class="empty-state-icon">⏳</div><h3>Загружаем задание…</h3></div>';

    let lesson;
    try {
      lesson = await resolveLessonContent(lessonRecord);
    } catch (error) {
      console.error('Ошибка загрузки содержимого урока:', error);
      root.innerHTML = emptyState('⚠️', 'Не удалось загрузить задание', 'Проверьте наличие JSON-файла урока в папке data/lessons и корректность его структуры.');
      return;
    }

    const blocks = Array.isArray(lesson?.blocks) ? lesson.blocks : [];
    if (!blocks.length) {
      root.innerHTML = emptyState('📝', 'Задание ещё не опубликовано', 'Содержание появится после подготовки преподавателем.');
      return;
    }

    const progress = window.ProgressService.loadHomeworkProgress();
    const savedResult = progress.results[lesson.id];
    const isCompleted = progress.completedIds.includes(lesson.id)
      || Boolean(progress.submissions[lesson.id])
      || lessonRecord.status === 'completed';
    const pointsLabel = Number(lesson.totalPoints || 0) > 0 ? `${escapeHtml(lesson.totalPoints)} проверяемых ответов` : 'Без автоматической оценки';
    const hasManualResponses = blocks.some((block) => block.type === 'exercise' && (block.items || []).some((item) => item.scored === false));
    const lessonSections = blocks
      .map((block, blockIndex) => block.type === 'section' ? { block, blockIndex } : null)
      .filter(Boolean);
    const roadmap = lessonSections.length
      ? `<nav class="card lesson-roadmap" aria-label="План домашнего задания"><div class="lesson-roadmap-heading"><span class="eyebrow">План задания</span><p>Проходи блоки по порядку — ответы сохранятся после проверки.</p></div><ol>${lessonSections.map(({ block, blockIndex }, sectionIndex) => `<li><a href="#lesson-section-${blockIndex}"><span>${sectionIndex + 1}</span><strong>${escapeHtml(block.title || `Часть ${sectionIndex + 1}`)}</strong></a></li>`).join('')}</ol></nav>`
      : '';
    let sectionNumber = 0;
    const renderedBlocks = blocks.map((block, blockIndex) => {
      if (block.type === 'section') sectionNumber += 1;
      return renderLessonBlock(block.type === 'section' ? { ...block, __sectionNumber: sectionNumber } : block, blockIndex);
    }).join('');
    const actionsMarkup = isCompleted
      ? `<div class="card section lesson-actions lesson-completed-panel"><div id="lesson-result" aria-live="polite"></div><div class="completed-lock-message"><span class="completed-lock-icon" aria-hidden="true">🔒</span><div><h3>Работа выполнена</h3><p class="muted">Ответы проверены и заблокированы. Изменить или стереть их уже нельзя.</p></div></div></div>`
      : `<div class="card section lesson-actions"><div id="lesson-result" aria-live="polite"></div><div class="button-row"><button class="btn btn-primary" id="check-lesson" type="button">Проверить ответы</button><button class="btn btn-secondary" id="submit-lesson" type="button" ${savedResult ? '' : 'disabled'}>Отправить преподавателю</button></div><p class="muted save-note">После проверки ответы сохраняются на устройстве и сразу синхронизируются с Supabase.</p></div>`;
    root.innerHTML = `<div class="card lesson-intro"><div><span class="eyebrow">Домашнее задание</span><p>${escapeHtml(lesson.subtitle || '')}</p></div><span class="lesson-points">${pointsLabel}</span></div>
      ${roadmap}
      <div id="lesson-blocks">${renderedBlocks}</div>
      ${actionsMarkup}`;

    const restoredAnswers = mergeLessonAnswers(
      convertLegacyHomeworkAnswers(lesson.id, savedResult?.legacyAnswers, lesson),
      savedResult?.answers
    );
    restoreLessonAnswers(root, blocks, restoredAnswers);
    if (savedResult && Number(savedResult.total) > 0) {
      byId('lesson-result').innerHTML = `<h3>Сохранённый результат: ${Number(savedResult.correct || 0)} из ${Number(savedResult.total || 0)}</h3><p class="muted">${Number(savedResult.percent || 0)}% правильных ответов</p>`;
    }
    if (savedResult) reviewRestoredLesson(root, blocks);
    if (isCompleted) lockCompletedLesson(root);

    root.querySelectorAll('[data-reorder-source]').forEach((source) => {
      source.addEventListener('click', (event) => {
        const chip = event.target.closest('[data-word]');
        if (!chip) return;
        chip.classList.toggle('selected');
        const parent = source.closest('[data-task]');
        const input = parent.querySelector('input');
        const selected = [...source.querySelectorAll('.selected')].map((item) => item.dataset.word);
        input.value = selected.join(' ');
      });
    });

    const checkLessonButton = byId('check-lesson');
    if (checkLessonButton) checkLessonButton.addEventListener('click', () => {
      const checkableTypes = ['text','textarea','single','multiple','select','match','reorder','translate','audio','exercise'];
      const checkable = blocks.filter((block) => checkableTypes.includes(block.type) && !(block.type === 'audio' && block.response === false));
      let correct = 0;
      let total = 0;
      const answers = {};
      checkable.forEach((block, index) => {
        const taskId = safeText(block.id, `task-${index}`);
        const node = root.querySelector(`[data-task="${CSS.escape(taskId)}"]`);
        if (!node) return;
        const result = checkLessonTask(block, node);
        answers[taskId] = result.actual;
        correct += Number(result.correctCount || 0);
        total += Number(result.total || 0);
        if (block.type !== 'exercise') {
          showLessonTaskResult(block, node, result);
        }
      });
      const percent = safePercent(correct, total);
      const manualNote = hasManualResponses ? ' · развёрнутый ответ сохранён отдельно и не входит в балл' : '';
      byId('lesson-result').innerHTML = `<h3>Результат: ${correct} из ${total}</h3><p class="muted">${percent}% правильных ответов${manualNote}</p>`;
      const updatedProgress = window.ProgressService.loadHomeworkProgress();
      updatedProgress.results[lesson.id] = {
        correct,
        total,
        percent,
        answers,
        legacyAnswers: savedResult?.legacyAnswers || null,
        migratedAt: savedResult?.migratedAt || null,
        checkedAt: new Date().toISOString()
      };
      window.ProgressService.saveHomeworkProgress(updatedProgress);
      byId('submit-lesson').disabled = false;
    });
    const submitLessonButton = byId('submit-lesson');
    if (submitLessonButton) submitLessonButton.addEventListener('click', () => {
      const updatedProgress = window.ProgressService.loadHomeworkProgress();
      updatedProgress.submissions[lesson.id] = { savedAt: new Date().toISOString(), status: CloudService.isConfigured() ? 'pending-cloud' : 'local' };
      if (!updatedProgress.completedIds.includes(lesson.id)) updatedProgress.completedIds.push(lesson.id);
      window.ProgressService.saveHomeworkProgress(updatedProgress);
      showToast(CloudService.isConfigured() ? 'Ответы сохранены и отправляются в Supabase.' : 'Ответы сохранены на устройстве.');
      lockCompletedLesson(root);
      const actions = root.querySelector('.lesson-actions');
      if (actions) {
        actions.classList.add('lesson-completed-panel');
        actions.innerHTML = `<div id="lesson-result" aria-live="polite"><h3>Работа отправлена</h3><p class="muted">Ответы сохранены и больше не редактируются.</p></div><div class="completed-lock-message"><span class="completed-lock-icon" aria-hidden="true">🔒</span><div><h3>Работа выполнена</h3><p class="muted">Ответы проверены и заблокированы. Изменить или стереть их уже нельзя.</p></div></div>`;
      }
    });
  }

  function grammarTable(table) {
    if (!table || !Array.isArray(table.headers) || !Array.isArray(table.rows)) return '';
    return `<div class="table-wrap"><table><thead><tr>${table.headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('')}</tr></thead><tbody>${table.rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  }

  function renderGrammarTopic() {
    const id = queryParam('id');
    const topic = GRAMMAR_DATA.find((item) => item.id === id && item.status !== 'draft');
    const root = byId('grammar-topic-root');
    if (!topic || topic.status === 'locked') {
      root.innerHTML = emptyState('📐', 'Грамматическая тема ещё не опубликована', 'Материал появится после публикации преподавателем.');
      return;
    }
    byId('grammar-hero-title').textContent = safeText(topic.title, 'Грамматика');
    byId('grammar-hero-subtitle').textContent = `${safeText(topic.level, student.level)} Level · теория и практика`;
    const examples = Array.isArray(topic.examples) ? topic.examples : [];
    const mistakes = Array.isArray(topic.commonMistakes) ? topic.commonMistakes : [];
    const quiz = Array.isArray(topic.quiz) ? topic.quiz : [];
    root.innerHTML = `
      <article class="card"><span class="eyebrow">Объяснение</span><h2>${escapeHtml(topic.title)}</h2><p class="muted">${escapeHtml(topic.explanation || '')}</p></article>
      ${topic.formula ? `<article class="card lesson-block tip-card"><h3>Формула</h3><p>${escapeHtml(topic.formula)}</p></article>` : ''}
      ${topic.affirmative ? `<article class="card lesson-block"><h3>Утвердительная форма</h3><p>${escapeHtml(topic.affirmative)}</p></article>` : ''}
      ${topic.negative ? `<article class="card lesson-block"><h3>Отрицательная форма</h3><p>${escapeHtml(topic.negative)}</p></article>` : ''}
      ${topic.question ? `<article class="card lesson-block"><h3>Вопросительная форма</h3><p>${escapeHtml(topic.question)}</p></article>` : ''}
      ${topic.table ? `<article class="card lesson-block"><h3>Таблица</h3>${grammarTable(topic.table)}</article>` : ''}
      ${examples.length ? `<article class="card lesson-block"><h3>Примеры</h3><div class="list">${examples.map((example) => `<p>• ${escapeHtml(example)}</p>`).join('')}</div></article>` : ''}
      ${mistakes.length ? `<article class="card lesson-block info-card"><h3>Частые ошибки русскоговорящих</h3><div class="list">${mistakes.map((mistake) => `<p>• ${escapeHtml(mistake)}</p>`).join('')}</div></article>` : ''}
      <section class="section" aria-labelledby="mini-test-title"><div class="section-heading"><div><span class="eyebrow">Практика</span><h2 id="mini-test-title">Мини-тест</h2></div></div><div id="grammar-quiz"></div></section>`;
    const quizRoot = byId('grammar-quiz');
    if (!quiz.length) {
      quizRoot.innerHTML = emptyState('🧩', 'Мини-тест ещё не добавлен', 'Вопросы появятся вместе с материалом преподавателя.');
      return;
    }
    const renderQuiz = () => {
      quizRoot.innerHTML = `${quiz.map((question, index) => `<article class="card lesson-block" data-grammar-question="${index}"><h3>${index + 1}. ${escapeHtml(question.prompt)}</h3><div class="option-list">${(question.options || []).map((option, optionIndex) => `<label class="option"><input type="radio" name="grammar-${index}" value="${optionIndex}"><span>${escapeHtml(option)}</span></label>`).join('')}</div><div class="feedback"></div></article>`).join('')}<div class="card section"><div id="grammar-result"></div><div class="button-row"><button class="btn btn-primary" type="button" id="check-grammar">Проверить</button><button class="btn btn-secondary" type="button" id="retry-grammar">Повторить</button></div></div>`;
      byId('check-grammar').addEventListener('click', () => {
        let correct = 0;
        quiz.forEach((question, index) => {
          const node = quizRoot.querySelector(`[data-grammar-question="${index}"]`);
          const selected = node.querySelector('input:checked');
          const isCorrect = selected && Number(selected.value) === Number(question.answer);
          if (isCorrect) correct += 1;
          const feedback = node.querySelector('.feedback');
          feedback.className = `feedback show ${isCorrect ? 'good' : 'bad'}`;
          feedback.textContent = isCorrect ? 'Верно!' : safeText(question.explanation, 'Проверь правило и попробуй ещё раз.');
        });
        const percent = safePercent(correct, quiz.length);
        byId('grammar-result').innerHTML = `<h3>Результат: ${correct} из ${quiz.length}</h3><p class="muted">${percent}% правильных ответов</p>`;
        const progress = window.ProgressService.loadGrammarProgress();
        const previous = progress.topics[topic.id] || {};
        progress.topics[topic.id] = { passed: percent === 100, attempts: Number(previous.attempts || 0) + 1, bestScore: Math.max(Number(previous.bestScore || 0), percent), updatedAt: new Date().toISOString() };
        window.ProgressService.saveGrammarProgress(progress);
      });
      byId('retry-grammar').addEventListener('click', renderQuiz);
    };
    renderQuiz();
  }

  function getTopicProgress(progress, topicId) {
    if (!progress.topics[topicId]) progress.topics[topicId] = { tests: [] };
    if (!Array.isArray(progress.topics[topicId].tests)) progress.topics[topicId].tests = [];
    return progress.topics[topicId];
  }

  function setWordStatus(progress, word, topicId, status) {
    const now = new Date().toISOString();
    const previous = progress.words[word.__wordKey] || {};
    progress.words[word.__wordKey] = {
      status,
      topicId: previous.topicId || topicId,
      learnedAt: status === 'known' ? (previous.learnedAt || now) : null,
      updatedAt: now
    };
  }

  function renderVocabulary() {
    const id = queryParam('id');
    const topic = VOCABULARY_CATALOG.allTopics.find((item) => item.id === id);
    const root = byId('vocabulary-root');
    if (!topic || !Array.isArray(topic.words) || !topic.words.length) {
      root.innerHTML = emptyState('💥', 'Слова для этой темы ещё не добавлены', 'Преподаватель добавит список слов после урока. Повторы из предыдущих тем здесь не показываются.');
      return;
    }
    byId('vocab-hero-title').textContent = safeText(topic.title, 'Vocabulary');
    byId('vocab-hero-subtitle').textContent = `${safeText(topic.label, 'Словарная тема')} · ${topic.words.length} уникальных слов`;
    const progress = window.ProgressService.loadVocabularyProgress();
    const topicProgress = getTopicProgress(progress, topic.id);
    let mode = 'cards';
    let cardQueue = [];
    let testState = null;
    const exactKnown = exactKnownCountForTopic(progress, topic);
    const legacyKnown = Math.min(topic.words.length, Math.max(0, Number(topicProgress.legacyLearnedCount || 0)));
    const legacyNotice = legacyKnown > exactKnown
      ? `<div class="card info-card legacy-progress-note"><strong>Старый прогресс сохранён: ${legacyKnown} из ${topic.words.length}.</strong><p class="muted">В старой базе хранилось только количество выученных слов, без списка конкретных карточек. Поэтому общий результат сохранён, а отдельные слова будут уточняться по мере повторения.</p></div>`
      : '';

    root.innerHTML = `${legacyNotice}<div class="mode-tabs" id="vocab-modes" aria-label="Режим тренировки">
      <button class="mode-btn active" type="button" data-mode="cards">Новые слова</button>
      <button class="mode-btn" type="button" data-mode="test">Тест</button>
      <button class="mode-btn" type="button" data-mode="all">Все слова</button>
      <button class="mode-btn" type="button" data-mode="difficult">Сложные слова</button>
    </div><div id="vocab-mode-root" class="section"></div>`;
    const modeRoot = byId('vocab-mode-root');

    const save = () => window.ProgressService.saveVocabularyProgress(progress);
    const resetCardQueue = () => {
      cardQueue = shuffled(topic.words.filter((word) => {
        const status = progress.words[word.__wordKey]?.status;
        return mode === 'difficult' ? status === 'difficult' : status !== 'known';
      }));
    };

    const drawCard = () => {
      if (!cardQueue.length) {
        const isDifficult = mode === 'difficult';
        modeRoot.innerHTML = emptyState(
          isDifficult ? '🌟' : '🎉',
          isDifficult ? 'Сложных слов пока нет' : 'Новые слова в этой теме закончились',
          isDifficult ? 'Отметьте слово кнопкой «Трудно», и оно появится здесь.' : 'Выученные слова остаются в разделе «Все слова» и не повторяются в режиме новых слов.'
        );
        return;
      }
      const word = cardQueue[0];
      const remaining = cardQueue.length;
      modeRoot.innerHTML = `<div class="flash-counter">Осталось: ${remaining}</div><div class="flashcard-stage"><div class="flashcard" id="flashcard" tabindex="0" role="button" aria-label="Перевернуть карточку">
        <div class="flash-face flash-front"><div class="flash-word">${escapeHtml(word.en)}</div>${word.transcription ? `<div class="flash-transcription">${escapeHtml(word.transcription)}</div>` : ''}<p class="muted">Нажми, чтобы увидеть перевод</p></div>
        <div class="flash-face flash-back"><div class="flash-word">${escapeHtml(word.ru)}</div>${word.exampleEn ? `<p class="flash-example">${escapeHtml(word.exampleEn)}${word.exampleRu ? `<br>${escapeHtml(word.exampleRu)}` : ''}</p>` : ''}${word.audio ? `<audio class="audio-player" controls preload="none" src="${escapeHtml(word.audio)}"></audio>` : ''}</div>
      </div></div><div class="trainer-actions"><button class="btn btn-danger" id="word-difficult" type="button">Трудно</button><button class="btn btn-success" id="word-known" type="button">Знаю</button></div>`;
      const flashcard = byId('flashcard');
      const flip = () => flashcard.classList.toggle('flipped');
      flashcard.addEventListener('click', flip);
      flashcard.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); flip(); } });
      byId('word-known').addEventListener('click', () => {
        setWordStatus(progress, word, topic.id, 'known');
        cardQueue.shift();
        save();
        drawCard();
      });
      byId('word-difficult').addEventListener('click', () => {
        setWordStatus(progress, word, topic.id, 'difficult');
        cardQueue.shift();
        save();
        drawCard();
      });
    };

    const startTest = () => {
      if (topic.words.length < 4) {
        modeRoot.innerHTML = emptyState('🧩', 'Для теста нужно минимум 4 слова', 'Добавьте ещё уникальные слова в тему, чтобы сформировать четыре варианта ответа без выдуманных данных.');
        return;
      }
      testState = { words: shuffled(topic.words), index: 0, firstTryCorrect: 0, answered: false, firstAnswers: {} };
      drawQuestion();
    };

    const finishTest = () => {
      const result = {
        score: testState.firstTryCorrect,
        total: testState.words.length,
        percent: safePercent(testState.firstTryCorrect, testState.words.length),
        answers: testState.firstAnswers,
        completedAt: new Date().toISOString()
      };
      topicProgress.tests.push(result);
      save();
      modeRoot.innerHTML = `<div class="card empty-state"><div class="empty-state-icon">🏁</div><h3>Тест завершён</h3><p>С первого раза: ${result.score} из ${result.total}</p><div class="button-row" style="justify-content:center"><button class="btn btn-primary" id="restart-vocab-test" type="button">Пройти ещё раз</button></div></div>`;
      byId('restart-vocab-test').addEventListener('click', startTest);
    };

    const drawQuestion = () => {
      if (testState.index >= testState.words.length) { finishTest(); return; }
      const word = testState.words[testState.index];
      const distractors = shuffled(topic.words.filter((item) => item.__wordKey !== word.__wordKey)).slice(0, 3);
      const options = shuffled([word, ...distractors]);
      testState.answered = false;
      modeRoot.innerHTML = `<div class="flash-counter">Вопрос ${testState.index + 1} из ${testState.words.length}</div><article class="card"><span class="eyebrow">Выбери перевод</span><h2 class="flash-word">${escapeHtml(word.en)}</h2>${word.transcription ? `<p class="muted">${escapeHtml(word.transcription)}</p>` : ''}<div class="option-list section">${options.map((option) => `<button class="quiz-option" type="button" data-answer-key="${escapeHtml(option.__wordKey)}">${escapeHtml(option.ru)}</button>`).join('')}</div><div id="vocab-test-feedback" class="feedback"></div><div class="button-row"><button class="btn btn-primary" id="next-vocab-question" type="button" disabled>Следующее слово</button></div></article>`;
      modeRoot.querySelectorAll('[data-answer-key]').forEach((button) => {
        button.addEventListener('click', () => {
          if (testState.answered) return;
          testState.answered = true;
          const correct = button.dataset.answerKey === word.__wordKey;
          testState.firstAnswers[word.__wordKey] = { correct, selected: button.dataset.answerKey };
          if (correct) {
            testState.firstTryCorrect += 1;
            setWordStatus(progress, word, topic.id, 'known');
          } else {
            setWordStatus(progress, word, topic.id, 'difficult');
          }
          save();
          modeRoot.querySelectorAll('[data-answer-key]').forEach((optionButton) => {
            optionButton.disabled = true;
            if (optionButton.dataset.answerKey === word.__wordKey) optionButton.classList.add('correct');
          });
          if (!correct) button.classList.add('wrong');
          const feedback = byId('vocab-test-feedback');
          feedback.className = `feedback show ${correct ? 'good' : 'bad'}`;
          feedback.textContent = correct ? 'Верно с первого раза!' : `Правильный ответ: ${word.ru}`;
          byId('next-vocab-question').disabled = false;
        });
      });
      byId('next-vocab-question').addEventListener('click', () => { testState.index += 1; drawQuestion(); });
    };

    const drawAllWords = () => {
      modeRoot.innerHTML = `<div class="words-grid">${topic.words.map((word) => {
        const status = progress.words[word.__wordKey]?.status;
        return `<article class="card word-card ${status === 'known' ? 'known' : ''} ${status === 'difficult' ? 'difficult' : ''}"><strong>${escapeHtml(word.en)}</strong><span>${escapeHtml(word.ru)}</span>${word.transcription ? `<span>${escapeHtml(word.transcription)}</span>` : ''}</article>`;
      }).join('')}</div>`;
    };

    const drawMode = () => {
      if (mode === 'cards' || mode === 'difficult') {
        resetCardQueue();
        drawCard();
      } else if (mode === 'test') startTest();
      else drawAllWords();
    };
    byId('vocab-modes').addEventListener('click', (event) => {
      const button = event.target.closest('[data-mode]');
      if (!button) return;
      mode = button.dataset.mode;
      byId('vocab-modes').querySelectorAll('[data-mode]').forEach((item) => item.classList.toggle('active', item === button));
      drawMode();
    });
    drawMode();
  }

  async function refreshCurrentView() {
    const view = document.body.dataset.view;
    const renderers = {
      home: renderHome,
      homework: renderHomework,
      grammar: renderGrammar,
      'vocabulary-hub': renderVocabularyHub,
      lesson: renderLesson,
      'grammar-topic': renderGrammarTopic,
      vocabulary: renderVocabulary
    };
    try {
      await renderers[view]?.();
    } catch (error) {
      console.error('Ошибка отображения страницы:', error);
      const main = document.querySelector('main');
      if (main) main.innerHTML = emptyState('⚠️', 'Не удалось открыть страницу', 'Проверьте структуру данных и попробуйте обновить страницу.');
    }
  }

  async function init() {
    migrateLegacyPolinaProgress();
    fillConfig();
    markNavigation();
    try {
      await loadHomeworkData();
    } catch (error) {
      console.error('Ошибка загрузки каталога уроков:', error);
      HOMEWORK_DATA = [];
      window.HOMEWORK_DATA = HOMEWORK_DATA;
    }
    await refreshCurrentView();
    if (!CloudService.isConfigured()) return;
    try {
      await CloudService.init();
      await window.ProgressService.syncFromCloud();
      await refreshCurrentView();
    } catch (error) {
      console.error('Ошибка подключения к Supabase:', error);
      const detail = safeText(error?.message || error?.details || error?.hint);
      showToast(detail ? `Ошибка Supabase: ${detail}` : 'Supabase временно недоступен.');
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
