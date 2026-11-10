/**
 * Model-facing normalized text only; never load a terminal UI barrel.
 * Grapheme width adapted from @code-yeongyu/senpi-tui 2026.11.5-1 dist/utils.js.
 * Pinned implementation SHA256: 6faf41f3af8c658e8c9d0adbb1777349c87643c3b034f8bb0c9678afcc57c335
 * Upstream license: https://raw.githubusercontent.com/code-yeongyu/senpi/main/LICENSE
 * Verified by Root 2026-11-09; main-license provenance, not tag-specific proof.
 * MIT License
 * Copyright (c) 2025 Mario Zechner (upstream pi-mono)
 * Copyright (c) 2026 Yeongyu Kim and senpi contributors
 * Upstream width logic credits string-width:
 * Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com)
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
 * 
 * The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */
import { eastAsianWidth } from "get-east-asian-width"
import { normalizeRendererText } from "./renderer-text"

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })
function couldBeEmoji(segment: string): boolean {
    const cp = segment.codePointAt(0)!;
    return ((cp >= 0x1f000 && cp <= 0x1fbff) || // Emoji and Pictograph
        (cp >= 0x2300 && cp <= 0x23ff) || // Misc technical
        (cp >= 0x2600 && cp <= 0x27bf) || // Misc symbols, dingbats
        (cp >= 0x2b50 && cp <= 0x2b55) || // Specific stars/circles
        segment.includes("\uFE0F") || // Contains VS16 (emoji presentation selector)
        segment.length > 2 // Multi-codepoint sequences (ZWJ, skin tones, etc.)
    );
}
const zeroWidthRegex = /^(?:\p{Default_Ignorable_Code_Point}|\p{Control}|\p{Mark}|\p{Surrogate})+$/v;
const leadingNonPrintingRegex = /^[\p{Default_Ignorable_Code_Point}\p{Control}\p{Format}\p{Mark}\p{Surrogate}]+/v;
const nonPrintingCharRegex = /^(?:\p{Default_Ignorable_Code_Point}|\p{Control}|\p{Format}|\p{Mark}|\p{Surrogate})$/v;
const markCharRegex = /^\p{Mark}$/v;
// Marks that terminals allocate cells for when attached to a base character.
// This includes Unicode spacing marks and non-spacing exceptions in legacy wcwidth tables.
const terminalSpacingMarkRegex = /^(?:[\p{Spacing_Mark}--[\u1734\u302E\u302F]]|[\u065F\u0F7F\u102B\u102C\u1031\u1033-\u1035\u1038\u103A-\u103E])+$/v;
const rgiEmojiRegex = /^\p{RGI_Emoji}$/v;
function graphemeWidth(segment: string): number {
    if (segment.length === 1) {
        const code = segment.charCodeAt(0);
        if (code >= 0x20 && code <= 0x7e)
            return 1;
        if (code === 0x09)
            return 3;
    }
    // Some marks occupy cells even without a base character.
    if (terminalSpacingMarkRegex.test(segment)) {
        return [...segment].length;
    }
    // Zero-width clusters
    if (zeroWidthRegex.test(segment)) {
        return 0;
    }
    // Emoji check with pre-filter
    if (couldBeEmoji(segment) && rgiEmojiRegex.test(segment)) {
        return 2;
    }
    // Get base visible codepoint
    const base = segment.replace(leadingNonPrintingRegex, "");
    const cp = base.codePointAt(0);
    if (cp === undefined) {
        return 0;
    }
    // Regional indicator symbols (U+1F1E6..U+1F1FF) are often rendered as
    // full-width emoji in terminals, even when isolated during streaming.
    // Keep width conservative (2) to avoid terminal auto-wrap drift artifacts.
    if (cp >= 0x1f1e6 && cp <= 0x1f1ff) {
        return 2;
    }
    let width: number = eastAsianWidth(cp);
    // Intl.Segmenter can group multiple terminal-spacing code points into one
    // grapheme. Count trailing visible code points that terminals may allocate
    // cells for: Indic consonants after marks, halfwidth/fullwidth forms, and
    // Thai/Lao AM vowels.
    let followsMark = false;
    const chars = [...base];
    for (const char of chars.slice(1)) {
        if (terminalSpacingMarkRegex.test(char)) {
            width += 1;
            followsMark = false;
        }
        else if (markCharRegex.test(char)) {
            followsMark = true;
        }
        else if (!nonPrintingCharRegex.test(char)) {
            const c = char.codePointAt(0)!;
            if (followsMark || (c >= 0xff00 && c <= 0xffef)) {
                // halfwidth + fullwidth forms
                width += eastAsianWidth(c);
            }
            else if (c === 0x0e33 || c === 0x0eb3) {
                width += 1;
            }
            followsMark = false;
        }
    }
    return width;
}

/** Same normalization as Native renderer text; only the width engine differs in location. */
export function excerptModelText(value: string, width = 120): string {
  const normalized = normalizeRendererText(value)
  if (width <= 0 || normalized.length === 0) return ""
  const ellipsis = "..."
  const segments = () => graphemeSegmenter.segment(normalized)
  if (ellipsis.length >= width) {
    let measured = 0
    for (const { segment } of segments()) measured += graphemeWidth(segment)
    return measured <= width ? normalized : ellipsis.slice(0, Math.max(0, width))
  }
  // Match the upstream printable-ASCII fast path, including its slice semantics.
  if (/^[\x20-\x7e]*$/u.test(normalized)) {
    return normalized.length <= width ? normalized : normalized.slice(0, width - ellipsis.length) + ellipsis
  }
  const targetWidth = width - ellipsis.length
  let result = "", keptWidth = 0, visibleSoFar = 0, keepContiguousPrefix = true, overflowed = false
  for (const { segment } of segments()) {
    const cells = graphemeWidth(segment)
    if (keepContiguousPrefix && keptWidth + cells <= targetWidth) {
      result += segment
      keptWidth += cells
    } else {
      keepContiguousPrefix = false
    }
    visibleSoFar += cells
    if (visibleSoFar > width) { overflowed = true; break }
  }
  return overflowed ? result + ellipsis : normalized
}
