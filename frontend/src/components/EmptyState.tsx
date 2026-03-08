import { useI18n } from "../i18n/context";

export default function EmptyState() {
  const { t } = useI18n();

  return (
    <div className="flex h-full items-center justify-center">
      <p className="text-lg text-gray-500">{t("noHistory")}</p>
    </div>
  );
}
