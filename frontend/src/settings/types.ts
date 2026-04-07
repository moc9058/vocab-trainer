export interface AppSettings {
  languageOrder: string[];
  activeUiLanguages: string[];
  /** Languages whose definition entries are shown in word displays. Generation always covers all supported languages. */
  displayDefinitionLanguages: string[];
  /** Languages whose example translations are shown. Generation always covers all supported languages. */
  displayExampleTranslationLanguages: string[];
  /** Default language pre-selected for the first definition row when opening Smart Add Word. Either an ISO code from `languageOrder` or a free-form custom language name. */
  defaultDefinitionLanguage: string;
}
