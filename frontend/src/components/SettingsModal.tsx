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
import { DEFAULT_SETTINGS, LANG_LABEL_MAP } from "../settings/defaults";
import { uiLanguages, type TranslationKey } from "../i18n/translations";

interface Props {
  onClose: () => void;
  currentLanguageCode?: string;
}

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

const SECTION_LABEL_KEYS: Record<string, string> = {
  vocabulary: "sectionVocabulary",
  "speaking-writing": "sectionSpeakingWriting",
  translation: "sectionTranslation",
  grammar: "sectionGrammar",
};

function SortableSection({ id, label }: { id: string; label: string }) {
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
      <span className="text-sm text-gray-200">{label}</span>
    </div>
  );
}

export default function SettingsModal({ onClose, currentLanguageCode }: Props) {
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
  const [showKoreanHanja, setShowKoreanHanja] = useState<boolean>(settings.showKoreanHanja);
  const [printDefLang, setPrintDefLang] = useState<string>(settings.printDefinitionLanguage);
  const [sectionOrder, setSectionOrder] = useState<string[]>([...(settings.sectionOrder ?? ["vocabulary", "speaking-writing", "translation", "grammar"])]);

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

  function handleSectionDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      setSectionOrder((prev) => {
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
      defaultCorrectionMode,
      defaultSpeakingUseCase,
      defaultWritingUseCase,
      defaultTranslationSourceLanguage: defaultTranslationSource,
      defaultTranslationTargetLanguages:
        targetLangs.length > 0
          ? targetLangs
          : [order.find((c) => c !== defaultTranslationSource) ?? defaultTranslationSource],
      showKoreanHanja,
      printDefinitionLanguage: printDefLang,
      sectionOrder,
    });
    onClose();
  }

  function handleReset() {
    setOrder([...DEFAULT_SETTINGS.languageOrder]);
    setActiveUi(new Set(DEFAULT_SETTINGS.activeUiLanguages));
    setDisplayDefLangs(new Set(DEFAULT_SETTINGS.displayDefinitionLanguages));
    setDisplayExLangs(new Set(DEFAULT_SETTINGS.displayExampleTranslationLanguages));
    setDefaultCorrectionMode(DEFAULT_SETTINGS.defaultCorrectionMode);
    setDefaultSpeakingUseCase(DEFAULT_SETTINGS.defaultSpeakingUseCase);
    setDefaultWritingUseCase(DEFAULT_SETTINGS.defaultWritingUseCase);
    setDefaultTranslationSource(DEFAULT_SETTINGS.defaultTranslationSourceLanguage);
    setDefaultTranslationTargets(new Set(DEFAULT_SETTINGS.defaultTranslationTargetLanguages));
    setShowKoreanHanja(DEFAULT_SETTINGS.showKoreanHanja);
    setPrintDefLang(DEFAULT_SETTINGS.printDefinitionLanguage);
    setSectionOrder([...DEFAULT_SETTINGS.sectionOrder]);
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

          {/* Section Order */}
          <section className="mb-4">
            <h4 className="mb-2 text-sm font-medium text-gray-300">{t("settingsSectionOrder")}</h4>
            <DndContext id="section-order" sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleSectionDragEnd}>
              <SortableContext items={sectionOrder} strategy={verticalListSortingStrategy}>
                <div className="space-y-1.5">
                  {sectionOrder.map((key) => (
                    <SortableSection key={key} id={key} label={t(SECTION_LABEL_KEYS[key] as import("../i18n/translations").TranslationKey)} />
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
              {order.filter((code) => code !== currentLanguageCode).map((code) => (
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
              {order.filter((code) => code !== currentLanguageCode).map((code) => (
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

          {/* Korean Hanja — Chinese only */}
          {currentLanguageCode === "zh" && (
            <section>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={showKoreanHanja}
                  onChange={(e) => setShowKoreanHanja(e.target.checked)}
                  className="accent-blue-600"
                />
                <span className="text-sm font-medium text-gray-300">{t("settingsShowKoreanHanja")}</span>
              </label>
              <p className="mt-1 text-xs text-gray-400">{t("settingsShowKoreanHanjaHelp")}</p>
            </section>
          )}
        </div>

        {/* Print Worksheet Section */}
        <div className="mb-6">
          <h3 className="mb-3 border-b border-gray-700 pb-2 text-base font-semibold text-gray-200">{t("settingsSectionPrint")}</h3>
          <section>
            <h4 className="mb-2 text-sm font-medium text-gray-300">{t("settingsPrintDefLang")}</h4>
            <select
              value={printDefLang}
              onChange={(e) => setPrintDefLang(e.target.value)}
              className="w-full rounded-lg border border-gray-600 bg-gray-700 px-2 py-1.5 text-sm text-gray-100 focus:border-blue-400 focus:outline-none"
            >
              {order.map((code) => (
                <option key={code} value={code}>{LANG_LABEL_MAP[code] ?? code}</option>
              ))}
            </select>
            <p className="mt-1 text-xs text-gray-400">{t("settingsPrintDefLangHelp")}</p>
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
