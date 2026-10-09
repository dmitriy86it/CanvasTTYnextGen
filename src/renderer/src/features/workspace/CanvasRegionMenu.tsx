import { useEffect, useState } from "react";
import type { LocaleId, Point } from "../../../../shared/contracts";
import { t } from "../../lib/i18n";
import { CanvasMenuLabel } from "../../components/CanvasMenuPrimitives";
import { CANVAS_REGION_COLORS } from "./canvasRegions";

interface CanvasRegionMenuProps {
  mode: "create" | "edit";
  focus: "title" | "color";
  position: Point;
  initialTitle: string;
  initialColor: string;
  locale: LocaleId;
  onSubmit(title: string, color: string): void;
  onClose(): void;
}

export function CanvasRegionMenu({
  mode,
  focus,
  position,
  initialTitle,
  initialColor,
  locale,
  onSubmit,
  onClose
}: CanvasRegionMenuProps): React.JSX.Element {
  const [title, setTitle] = useState(initialTitle);
  const [color, setColor] = useState(initialColor);

  // biome-ignore lint/correctness/useExhaustiveDependencies: mode is the trigger: the form is re-seeded when it opens in another mode
  useEffect(() => {
    setTitle(initialTitle);
    setColor(initialColor);
  }, [initialColor, initialTitle, mode]);

  return (
    <form
      className="canvas-region-editor"
      data-interactive="true"
      style={{ left: position.x, top: position.y }}
      onContextMenu={(event) => event.preventDefault()}
      onSubmit={(event) => {
        event.preventDefault();
        if (title.trim().length === 0) return;
        onSubmit(title.trim(), color);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        onClose();
      }}
    >
      <CanvasMenuLabel>
        {t(locale, mode === "create" ? "createCanvasRegion" : "editCanvasRegion")}
      </CanvasMenuLabel>
      <input
        autoFocus={focus === "title"}
        maxLength={80}
        value={title}
        aria-label={t(locale, "canvasRegionName")}
        placeholder={t(locale, "canvasRegionName")}
        onChange={(event) => setTitle(event.currentTarget.value)}
      />
      <div className="canvas-region-editor__colors" aria-label={t(locale, "canvasRegionColor")}>
        {CANVAS_REGION_COLORS.map((value) => (
          <button
            className={value === color ? "canvas-region-editor__color canvas-region-editor__color--selected" : "canvas-region-editor__color"}
            type="button"
            key={value}
            autoFocus={focus === "color" && value === initialColor}
            style={{ background: value }}
            aria-label={value}
            aria-pressed={value === color}
            onClick={() => setColor(value)}
          />
        ))}
      </div>
      <div className="canvas-region-editor__actions">
        <button type="button" onClick={onClose}>{t(locale, "cancel")}</button>
        <button className="canvas-region-editor__primary" type="submit" disabled={title.trim().length === 0}>
          {t(locale, mode === "create" ? "create" : "save")}
        </button>
      </div>
    </form>
  );
}
