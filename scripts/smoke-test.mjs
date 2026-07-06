import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { webcrypto } from "node:crypto";

class MockElement {
  constructor() {
    this.innerHTML = "";
    this.textContent = "";
    this.value = "";
    this.dataset = {};
    this.classList = {
      add() {},
      remove() {},
      toggle() {},
      contains() { return false; },
    };
  }

  addEventListener() {}
  appendChild() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
  setAttribute() {}
  focus() {}
}

const elements = new Map();
const document = {
  addEventListener() {},
  createElement() { return new MockElement(); },
  querySelector(selector) {
    if (!elements.has(selector)) elements.set(selector, new MockElement());
    return elements.get(selector);
  },
  querySelectorAll() { return []; },
  body: new MockElement(),
};

const storage = new Map();
const context = vm.createContext({
  console,
  crypto: webcrypto,
  document,
  window: { addEventListener() {}, Tesseract: null },
  localStorage: {
    getItem(key) { return storage.get(key) || null; },
    setItem(key, value) { storage.set(key, String(value)); },
    removeItem(key) { storage.delete(key); },
  },
  fetch: async () => ({ ok: true, json: async () => ({ user: null }) }),
  requestAnimationFrame(callback) { callback(); },
  setTimeout,
  clearTimeout,
  confirm: () => true,
  Blob,
  URL,
});

vm.runInContext(await readFile(new URL("../app.js", import.meta.url), "utf8"), context);
await new Promise((resolve) => setTimeout(resolve, 0));

vm.runInContext(`
  state.words = Array.from({ length: 45 }, (_, index) => ({
    id: "spell-" + index,
    word: "lexeme" + String.fromCharCode(97 + Math.floor(index / 26)) + String.fromCharCode(97 + (index % 26)),
    mode: "spelling",
    partOfSpeech: "noun",
    definitions: [{ en: "an academic concept " + index, zh: "学术概念" + index }],
    irregularForms: [],
    wordFamily: [],
    collocations: [],
    synonyms: [],
    audio: "/media/test.mp3",
    createdAt: index,
    srs: { ...defaultSrs(), reps: index, interval: index },
  }));
  state.words.push({
    id: "recognition-1",
    word: "plausible",
    mode: "recognition",
    partOfSpeech: "adjective",
    definitions: [{ en: "seeming reasonable or likely to be true", zh: "看似合理的" }],
    irregularForms: [],
    wordFamily: [],
    collocations: [],
    synonyms: [{ word: "credible", differenceZh: "可信的" }],
    audio: "",
    createdAt: 50,
    srs: defaultSrs(),
  });

  practiceMode = "listening";
  practiceSort = "created";
  practiceGroupIndex = 0;
  resetPracticeQueue();
  if (practiceQueue.length !== 20) throw new Error("Listening group should contain 20 words");
  let playedWordId = "";
  playWordAudio = (id) => { playedWordId = id; };
  autoPlayCurrentListeningWord();
  if (playedWordId !== practiceQueue[0].id) throw new Error("Listening audio did not autoplay");

  practiceGroupIndex = 2;
  resetPracticeQueue();
  if (practiceQueue.length !== 5 || practiceQueue.some((word) => word.createdAt < 40)) {
    throw new Error("Last listening group membership is incorrect");
  }

  practiceMode = "vocabulary";
  practiceGroupIndex = 0;
  resetPracticeQueue();
  const vocabularyQuestion = getVocabularyQuestion(practiceQueue[0]);
  if (vocabularyQuestion.options.length !== 4 || !vocabularyQuestion.options.includes(vocabularyQuestion.answer)) {
    throw new Error("Vocabulary question options are invalid");
  }
  if (!vocabularyQuestion.passage.includes("plausible")) {
    throw new Error("Vocabulary target is missing from its passage");
  }

  practiceMode = "complete";
  practiceGroupIndex = 0;
  resetPracticeQueue();
  const completeHtml = renderCompleteWordsQuestion(practiceQueue[0]);
  if (!completeHtml.includes('id="complete-word-answer"')) {
    throw new Error("Complete the Words input was not rendered");
  }
`, context);

console.log("Practice smoke tests passed");
