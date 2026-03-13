const translations = {
  en: {
    appTitle: "Vocab Trainer",
    welcome: "Select a language and start a quiz!",
    startQuiz: "Start New Quiz",
    showAnswer: "Show Answer",
    iWasCorrect: "I Was Correct",
    iWasWrong: "I Was Wrong",
    quizComplete: "Quiz Complete!",
    backToHome: "Back to Home",
    resumeQuiz: "Resume Quiz",
    startNewQuiz: "Start New",
    existingQuizFound: "You have an in-progress quiz for this language. Resume or start a new one?",
    japaneseDefinition: "Japanese",
    examples: "Examples",
    selectQuizLanguage: "Select Quiz Language",
    cancel: "Cancel",
    words: "words",
    selectFilters: "Select Quiz Filters",
    topicsColumn: "Topics",
    grammarColumn: "Grammar Categories",
    selectAll: "Select All",
    clearAll: "Clear All",
    levelsColumn: "Levels",
    noFiltersHint: "Select at least one topic, category, or level to start",
    back: "Back",
  },
} as const;

export type TranslationKey = keyof (typeof translations)["en"];
export default translations;
