import { useState } from "react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useI18n } from "../i18n/context";
import { useSettings } from "../settings/context";
import { ALL_KNOWN_LANGUAGES, DEFAULT_SETTINGS, LANG_LABEL_MAP } from "../settings/defaults";
import { uiLanguages, type TranslationKey } from "../i18n/translations";

interface Props {
  onClose: () => void;
}

const KNOWN_WORD_LANG_OPTIONS = ["english", "chinese"] as const;
const WORD_LANG_LABELS: Record<string, string> = {
  english: "English",
  chinese: "Chinese",
};

const SPEAKING_USE_CASE_KEYS = ["professional", "casual", "presentation", "interview"] as const;
const WRITING_USE_CASE_KEYS = ["academic", "social", "email", "creative"] as const;

const USE_CASE_LABEL_KEYS: Record<string, string> = {
  professional: "useCaseProfessional",
  casual: "useCaseCasual",
  presentation: "useCasePresentation",
  interview: "useCaseInterview",
  academic: "useCaseAcademic",
  social: "useCaseSocial",
  email: "useCaseEmail",
  creative: "useCaseCreative",
};

function SortableItem({ id }: { id: string }) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id });
  const style = { transform: CSS.Transform.toString(transform), transition };
  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className="flex items-center gap-3 rounded-lg border border-gray-600 bg-gray-700 px-3 py-2 cursor-grab active:cursor-grabbing"
    >
      <span className="text-gray-500">⠿</span>
      <span className="text-sm font-medium uppercase text-gray-400 w-6">{id}</span>
      <span className="text-sm text-gray-200">{LANG_LABEL_MAP[id] ?? id}</span>
    </div>
  );
}

export default function SettingsModal({ onClose }: Props) {
  const { t } = useI18n();
  const { settings, updateSettings } = useSettings();

  const [order, setOrder] = useState<string[]>([...settings.languageOrder]);
  const [activeUi, setActiveUi] = useState<Set<string>>(new Set(settings.activeUiLanguages));
  const [displayDefLangs, setDisplayDefLangs] = useState<Set<string>>(
    new Set(settings.displayDefinitionLanguages),
  );
  const [displayExLangs, setDisplayExLangs] = useState<Set<string>>(
    new Set(settings.displayExampleTranslationLanguages),
  );
  const initialAddWordLangIsKnown = (KNOWN_WORD_LANG_OPTIONS as readonly string[]).includes(
    settings.defaultAddWordLanguage,
  );
  const [defaultAddWordLang, setDefaultAddWordLang] = useState<string>(
    initialAddWordLangIsKnown ? settings.defaultAddWordLanguage : "__other__",
  );
  const [defaultAddWordLangCustom, setDefaultAddWordLangCustom] = useState<string>(
    initialAddWordLangIsKnown ? "" : settings.defaultAddWordLanguage,
  );
  const initialDefLangIsKnown = settings.languageOrder.includes(settings.defaultDefinitionLanguage);
  const [defaultDefLang, setDefaultDefLang] = useState<string>(
    initialDefLangIsKnown ? settings.defaultDefinitionLanguage : "__other__",
  );
  const [defaultDefLangCustom, setDefaultDefLangCustom] = useState<string>(
    initialDefLangIsKnown ? "" : settings.defaultDefinitionLanguage,
  );
  const [defaultCorrectionMode, setDefaultCorrectionMode] = useState<"speaking" | "writing">(
    settings.defaultCorrectionMode,
  );
  const [defaultSpeakingUseCase, setDefaultSpeakingUseCase] = useState<string>(
    settings.defaultSpeakingUseCase,
  );
  const [defaultWritingUseCase, setDefaultWritingUseCase] = useState<string>(
    settings.defaultWritingUseCase,
  );
  const [defaultTranslationSource, setDefaultTranslationSource] = useState<string>(
    settings.defaultTranslationSourceLanguage,
  );
  const [defaultTranslationTargets, setDefaultTranslationTargets] = useState<Set<string>>(
    new Set(settings.defaultTranslationTargetLanguages),
  );

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      setOrder((prev) => {
        const oldIndex = prev.indexOf(active.id as string);
        const newIndex = prev.indexOf(over.id as string);
        return arrayMove(prev, oldIndex, newIndex);
      });
    }
  }

  function toggleSet(set: Set<string>, code: string, setter: (s: Set<string>) => void) {
    const next = new Set(set);
    if (next.has(code)) {
      if (next.size > 1) next.delete(code);
    } else {
      next.add(code);
    }
    setter(next);
  }

  function handleSave() {
    const targetLangs = order.filter((c) => defaultTranslationTargets.has(c) && c !== defaultTranslationSource);
    updateSettings({
      languageOrder: order,
      activeUiLanguages: order.filter((c) => activeUi.has(c)),
      displayDefinitionLanguages: order.filter((c) => displayDefLangs.has(c)),
      displayExampleTranslationLanguages: order.filter((c) => displayExLangs.has(c)),
      defaultAddWordLanguage:
        defaultAddWordLang === "__other__"
          ? (defaultAddWordLangCustom.trim().toLowerCase() || "english")
          : defaultAddWordLang,
      defaultDefinitionLanguage:
        defaultDefLang === "__other__"
          ? (defaultDefLangCustom.trim() || "en")
          : defaultDefLang,
      defaultCorrectionMode,
      defaultSpeakingUseCase,
      defaultWritingUseCase,
      defaultTranslationSourceLanguage: defaultTranslationSource,
      defaultTranslationTargetLanguages:
        targetLangs.length > 0
          ? targetLangs
          : [order.find((c) => c !== defaultTranslationSource) ?? defaultTranslationSource],
    });
    onClose();
  }

  function handleReset() {
    setOrder([...DEFAULT_SETTINGS.languageOrder]);
    setActiveUi(new Set(DEFAULT_SETTINGS.activeUiLanguages));
    setDisplayDefLangs(new Set(DEFAULT_SETTINGS.displayDefinitionLanguages));
    setDisplayExLangs(new Set(DEFAULT_SETTINGS.displayExampleTranslationLanguages));
    setDefaultAddWordLang(DEFAULT_SETTINGS.defaultAddWordLanguage);
    setDefaultAddWordLangCustom("");
    setDefaultDefLang(DEFAULT_SETTINGS.defaultDefinitionLanguage);
    setDefaultDefLangCustom("");
    setDefaultCorrectionMode(DEFAULT_SETTINGS.defaultCorrectionMode);
    setDefaultSpeakingUseCase(DEFAULT_SETTINGS.defaultSpeakingUseCase);
    setDefaultWritingUseCase(DEFAULT_SETTINGS.defaultWritingUseCase);
    setDefaultTranslationSource(DEFAULT_SETTINGS.defaultTranslationSourceLanguage);
    setDefaultTranslationTargets(new Set(DEFAULT_SETTINGS.defaultTranslationTargetLanguages));
  }

  const supportedUiLanguages = new Set(uiLanguages as readonly string[]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl bg-gray-800 p-6 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-5 text-lg font-semibold text-gray-100">{t("settings")}</h2>

        {/* General Section */}
        <div className="mb-6">
          <h3 className="mb-3 border-b border-gray-700 pb-2 text-base font-semibold text-gray-200">{t("settingsSectionGeneral")}</h3>

          {/* Language Display Order */}
          <section className="mb-4">
            <h4 className="mb-2 text-sm font-medium text-gray-300">{t("settingsLanguageOrder")}</h4>
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
              <SortableContext items={order} strategy={verticalListSortingStrategy}>
                <div className="space-y-1.5">
                  {order.map((code) => (
                    <SortableItem key={code} id={code} />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          </section>

          {/* Active UI Languages */}
          <section>
            <h4 className="mb-2 text-sm font-medium text-gray-300">{t("settingsActiveUiLanguages")}</h4>
            <div className="flex flex-wrap gap-2">
              {order.filter((c) => supportedUiLanguages.has(c)).map((code) => (
                <label key={code} className="flex items-center gap-1.5 text-sm text-gray-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={activeUi.has(code)}
                    onChange={() => toggleSet(activeUi, code, setActiveUi)}
                    className="accent-blue-600"
                  />
                  {LANG_LABEL_MAP[code] ?? code}
                </label>
              ))}
            </div>
          </section>
        </div>

        {/* Vocabulary Section */}
        <div className="mb-6">
          <h3 className="mb-3 border-b border-gray-700 pb-2 text-base font-semibold text-gray-200">{t("settingsSectionVocabulary")}</h3>

          <p className="mb-3 text-xs text-gray-400">{t("settingsDisplayLangsHelp")}</p>

          {/* Display Definition Languages */}
          <section className="mb-4">
            <h4 className="mb-2 text-sm font-medium text-gray-300">{t("settingsDisplayDefLangs")}</h4>
            <div className="flex flex-wrap gap-2">
              {order.map((code) => (
                <label key={code} className="flex items-center gap-1.5 text-sm text-gray-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={displayDefLangs.has(code)}
                    onChange={() => toggleSet(displayDefLangs, code, setDisplayDefLangs)}
                    className="accent-blue-600"
                  />
                  {LANG_LABEL_MAP[code] ?? code}
                </label>
              ))}
            </div>
          </section>

          {/* Display Example Translation Languages */}
          <section className="mb-4">
            <h4 className="mb-2 text-sm font-medium text-gray-300">{t("settingsDisplayExLangs")}</h4>
            <div className="flex flex-wrap gap-2">
              {order.map((code) => (
                <label key={code} className="flex items-center gap-1.5 text-sm text-gray-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={displayExLangs.has(code)}
                    onChange={() => toggleSet(displayExLangs, code, setDisplayExLangs)}
                    className="accent-blue-600"
                  />
                  {LANG_LABEL_MAP[code] ?? code}
                </label>
              ))}
            </div>
          </section>

          {/* Default Word Language for Smart Add */}
          <section className="mb-4">
            <h4 className="mb-1 text-sm font-medium text-gray-300">{t("settingsDefaultAddWordLang")}</h4>
            <p className="mb-2 text-xs text-gray-500">{t("settingsDefaultAddWordLangHelp")}</p>
            <div className="flex items-center gap-2">
              <select
                value={defaultAddWordLang}
                onChange={(e) => {
                  setDefaultAddWordLang(e.target.value);
                  if (e.target.value !== "__other__") setDefaultAddWordLangCustom("");
                }}
                className="w-32 rounded-lg border border-gray-600 bg-gray-700 px-2 py-1.5 text-sm text-gray-100 focus:border-blue-400 focus:outline-none"
              >
                {KNOWN_WORD_LANG_OPTIONS.map((value) => (
                  <option key={value} value={value}>{WORD_LANG_LABELS[value]}</option>
                ))}
                <option value="__other__">{t("settingsLangOther")}</option>
              </select>
              {defaultAddWordLang === "__other__" && (
                <input
                  type="text"
                  value={defaultAddWordLangCustom}
                  onChange={(e) => setDefaultAddWordLangCustom(e.target.value)}
                  placeholder="Language"
                  className="w-32 rounded-lg border border-gray-600 bg-gray-700 px-2 py-1.5 text-sm text-gray-100 focus:border-blue-400 focus:outline-none"
                />
              )}
            </div>
          </section>

          {/* Default Definition Language for Smart Add */}
          <section>
            <h4 className="mb-1 text-sm font-medium text-gray-300">{t("settingsDefaultDefLang")}</h4>
            <p className="mb-2 text-xs text-gray-500">{t("settingsDefaultDefLangHelp")}</p>
            <div className="flex items-center gap-2">
              <select
                value={defaultDefLang}
                onChange={(e) => {
                  setDefaultDefLang(e.target.value);
                  if (e.target.value !== "__other__") setDefaultDefLangCustom("");
                }}
                className="w-32 rounded-lg border border-gray-600 bg-gray-700 px-2 py-1.5 text-sm text-gray-100 focus:border-blue-400 focus:outline-none"
              >
                {order.map((code) => (
                  <option key={code} value={code}>{LANG_LABEL_MAP[code] ?? code}</option>
                ))}
                <option value="__other__">{t("settingsLangOther")}</option>
              </select>
              {defaultDefLang === "__other__" && (
                <input
                  type="text"
                  value={defaultDefLangCustom}
                  onChange={(e) => setDefaultDefLangCustom(e.target.value)}
                  placeholder="Language"
                  className="w-32 rounded-lg border border-gray-600 bg-gray-700 px-2 py-1.5 text-sm text-gray-100 focus:border-blue-400 focus:outline-none"
                />
              )}
            </div>
          </section>
        </div>

        {/* Correction Mode Section */}
        <div className="mb-6">
          <h3 className="mb-3 border-b border-gray-700 pb-2 text-base font-semibold text-gray-200">{t("settingsSectionCorrection")}</h3>

          {/* Default Correction Mode */}
          <section className="mb-4">
            <h4 className="mb-2 text-sm font-medium text-gray-300">{t("settingsDefaultCorrectionMode")}</h4>
            <div className="flex gap-3">
              {(["speaking", "writing"] as const).map((m) => (
                <label key={m} className="flex items-center gap-1.5 text-sm text-gray-300 cursor-pointer">
                  <input
                    type="radio"
                    name="defaultCorrectionMode"
                    value={m}
                    checked={defaultCorrectionMode === m}
                    onChange={() => setDefaultCorrectionMode(m)}
                    className="accent-blue-600"
                  />
                  {m === "speaking" ? t("modeSpeaking") : t("modeWriting")}
                </label>
              ))}
            </div>
          </section>

          {/* Default Speaking Use Case */}
          <section className="mb-4">
            <h4 className="mb-2 text-sm font-medium text-gray-300">{t("settingsDefaultSpeakingUseCase")}</h4>
            <select
              value={defaultSpeakingUseCase}
              onChange={(e) => setDefaultSpeakingUseCase(e.target.value)}
              className="w-full rounded-lg border border-gray-600 bg-gray-700 px-2 py-1.5 text-sm text-gray-100 focus:border-blue-400 focus:outline-none"
            >
              {SPEAKING_USE_CASE_KEYS.map((key) => (
                <option key={key} value={key}>{t(USE_CASE_LABEL_KEYS[key] as TranslationKey)}</option>
              ))}
            </select>
          </section>

          {/* Default Writing Use Case */}
          <section>
            <h4 className="mb-2 text-sm font-medium text-gray-300">{t("settingsDefaultWritingUseCase")}</h4>
            <select
              value={defaultWritingUseCase}
              onChange={(e) => setDefaultWritingUseCase(e.target.value)}
              className="w-full rounded-lg border border-gray-600 bg-gray-700 px-2 py-1.5 text-sm text-gray-100 focus:border-blue-400 focus:outline-none"
            >
              {WRITING_USE_CASE_KEYS.map((key) => (
                <option key={key} value={key}>{t(USE_CASE_LABEL_KEYS[key] as TranslationKey)}</option>
              ))}
            </select>
          </section>
        </div>

        {/* Translation Mode Section */}
        <div className="mb-6">
          <h3 className="mb-3 border-b border-gray-700 pb-2 text-base font-semibold text-gray-200">{t("settingsSectionTranslation")}</h3>

          {/* Default Source Language */}
          <section className="mb-4">
            <h4 className="mb-2 text-sm font-medium text-gray-300">{t("settingsDefaultTranslationSource")}</h4>
            <select
              value={defaultTranslationSource}
              onChange={(e) => {
                const next = e.target.value;
                setDefaultTranslationSource(next);
                // Make sure source isn't also a target.
                setDefaultTranslationTargets((prev) => {
                  if (!prev.has(next)) return prev;
                  const updated = new Set(prev);
                  updated.delete(next);
                  return updated;
                });
              }}
              className="w-full rounded-lg border border-gray-600 bg-gray-700 px-2 py-1.5 text-sm text-gray-100 focus:border-blue-400 focus:outline-none"
            >
              {order.map((code) => (
                <option key={code} value={code}>{LANG_LABEL_MAP[code] ?? code}</option>
              ))}
            </select>
          </section>

          {/* Default Target Languages */}
          <section>
            <h4 className="mb-2 text-sm font-medium text-gray-300">{t("settingsDefaultTranslationTargets")}</h4>
            <div className="flex flex-wrap gap-2">
              {order.filter((code) => code !== defaultTranslationSource).map((code) => (
                <label key={code} className="flex items-center gap-1.5 text-sm text-gray-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={defaultTranslationTargets.has(code)}
                    onChange={() => toggleSet(defaultTranslationTargets, code, setDefaultTranslationTargets)}
                    className="accent-blue-600"
                  />
                  {LANG_LABEL_MAP[code] ?? code}
                </label>
              ))}
            </div>
          </section>
        </div>

        {/* Actions */}
        <div className="flex items-center justify-between pt-2">
          <button
            type="button"
            onClick={handleReset}
            className="text-sm text-gray-400 hover:text-gray-200"
          >
            {t("settingsReset")}
          </button>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-gray-600 px-4 py-2 text-sm text-gray-300 hover:bg-gray-700"
            >
              {t("cancel")}
            </button>
            <button
              type="button"
              onClick={handleSave}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-500"
            >
              {t("save")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
