export interface AppSettings {
  languageOrder: string[];
  activeUiLanguages: string[];
  /** Languages whose definition entries are shown in word displays. Generation always covers all supported languages. */
  displayDefinitionLanguages: string[];
  /** Languages whose example translations are shown. Generation always covers all supported languages. */
  displayExampleTranslationLanguages: string[];
  /** Default word source language pre-selected when opening Smart Add Word (the outer Language radio). Backend full-name format: "english", "chinese", or any custom string. */
  defaultAddWordLanguage: string;
  /** Default language pre-selected for the first definition row when opening Smart Add Word. Either an ISO code from `languageOrder` or a free-form custom language name. */
  defaultDefinitionLanguage: string;
  /** Default speaking/writing toggle when opening the correction view. */
  defaultCorrectionMode: "speaking" | "writing";
  /** Default use case key when correction mode is "speaking" (e.g. "professional"). */
  defaultSpeakingUseCase: string;
  /** Default use case key when correction mode is "writing" (e.g. "academic"). */
  defaultWritingUseCase: string;
  /** ISO code of the source language pre-selected when opening the translation view. */
  defaultTranslationSourceLanguage: string;
  /** ISO codes of the target languages pre-selected when opening the translation view. */
  defaultTranslationTargetLanguages: string[];
}
