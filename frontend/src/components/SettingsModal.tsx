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
import { uiLanguages } from "../i18n/translations";

interface Props {
  onClose: () => void;
}

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
    updateSettings({
      languageOrder: order,
      activeUiLanguages: order.filter((c) => activeUi.has(c)),
      displayDefinitionLanguages: order.filter((c) => displayDefLangs.has(c)),
      displayExampleTranslationLanguages: order.filter((c) => displayExLangs.has(c)),
    });
    onClose();
  }

  function handleReset() {
    setOrder([...DEFAULT_SETTINGS.languageOrder]);
    setActiveUi(new Set(DEFAULT_SETTINGS.activeUiLanguages));
    setDisplayDefLangs(new Set(DEFAULT_SETTINGS.displayDefinitionLanguages));
    setDisplayExLangs(new Set(DEFAULT_SETTINGS.displayExampleTranslationLanguages));
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
          <section>
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
