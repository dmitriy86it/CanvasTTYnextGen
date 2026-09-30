import appManifest from "../../../../../package.json";
import type { LocaleId } from "../../../../shared/contracts";
import { t, type TranslationKey } from "../../lib/i18n";

const FAQ: ReadonlyArray<readonly [TranslationKey, TranslationKey]> = [
  ["aboutFaqStatusQuestion", "aboutFaqStatusAnswer"],
  ["aboutFaqDataQuestion", "aboutFaqDataAnswer"],
  ["aboutFaqDisableQuestion", "aboutFaqDisableAnswer"],
  ["aboutFaqProviderTrustQuestion", "aboutFaqProviderTrustAnswer"],
  ["aboutFaqPluginHooksQuestion", "aboutFaqPluginHooksAnswer"]
];

export function AboutSettings({ locale }: { locale: LocaleId }): React.JSX.Element {
  return (
    <section className="about-settings">
      <header className="about-settings__header">
        <span>
          <strong>Raoden Loom</strong>
          <small>v{appManifest.version}</small>
        </span>
        <p>{t(locale, "aboutDescription")}</p>
      </header>

      <div className="about-settings__faq">
        <h3>{t(locale, "aboutFaq")}</h3>
        {FAQ.map(([question, answer]) => (
          <details key={question}>
            <summary>{t(locale, question)}</summary>
            <p>{t(locale, answer)}</p>
          </details>
        ))}
      </div>
    </section>
  );
}
