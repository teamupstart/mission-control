import { expect, type Locator } from "@playwright/test";

/**
 * Every option a `<select>` can display fits inside the room the closed control gives its
 * text, measured rather than asserted from markup.
 *
 * The defect this exists for is invisible to every other layer. `.harnesses-select` is
 * capped at 250px, and `ModelCatalogOptions` composed each row as `label - hint`. Codex's
 * hints are whole sentences it reports from its own model list, so the selected option ran
 * under the chevron and was clipped mid-word - while the markup was well formed and the
 * Claude Code card beside it cleared the cap by a single pixel. Nothing about the JSX or
 * the route says which of those two states you are in; only resolved geometry does.
 *
 * So this measures each option's text in the select's own resolved font and compares it
 * against the control's content box less the room the engine keeps for the chevron.
 */

/**
 * Room the rendering engine keeps at the trailing edge for the dropdown indicator.
 *
 * The indicator is drawn by the widget, not by the box model, so it does not appear in
 * `clientWidth` or in any padding this stylesheet sets - it simply eats the end of the text
 * run. Chromium's is close to 16px; 20px is that plus a margin, so the assertion fires on
 * text that reaches the glyph rather than only on text already clipped by it.
 */
const CHEVRON_ROOM = 20;

interface Overflow {
  text: string;
  width: number;
  room: number;
}

/**
 * Assert that no option in `select` is wider than the closed control can show.
 *
 * The reported offender is the WIDEST one, with its text and both numbers, because "an
 * option in this picker overflows" is not something a person can act on.
 */
export async function expectOptionsFitSelect(select: Locator): Promise<void> {
  await expect(select).toBeVisible();
  const worst = await select.evaluate(
    (element: HTMLSelectElement, chevronRoom: number): Overflow | null => {
      const style = getComputedStyle(element);
      const room =
        element.clientWidth -
        parseFloat(style.paddingLeft) -
        parseFloat(style.paddingRight) -
        chevronRoom;

      // A span rather than a canvas: it inherits the same shaping, letter spacing and font
      // fallback the option itself is laid out with, which `measureText` reproduces only if
      // every one of those is copied across by hand.
      const ruler = document.createElement("span");
      ruler.style.position = "absolute";
      ruler.style.visibility = "hidden";
      ruler.style.whiteSpace = "pre";
      ruler.style.font = style.font;
      ruler.style.fontFamily = style.fontFamily;
      ruler.style.fontSize = style.fontSize;
      ruler.style.fontWeight = style.fontWeight;
      ruler.style.fontStyle = style.fontStyle;
      ruler.style.letterSpacing = style.letterSpacing;
      document.body.append(ruler);

      let offender: Overflow | null = null;
      try {
        for (const option of element.options) {
          ruler.textContent = option.textContent ?? "";
          const width = ruler.getBoundingClientRect().width;
          if (offender === null || width > offender.width) {
            offender = { text: ruler.textContent, width, room };
          }
        }
      } finally {
        ruler.remove();
      }
      return offender;
    },
    CHEVRON_ROOM,
  );

  expect(worst, "the select offered no options at all, so nothing was measured").not.toBeNull();
  // Compared raw, rounded only to report. Layout here is fractional, and rounding each side
  // on its own lets a real overflow compare equal: 100.49px of text and 100.01px of room are
  // both 100. Rounding is a reading aid for the operator, never part of the judgement.
  expect(
    worst!.width,
    `"${worst!.text}" needs ${Math.round(worst!.width)}px of text room and the closed select ` +
      `offers ${Math.round(worst!.room)}px, so it renders through the chevron and clips. A ` +
      `compact picker passes includeHints={false} to ModelCatalogOptions rather than widening ` +
      `its cap - harness hints are free text and no cap survives the next catalog.`,
  ).toBeLessThanOrEqual(worst!.room);
}
