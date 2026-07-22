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
  remove() {}
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
  let listeningHtml = renderPracticeStage();
  if (!listeningHtml.includes("8 个字母") || !listeningHtml.includes("word-length-slots") || listeningHtml.includes("data-rating")) {
    throw new Error("Listening spelling should show letter count before answering and no rating buttons");
  }
  document.querySelector("#spelling-answer").value = "wrong";
  checkSpellingAnswer();
  if (!state.mistakeBook.includes(practiceQueue[0].id) || !spellingAnswered || spellingCorrect !== false) {
    throw new Error("Wrong listening answer should reveal answer and enter mistake book");
  }
  listeningHtml = renderPracticeStage();
  if (!listeningHtml.includes("听完后显示中文释义") || !listeningHtml.includes(practiceQueue[0].word)) {
    throw new Error("Listening result should show the correct spelling and Chinese meaning after answering");
  }

  state.words.forEach((word) => { word.inMistakeBook = false; });
  state.mistakeBook = ["spell-0"];
  practiceMode = "mistakes";
  resetPracticeQueue();
  if (practiceQueue.length !== 1 || practiceQueue[0].id !== "spell-0") {
    throw new Error("Mistake book practice queue is invalid");
  }
  practiceRevealed = true;
  if (renderPracticeStage().includes("data-rating")) {
    throw new Error("Mistake book should not render rating buttons");
  }

  practiceMode = "listening";
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
  const missingCounts = [...completeHtml.matchAll(/data-missing-letters="(\\d+)"/g)].map((match) => Number(match[1]));
  const slotCount = completeHtml.split("<i></i>").length - 1;
  if (missingCounts.length !== 5 || slotCount !== missingCounts.reduce((sum, count) => sum + count, 0)) {
    throw new Error("Complete the Words character slots do not match the missing-letter counts");
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
  if (sourceHtml.includes("v. 参与，参加") || !sourceHtml.includes("is-recognition")) {
    throw new Error("Source text classification should hide meanings until a word is selected");
  }
  activeImportCandidate = "participate";
  if (!renderActiveCandidateDetail().includes("v. 参与，参加")) {
    throw new Error("Selected source word did not show its basic meaning");
  }
  if (lemmatize("nutritious") !== "nutritious") {
    throw new Error("Adjectives ending in -ious should not lose final s");
  }
  if (lemmatize("conditions") !== "condition") {
    throw new Error("Plural nouns should still lose final s");
  }
  document.querySelector("#candidate-word-edit").value = "participation";
  renameCandidateWord("participate");
  if (!importSession.candidates.some((candidate) => candidate.word === "participation") || importSession.tokenLemmas.participating !== "participation") {
    throw new Error("Candidate spelling edit did not update candidates and source mapping");
  }

  const localDrafts = parseCompleteWordsLocally(
    "Fill in the missing letters.\\n\\nTh_ _ plants gr_ _ rapidly.\\n\\nAnswer Key\\n1 ese\\n2 ow"
  );
  if (localDrafts.length !== 1 || !localDrafts[0].text.includes("[[These]]") || !localDrafts[0].text.includes("[[grow]]")) {
    throw new Error("Local Complete the Words conversion failed");
  }

  state.customExerciseSets = [{
    id: "custom-set",
    title: "Uploaded Set",
    type: "complete",
    createdAt: 100,
    questions: [{
      id: "custom-question",
      topic: "Uploaded Set",
      text: "Plants [[absorb]] light.",
      targets: ["absorb"],
    }],
  }];
  practiceMode = "simulation";
  exerciseSetFilter = "custom-set";
  resetPracticeQueue();
  if (practiceQueue.length !== 1 || practiceQueue[0].setTitle !== "Uploaded Set") {
    throw new Error("Archived custom exercise set was not added to practice");
  }

  customExerciseImport = {
    phase: "review",
    type: "complete",
    title: "Imported Complete Words",
    fileName: "complete.pdf",
    text: "",
    status: "",
    drafts: [{ text: "Plants [[absorb]] light." }],
  };
  saveCustomExerciseSet();
  if (!state.customExerciseSets.some((set) => set.title === "Imported Complete Words" && set.questions.length === 1)) {
    throw new Error("Converted exercise set was not archived");
  }
  practiceFocused = false;
  renderPractice();
  if (!content.innerHTML.includes("选择一种练习") || content.innerHTML.includes("practice-sidebar")) {
    throw new Error("Practice chooser was not rendered without the old sidebar");
  }
  practiceFocused = true;
  practiceMode = "simulation";
  renderPractice();
  if (!content.innerHTML.includes("back-practice-picker") || content.innerHTML.includes("practice-sidebar")) {
    throw new Error("Focused practice view did not render its return control");
  }
  openCustomExerciseImport();
  if (!modalRoot.innerHTML.includes("选择一个或多个 PDF / Word / 图片 / 文本") || modalRoot.innerHTML.includes("Build a Sentence")) {
    throw new Error("Personal exercise import UI was not rendered");
  }
`, context);

console.log("Practice smoke tests passed");
