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
  const completeHtml = renderCompleteWordsQuestion();
  if ((completeHtml.match(/data-complete-word=/g) || []).length !== 5) {
    throw new Error("Multi-word Complete the Words inputs were not rendered");
  }
  completeAnswers = Object.fromEntries(
    getCurrentClozeTargets().map((word) => [word, word.slice(Math.max(1, Math.ceil(word.length / 2)))])
  );
  checkCompleteWordAnswer();
  if (!completeWordAnswered) throw new Error("Multi-word answers were not accepted");

  practiceMode = "simulation";
  practiceGroupIndex = 0;
  resetPracticeQueue();
  const simulationHtml = renderSimulationQuestion(practiceQueue[0]);
  if ((simulationHtml.match(/data-complete-word=/g) || []).length !== practiceQueue[0].targets.length) {
    throw new Error("TOEFL simulation inputs were not rendered");
  }

  practiceMode = "sentence";
  practiceGroupIndex = 0;
  resetPracticeQueue();
  const sentenceHtml = renderSentenceQuestion(practiceQueue[0]);
  if ((sentenceHtml.match(/data-sentence-tile=/g) || []).length !== practiceQueue[0].answer.length) {
    throw new Error("Build a Sentence tiles were not rendered");
  }
  sentenceSelection = practiceQueue[0].answer.map((_, index) => index);
  checkSentenceAnswer();
  if (sentenceAnswered !== true) throw new Error("Correct sentence order was not accepted");

  importSession.text = "Students participating in the study completed a survey.";
  importSession.tokenLemmas = { participating: "participate" };
  importSession.candidates = [{
    word: "participate",
    count: 1,
    basic: false,
    score: "medium",
    mode: "recognition",
    gloss: { partOfSpeech: "verb", zh: "参与，参加" },
  }];
  const sourceHtml = renderSourceCandidateView(importSession.candidates);
  if (!sourceHtml.includes("v. 参与，参加") || !sourceHtml.includes("is-recognition")) {
    throw new Error("Source text classification did not show the basic meaning and selected mode");
  }
`, context);

console.log("Practice smoke tests passed");
