import { useEffect, useState } from "react";
import { useI18n } from "../i18n/context";
import { normalizeGroups, getGroups } from "../api/vocab";
import { ApiError } from "../api/client";
import type { GroupNormalizeResult, WordGroup } from "../types";

interface Props {
  language: string;
  /** Category-A groups in priority order — the same array the list above renders. */
  aGroups: WordGroup[];
  /** True while a reorder is in flight; blocks preview and apply. */
  busy: boolean;
  /** Lets the host modal lock its backdrop and Cancel while a write is running. */
  onBusyChange: (busy: boolean) => void;
  /** Reuses the modal's existing error line rather than adding a second one. */
  onError: (message: string | null) => void;
  /** Receives the FULL post-apply group list (both categories). */
  onApplied: (groups: WordGroup[]) => void;
}

/**
 * The "normalize by priority" action for the word-group manager: press once to
 * preview, again to apply.
 *
 * Lives in its own component so `GroupPickerModal` — which also serves grammar, Group
 * B and the add-to-group mode — takes only a dozen lines for a feature that is
 * word-and-category-A only.
 *
 * The preview is NOT run on mount. A dry run reads every word document of the
 * language (the browse list beside it is paginated to 50), and this modal is also how
 * you rename or delete a group, so an automatic preview would bill a full scan for
 * visits that never intended one. Pressing the button is the intent signal.
 *
 * Any change to the priority order discards the preview, which is the correctness link
 * between the drag list and the button: a stale preview can never be what the user
 * confirms. `expectedGroupIds` closes the same gap across tabs, where no local event
 * would tell us.
 */
export default function GroupNormalizePanel({
  language,
  aGroups,
  busy,
  onBusyChange,
  onError,
  onApplied,
}: Props) {
  const { t } = useI18n();
  const [preview, setPreview] = useState<GroupNormalizeResult | null>(null);
  const [running, setRunning] = useState(false);
  const [applying, setApplying] = useState(false);
  const [done, setDone] = useState<GroupNormalizeResult | null>(null);

  const groupKey = aGroups.map((g) => g.id).join("|");

  useEffect(() => {
    onBusyChange(applying);
  }, [applying, onBusyChange]);

  // Any reorder invalidates both the preview and the armed confirm.
  useEffect(() => {
    setPreview(null);
    setDone(null);
  }, [groupKey]);

  async function handlePress() {
    // First press previews; second applies what the preview showed.
    if (preview === null) {
      setRunning(true);
      onError(null);
      try {
        const result = await normalizeGroups(language, {
          dryRun: true,
          expectedGroupIds: aGroups.map((g) => g.id),
        });
        setPreview(result);
        setDone(null);
      } catch (err) {
        onError(err instanceof Error ? err.message : String(err));
      } finally {
        setRunning(false);
      }
      return;
    }

    setApplying(true);
    onError(null);
    try {
      const result = await normalizeGroups(language, {
        dryRun: false,
        expectedGroupIds: aGroups.map((g) => g.id),
      });
      // Report what actually happened, not what the preview predicted — membership can
      // shift between the two requests.
      setDone(result);
      setPreview(null);
      if (result.groups) onApplied(result.groups);
    } catch (err) {
      setPreview(null);
      if (err instanceof ApiError && err.status === 409) {
        // Someone reordered between preview and apply. Re-read so the next preview is
        // computed against the real order instead of guessing which one won.
        onError(t("normalizeStaleOrder"));
        const groups = await getGroups(language).catch(() => null);
        if (groups) onApplied(groups);
      } else {
        onError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setApplying(false);
    }
  }

  const nothingToDo =
    preview !== null && preview.movedWords === 0 && preview.addedWords === 0;
  const armed = preview !== null && !nothingToDo;
  const disabled = busy || running || applying || nothingToDo;

  return (
    <div className="mb-4 border-t border-gray-700 pt-3">
      <p className="mb-2 text-xs text-gray-500">{t("normalizeGroupsHint")}</p>

      {nothingToDo && <p className="mb-2 text-xs text-gray-400">{t("normalizeNoChanges")}</p>}

      {armed && (
        <ul className="mb-2 space-y-0.5 text-xs text-gray-400">
          {preview.movedWords > 0 && (
            <li>
              <span className="font-semibold tabular-nums text-gray-100">{preview.movedWords}</span>{" "}
              {t("normalizePreviewMoved")}
            </li>
          )}
          {preview.addedWords > 0 && (
            <li>
              <span className="font-semibold tabular-nums text-gray-100">{preview.addedWords}</span>{" "}
              {t("normalizePreviewAdded")}
              <span className="ml-1 text-gray-300">「{preview.topGroup?.name}」</span>
            </li>
          )}
        </ul>
      )}

      {done && (
        <p className="mb-2 text-xs text-green-400">
          {t("normalizeDone")}{" "}
          <span className="tabular-nums text-gray-400">
            {done.movedWords} / {done.addedWords}
          </span>
        </p>
      )}

      <button
        type="button"
        onClick={handlePress}
        disabled={disabled}
        className={`w-full rounded-lg px-3 py-1.5 text-xs disabled:opacity-40 ${
          armed
            ? "bg-red-600 text-white hover:bg-red-500"
            : "border border-gray-600 bg-gray-700 text-gray-200 hover:bg-gray-600"
        }`}
      >
        {running || applying
          ? t("normalizePreviewLoading")
          : armed
            ? t("normalizeConfirm")
            : t("normalizeGroups")}
      </button>
    </div>
  );
}
